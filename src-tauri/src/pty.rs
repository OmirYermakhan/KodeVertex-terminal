use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::shell;

/// Размер буфера чтения из PTY.
const READ_BUF: usize = 16 * 1024;
/// Сколько ждать выхода оболочки после SIGHUP, прежде чем добить её SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Сколько после выхода оболочки ждать, пока читатель дочитает вывод.
const DRAIN_GRACE: Duration = Duration::from_millis(150);
/// Как часто читатель проверяет флаг остановки.
#[cfg(unix)]
const READ_POLL: Duration = Duration::from_millis(100);

pub struct SpawnOpts {
  pub cwd: Option<PathBuf>,
  pub cols: u16,
  pub rows: u16,
  /// Каталог интеграции zsh (становится `ZDOTDIR` дочерней оболочки).
  pub zdotdir: PathBuf,
  /// Доп. переменные окружения; перекрывают базовые.
  pub env: Vec<(String, String)>,
}

struct Session {
  master: Box<dyn MasterPty + Send>,
  /// Очередь для потока записи: вызывающий никогда не блокируется на PTY.
  input: Sender<Vec<u8>>,
  #[cfg_attr(unix, allow(dead_code))]
  killer: Box<dyn ChildKiller + Send + Sync>,
  pid: Option<u32>,
  /// Просит поток чтения завершиться (даже если слейв ещё кем-то открыт).
  stop_reading: Arc<AtomicBool>,
  /// Оболочка завершилась и подобрана `wait`: её pid мог достаться другому процессу.
  #[cfg_attr(not(unix), allow(dead_code))]
  exited: Arc<AtomicBool>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

/// Переменная окружения, через которую оболочка получает метку маркеров. Интеграция zsh
/// сразу переносит её в неэкспортируемую переменную и снимает с окружения: команды её не видят.
pub const MARK_ENV: &str = "KODEVERTEX_MARK";

/// Запущенная сессия: id и метка маркеров OSC 133/7.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Spawned {
  pub id: String,
  /// Случайная метка сессии (CSPRNG). Маркеры без неё — чужие (`cat` файла, ssh, программа)
  /// и терминалом игнорируются.
  pub mark: String,
}

/// Новая метка маркеров: 128 бит из CSPRNG ОС (uuid v4 берёт их из getrandom), 32 hex-символа.
fn new_mark() -> String {
  uuid::Uuid::new_v4().simple().to_string()
}

/// Оболочка — zsh: только наша интеграция знает метку. Другой оболочке её не даём —
/// иначе переменная осталась бы в окружении всех команд.
fn is_zsh(shell: &str) -> bool {
  std::path::Path::new(shell).file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains("zsh"))
}

#[derive(Default)]
pub struct PtyManager {
  sessions: Sessions,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

fn no_session(id: &str) -> String {
  format!("нет сессии {id}")
}

impl PtyManager {
  pub fn spawn(
    &self,
    opts: SpawnOpts,
    on_data: impl Fn(Vec<u8>) + Send + 'static,
    on_exit: impl Fn(Option<u32>) + Send + 'static,
  ) -> Result<Spawned, String> {
    let pair = native_pty_system()
      .openpty(PtySize { rows: opts.rows, cols: opts.cols, pixel_width: 0, pixel_height: 0 })
      .map_err(|e| e.to_string())?;

    let login = shell::login_shell(&opts.env);
    let mut cmd = CommandBuilder::new(&login);
    cmd.arg("-l");
    // Служебные переменные Claude Code из окружения приложения оболочке не нужны.
    for (k, _) in std::env::vars_os() {
      if k.to_str().is_some_and(shell::is_claude_service_var) {
        cmd.env_remove(k);
      }
    }
    // Приложение, запущенное из tmux/screen: наша оболочка не внутри них (а с этими
    // переменными интеграция zsh решила бы, что терминал чужой).
    for k in ["TMUX", "TMUX_PANE", "STY"] {
      cmd.env_remove(k);
    }
    let orig_zdotdir = std::env::var("ZDOTDIR").ok();
    for (k, v) in shell::session_env(&opts.zdotdir, orig_zdotdir).into_iter().chain(opts.env) {
      cmd.env(k, v);
    }
    let mark = new_mark();
    // Ставится после opts.env: метку нельзя подменить переопределениями.
    if is_zsh(&login) {
      cmd.env(MARK_ENV, &mark);
    } else {
      cmd.env_remove(MARK_ENV);
    }
    let cwd = opts.cwd.filter(|p| p.is_dir()).or_else(dirs::home_dir);
    if let Some(cwd) = cwd {
      cmd.cwd(cwd);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Слейв нужен только ребёнку: иначе чтение мастера не увидит EOF после выхода.
    drop(pair.slave);

    let reader = PtyReader::new(pair.master.as_ref())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let stop_reading = Arc::new(AtomicBool::new(false));
    let exited = Arc::new(AtomicBool::new(false));
    let (input, input_rx) = mpsc::channel::<Vec<u8>>();
    let (read_done, read_done_rx) = mpsc::channel::<()>();

    lock(&self.sessions).insert(
      id.clone(),
      Session {
        master: pair.master,
        input,
        killer: child.clone_killer(),
        pid: child.process_id(),
        stop_reading: stop_reading.clone(),
        exited: exited.clone(),
      },
    );

    // Поток записи: живёт, пока жива сессия (Sender), и пишет по порядку.
    spawn_thread(format!("pty-write-{id}"), move || {
      let mut writer = writer;
      for chunk in input_rx {
        if writer.write_all(&chunk).and_then(|_| writer.flush()).is_err() {
          break;
        }
      }
    })?;

    let stop = stop_reading.clone();
    spawn_thread(format!("pty-read-{id}"), move || {
      reader.run(&stop, on_data);
      let _ = read_done.send(());
    })?;

    let sessions = self.sessions.clone();
    let wait_id = id.clone();
    spawn_thread(format!("pty-wait-{id}"), move || {
      let code = child.wait().ok().map(|s| s.exit_code());
      exited.store(true, Ordering::SeqCst);
      // Даём читателю дочитать хвост вывода, затем останавливаем его в любом случае:
      // слейв может держать отвязанный потомок, и тогда EOF не придёт никогда.
      let _ = read_done_rx.recv_timeout(DRAIN_GRACE);
      stop_reading.store(true, Ordering::SeqCst);
      // Сессию убираем до события, чтобы после on_exit write уже давал Err.
      lock(&sessions).remove(&wait_id);
      on_exit(code);
    })?;

    Ok(Spawned { id, mark })
  }

  /// Ставит данные в очередь записи; не блокируется, даже если ребёнок не читает ввод.
  pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
    let sessions = lock(&self.sessions);
    let s = sessions.get(id).ok_or_else(|| no_session(id))?;
    s.input.send(data.to_vec()).map_err(|_| no_session(id))
  }

  pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = lock(&self.sessions);
    let s = sessions.get(id).ok_or_else(|| no_session(id))?;
    s.master
      .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
      .map_err(|e| e.to_string())
  }

  /// Закрывает терминал как обычные эмуляторы: SIGHUP группе оболочки и активной
  /// (foreground) группе tty, закрытие мастера, а через `KILL_GRACE` — SIGKILL одной
  /// оболочке, если она ещё жива. Задания с `nohup`/`trap '' HUP` и отвязанные
  /// (`disown`) переживают закрытие. Неизвестная или уже завершённая сессия — не ошибка.
  pub fn kill(&self, id: &str) -> Result<(), String> {
    #[cfg_attr(unix, allow(unused_mut))]
    let Some(mut s) = lock(&self.sessions).remove(id) else { return Ok(()) };
    s.stop_reading.store(true, Ordering::SeqCst);
    #[cfg(unix)]
    if let (Some(pid), false) = (s.pid, s.exited.load(Ordering::SeqCst)) {
      let shell = pid as libc::pid_t;
      let foreground = s.master.as_raw_fd().map(|fd| unsafe { libc::tcgetpgrp(fd) }).unwrap_or(-1);
      unsafe {
        // Оболочка — лидер сессии и своей группы (pgid = pid).
        libc::killpg(shell, libc::SIGHUP);
        if foreground > 0 && foreground != shell {
          libc::killpg(foreground, libc::SIGHUP);
        }
      }
      let exited = s.exited.clone();
      std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        // Пока `wait` не подобрал оболочку, её pid не может достаться другому процессу.
        if !exited.load(Ordering::SeqCst) {
          unsafe { libc::kill(shell, libc::SIGKILL) };
        }
      });
    }
    #[cfg(not(unix))]
    let _ = s.killer.kill();
    // Drop закрывает мастер и очередь записи (поток записи завершится сам).
    drop(s);
    Ok(())
  }

  /// PID оболочки живой сессии.
  #[allow(dead_code)] // нужен тестам; командам пока не требуется
  pub fn pid(&self, id: &str) -> Option<u32> {
    lock(&self.sessions).get(id).and_then(|s| s.pid)
  }
}

fn spawn_thread(name: String, f: impl FnOnce() + Send + 'static) -> Result<(), String> {
  std::thread::Builder::new().name(name).spawn(f).map(|_| ()).map_err(|e| e.to_string())
}

/// Чтение мастера PTY. Байты отдаются как есть, без декодирования.
struct PtyReader {
  #[cfg(unix)]
  file: std::fs::File,
  #[cfg(not(unix))]
  inner: Box<dyn Read + Send>,
}

impl PtyReader {
  #[cfg(unix)]
  fn new(master: &(dyn MasterPty + Send)) -> Result<Self, String> {
    use std::os::fd::{FromRawFd, OwnedFd};
    let fd = master.as_raw_fd().ok_or("нет дескриптора PTY")?;
    // Собственная копия дескриптора: закрывается, когда поток чтения завершится.
    let dup = unsafe { libc::dup(fd) };
    if dup < 0 {
      return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(Self { file: std::fs::File::from(unsafe { OwnedFd::from_raw_fd(dup) }) })
  }

  #[cfg(not(unix))]
  fn new(master: &(dyn MasterPty + Send)) -> Result<Self, String> {
    Ok(Self { inner: master.try_clone_reader().map_err(|e| e.to_string())? })
  }

  #[cfg(unix)]
  fn run(mut self, stop: &AtomicBool, on_data: impl Fn(Vec<u8>)) {
    let mut buf = vec![0u8; READ_BUF];
    while !stop.load(Ordering::SeqCst) {
      match wait_readable(&self.file, READ_POLL) {
        Ok(false) => continue,
        Ok(true) => {}
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
        Err(_) => break,
      }
      match self.file.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => on_data(buf[..n].to_vec()),
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
        Err(_) => break,
      }
    }
  }

  #[cfg(not(unix))]
  fn run(mut self, stop: &AtomicBool, on_data: impl Fn(Vec<u8>)) {
    let mut buf = vec![0u8; READ_BUF];
    while !stop.load(Ordering::SeqCst) {
      match self.inner.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => on_data(buf[..n].to_vec()),
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
        Err(_) => break,
      }
    }
  }
}

/// Ждёт готовности к чтению. `select`, а не `poll`: на macOS `poll` не работает с tty.
#[cfg(unix)]
fn wait_readable(file: &std::fs::File, timeout: Duration) -> std::io::Result<bool> {
  use std::os::fd::AsRawFd;
  let fd = file.as_raw_fd();
  unsafe {
    let mut set: libc::fd_set = std::mem::zeroed();
    libc::FD_ZERO(&mut set);
    libc::FD_SET(fd, &mut set);
    let mut tv = libc::timeval {
      tv_sec: timeout.as_secs() as libc::time_t,
      tv_usec: timeout.subsec_micros() as libc::suseconds_t,
    };
    match libc::select(fd + 1, &mut set, std::ptr::null_mut(), std::ptr::null_mut(), &mut tv) {
      -1 => Err(std::io::Error::last_os_error()),
      0 => Ok(false),
      _ => Ok(true),
    }
  }
}

#[tauri::command(async)]
pub fn pty_spawn(
  app: AppHandle,
  manager: State<'_, PtyManager>,
  cwd: Option<String>,
  cols: u16,
  rows: u16,
  on_data: Channel<InvokeResponseBody>,
  on_exit: Channel<Option<u32>>,
) -> Result<Spawned, String> {
  let opts = SpawnOpts {
    cwd: cwd.map(PathBuf::from),
    cols,
    rows,
    zdotdir: shell::integration_dir(&app),
    env: Vec::new(),
  };
  manager.spawn(
    opts,
    move |bytes| {
      let _ = on_data.send(InvokeResponseBody::Raw(bytes));
    },
    move |code| {
      let _ = on_exit.send(code);
    },
  )
}

#[tauri::command(async)]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
  manager.write(&id, data.as_bytes())
}

#[tauri::command(async)]
pub fn pty_resize(manager: State<'_, PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
  manager.resize(&id, cols, rows)
}

#[tauri::command(async)]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
  manager.kill(&id)
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use std::sync::mpsc;
  use std::sync::Condvar;
  use std::time::{Duration, Instant};

  const OUTPUT_TIMEOUT: Duration = Duration::from_secs(5);
  const EXIT_TIMEOUT: Duration = Duration::from_secs(3);
  const OSC7: &[u8] = b"\x1b]7;file://";

  /// Собирает вывод PTY и позволяет дождаться появления маркера.
  #[derive(Clone, Default)]
  struct Output(Arc<(Mutex<Vec<u8>>, Condvar)>);

  impl Output {
    fn sink(&self) -> impl Fn(Vec<u8>) + Send + 'static {
      let inner = self.0.clone();
      move |bytes| {
        let (buf, cv) = &*inner;
        buf.lock().unwrap().extend_from_slice(&bytes);
        cv.notify_all();
      }
    }

    fn len(&self) -> usize {
      self.0 .0.lock().unwrap().len()
    }

    /// Ждёт `needle` в выводе, начиная с позиции `from`.
    fn wait_for(&self, needle: &[u8], from: usize) -> bool {
      let (buf, cv) = &*self.0;
      let deadline = Instant::now() + OUTPUT_TIMEOUT;
      let mut guard = buf.lock().unwrap();
      loop {
        if guard.len() >= from && guard[from..].windows(needle.len()).any(|w| w == needle) {
          return true;
        }
        let now = Instant::now();
        if now >= deadline {
          return false;
        }
        guard = cv.wait_timeout(guard, deadline - now).unwrap().0;
      }
    }

    /// Ждёт, пока поток чтения отпустит колбэк (значит, он завершился).
    fn wait_reader_done(&self) -> bool {
      let deadline = Instant::now() + OUTPUT_TIMEOUT;
      while Arc::strong_count(&self.0) > 1 {
        if Instant::now() >= deadline {
          return false;
        }
        std::thread::sleep(Duration::from_millis(20));
      }
      true
    }

    /// Ищет `<prefix><число>;` в выводе после `from`.
    fn wait_number(&self, prefix: &str, from: usize) -> Option<u32> {
      let deadline = Instant::now() + OUTPUT_TIMEOUT;
      loop {
        let text = String::from_utf8_lossy(&self.0 .0.lock().unwrap()[from..]).into_owned();
        let found = text.match_indices(prefix).find_map(|(i, _)| {
          let rest = &text[i + prefix.len()..];
          let end = rest.find(';')?;
          rest[..end].parse().ok()
        });
        if found.is_some() || Instant::now() >= deadline {
          return found;
        }
        std::thread::sleep(Duration::from_millis(20));
      }
    }

    fn text(&self) -> String {
      String::from_utf8_lossy(&self.0 .0.lock().unwrap()).into_owned()
    }
  }

  /// Временный HOME с пустым `.zshrc`, чтобы не задеть настоящие файлы пользователя.
  fn temp_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join(".zshrc"), "").unwrap();
    home
  }

  fn opts(home: &std::path::Path, extra: &[(&str, &str)]) -> SpawnOpts {
    let mut env = vec![
      ("SHELL".to_string(), "/bin/zsh".to_string()),
      ("HOME".to_string(), home.to_string_lossy().into_owned()),
      ("KV_ORIG_ZDOTDIR".to_string(), String::new()),
      ("LANG".to_string(), "en_US.UTF-8".to_string()),
    ];
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    SpawnOpts {
      cwd: Some(home.to_path_buf()),
      cols: 80,
      rows: 24,
      zdotdir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("shell/zsh"),
      env,
    }
  }

  /// Сериализует спавн и тесты, меняющие окружение процесса.
  pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

  /// Запускает zsh и ждёт первого приглашения (OSC 7 из precmd).
  /// Возвращает id, вывод, канал выхода и метку маркеров сессии.
  fn start(m: &PtyManager, o: SpawnOpts) -> (String, Output, mpsc::Receiver<Option<u32>>, String) {
    let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    start_unlocked(m, o)
  }

  fn start_unlocked(m: &PtyManager, o: SpawnOpts) -> (String, Output, mpsc::Receiver<Option<u32>>, String) {
    let out = Output::default();
    let (tx, rx) = mpsc::channel();
    let Spawned { id, mark } = m
      .spawn(o, out.sink(), move |code| {
        let _ = tx.send(code);
      })
      .expect("spawn");
    assert!(out.wait_for(OSC7, 0), "нет приглашения zsh, вывод: {:?}", out.text());
    (id, out, rx, mark)
  }

  /// Маркеры OSC 133 подряд в формате интеграции: `ESC ] 133 ; <тело> ; kv=<метка> BEL`.
  fn osc(mark: &str, bodies: &[&str]) -> String {
    bodies.iter().map(|b| format!("\x1b]133;{b};kv={mark}\x07")).collect()
  }

  fn run(m: &PtyManager, id: &str, out: &Output, cmd: &str, expect: &str) {
    let from = out.len();
    m.write(id, cmd.as_bytes()).unwrap();
    assert!(
      out.wait_for(expect.as_bytes(), from),
      "нет {expect:?} после {cmd:?}, вывод: {:?}",
      out.text()
    );
  }

  #[test]
  fn pty_utf8_passthrough() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, _mk) = start(&m, opts(home.path(), &[]));
    // Строка склеивается оболочкой, поэтому в эхе ввода её нет — только в выводе.
    run(&m, &id, &out, "echo \"При\"\"вет 👋\"\n", "Привет 👋");
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_user_zshrc_is_sourced() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshrc"), "alias kvtest='echo KV_OK'\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, _mk) = start(&m, opts(home.path(), &[]));
    run(&m, &id, &out, "kvtest\n", "KV_OK");
    // Без исходного ZDOTDIR после .zlogin переменная снята.
    run(&m, &id, &out, "echo \"ZD=${ZDOTDIR-unset};\"\n", "ZD=unset;");
    // История пишется к пользователю, а не в каталог интеграции.
    #[cfg(target_os = "macos")]
    run(&m, &id, &out, "echo \"HF=$HISTFILE;\"\n", &format!("HF={}/.zsh_history;", home.path().display()));
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_user_zshrc_is_sourced_from_orig_zdotdir() {
    let home = temp_home();
    let zd = home.path().join("zd");
    std::fs::create_dir(&zd).unwrap();
    std::fs::write(zd.join(".zshrc"), "alias kvtest='echo KV_OK'\n").unwrap();
    let zd_str = zd.to_string_lossy().into_owned();
    let m = PtyManager::default();
    let (id, out, _rx, _mk) = start(&m, opts(home.path(), &[("KV_ORIG_ZDOTDIR", &zd_str)]));
    run(&m, &id, &out, "kvtest\n", "KV_OK");
    // После .zlogin у пользователя снова его собственный ZDOTDIR.
    run(&m, &id, &out, "echo \"ZD=$ZDOTDIR;\"\n", &format!("ZD={zd_str};"));
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_emits_osc7() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, _mk) = start(&m, opts(home.path(), &[]));
    assert!(out.wait_for(OSC7, 0));
    m.kill(&id).unwrap();
  }

  #[test]
  fn bracketed_paste_runs_as_one_command() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    // Так строка ввода отправляет команду: табуляция внутри — литерал, а не дополнение.
    // base64("echo a\tb") = ZWNobyBhCWI=
    run(&m, &id, &out, "\x1b[200~echo a\tb\x1b[201~\r", &osc(&mk, &["C;ZWNobyBhCWI="]));
    m.kill(&id).unwrap();
  }

  /// Команда так, как её отправляет строка ввода (`commandBytes`): bracketed paste и ↵.
  fn paste_cmd(cmd: &str) -> String {
    format!("\x1b[200~{cmd}\x1b[201~\r")
  }

  /// Полезная нагрузка 133;C (base64) для команды.
  fn b64(cmd: &str) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for ch in cmd.as_bytes().chunks(3) {
      let n = ch.iter().enumerate().fold(0u32, |a, (i, &b)| a | (b as u32) << (16 - 8 * i));
      for i in 0..4 {
        out.push(if i <= ch.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
      }
    }
    out
  }

  /// Пользовательский rc включает опции, при которых ZLE оставила бы ввод в невидимом буфере.
  #[test]
  fn hist_verify_does_not_glue_commands() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshrc"), "setopt hist_verify\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    let from = out.len();
    m.write(&id, paste_cmd("echo one").as_bytes()).unwrap();
    assert!(out.wait_for(osc(&mk, &["D;0", "A"]).as_bytes(), from), "вывод: {:?}", out.text());
    // `!!` сразу выполняется (без hist_verify раскрытие вернулось бы в буфер ZLE).
    let from = out.len();
    m.write(&id, paste_cmd("!!").as_bytes()).unwrap();
    let want = osc(&mk, &[&format!("C;{}", b64("echo one"))]);
    assert!(out.wait_for(want.as_bytes(), from), "вывод: {:?}", out.text());
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), from), "вывод: {:?}", out.text());
    // Следующая команда не склеивается с остатком.
    let from = out.len();
    m.write(&id, paste_cmd("echo two").as_bytes()).unwrap();
    let want = osc(&mk, &[&format!("C;{}", b64("echo two"))]);
    assert!(out.wait_for(want.as_bytes(), from), "вывод: {:?}", out.text());
    m.kill(&id).unwrap();
  }

  #[test]
  fn correct_option_does_not_ask_invisible_question() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshrc"), "setopt correct correct_all\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    let from = out.len();
    m.write(&id, paste_cmd("ecoh hi").as_bytes()).unwrap();
    let want = osc(&mk, &[&format!("C;{}", b64("ecoh hi"))]);
    assert!(out.wait_for(want.as_bytes(), from), "вывод: {:?}", out.text());
    assert!(!out.text()[from..].contains("[nyae]"), "вывод: {:?}", out.text());
    m.kill(&id).unwrap();
  }

  #[test]
  fn unset_bracketed_paste_is_restored() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshrc"), "unset zle_bracketed_paste\nbindkey -r '^[[200~'\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    run(&m, &id, &out, &paste_cmd("echo a\tb"), &osc(&mk, &["C;ZWNobyBhCWI="]));
    m.kill(&id).unwrap();
  }

  #[test]
  fn line_finish_marker_precedes_command_and_parse_errors() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    let from = out.len();
    m.write(&id, paste_cmd("echo hi").as_bytes()).unwrap();
    assert!(out.wait_for(osc(&mk, &["D;0"]).as_bytes(), from), "вывод: {:?}", out.text());
    let i = find_from(&out, &osc(&mk, &["I"]), from).expect("нет 133;I");
    let c = find_from(&out, "\x1b]133;C;", from).expect("нет 133;C");
    assert!(i < c);
    // Ошибка разбора: команда не запускается (нет C), но вывод идёт после I и до A.
    let from = out.len();
    m.write(&id, paste_cmd("ls )").as_bytes()).unwrap();
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), from), "вывод: {:?}", out.text());
    let i = find_from(&out, &osc(&mk, &["I"]), from).expect("нет 133;I");
    let err = find_from(&out, "parse error", i).expect("нет ошибки разбора после I");
    let a = find_from(&out, &osc(&mk, &["A"]), err).expect("нет 133;A после ошибки");
    assert!(i < err && err < a);
    assert!(find_from(&out, "\x1b]133;C;", from).is_none());
    m.kill(&id).unwrap();
  }

  #[test]
  fn continuation_prompt_emits_marker_and_ctrl_c_resets() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    let from = out.len();
    run(&m, &id, &out, "\x1b[200~echo \"abc\x1b[201~\r", &osc(&mk, &["A;k=s"]));
    // ⌃C сбрасывает незаконченную строку: новое основное приглашение.
    m.write(&id, b"\x03").unwrap();
    let after = out.len();
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), after), "вывод: {:?}", out.text());
    assert!(find_from(&out, "\x1b]133;C;", from).is_none(), "команда не должна была запуститься");
    m.kill(&id).unwrap();
  }

  #[test]
  fn osc7_percent_encodes() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[]));
    run(
      &m,
      &id,
      &out,
      "mkdir -p '100%done/при вет' && cd '100%done/при вет'\n",
      &format!("/100%25done/%D0%BF%D1%80%D0%B8%20%D0%B2%D0%B5%D1%82;kv={mk}\x07"),
    );
    m.kill(&id).unwrap();
  }

  #[test]
  fn osc7_survives_ksh_arrays() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshrc"), "setopt KSH_ARRAYS\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[]));
    run(
      &m,
      &id,
      &out,
      "mkdir -p '100%done/при вет' && cd '100%done/при вет'\n",
      &format!("/100%25done/%D0%BF%D1%80%D0%B8%20%D0%B2%D0%B5%D1%82;kv={mk}\x07"),
    );
    m.kill(&id).unwrap();
  }

  /// Позиция первого вхождения `needle` в выводе после `from`.
  fn find_from(out: &Output, needle: &str, from: usize) -> Option<usize> {
    let bytes = out.0 .0.lock().unwrap().clone();
    bytes[from.min(bytes.len())..]
      .windows(needle.len())
      .position(|w| w == needle.as_bytes())
      .map(|i| i + from)
  }

  #[test]
  fn blocks_mode_emits_osc133() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    let from = out.len();
    m.write(&id, b"echo hi\n").unwrap();
    assert!(out.wait_for(osc(&mk, &["D;0", "A"]).as_bytes(), from), "вывод: {:?}", out.text());
    let c = find_from(&out, &osc(&mk, &["C;ZWNobyBoaQ=="]), from).expect("нет 133;C");
    let hi = find_from(&out, "hi\r\n", c).expect("нет вывода hi");
    let d = find_from(&out, &osc(&mk, &["D;0"]), hi).expect("нет 133;D;0");
    let a = find_from(&out, &osc(&mk, &["A"]), d).expect("нет 133;A");
    assert!(c < hi && hi < d && d < a);
    let from = out.len();
    m.write(&id, b"false\n").unwrap();
    assert!(out.wait_for(osc(&mk, &["D;1"]).as_bytes(), from), "вывод: {:?}", out.text());
    m.kill(&id).unwrap();
  }

  /// Команда строкой ввода; ждёт `want` после неё.
  fn run_pasted(m: &PtyManager, id: &str, out: &Output, cmd: &str, want: &str) -> usize {
    let from = out.len();
    m.write(id, paste_cmd(cmd).as_bytes()).unwrap();
    assert!(out.wait_for(want.as_bytes(), from), "нет {want:?} после {cmd:?}, вывод: {:?}", out.text());
    from
  }

  /// `echo hi` после `exec …` — обычный законченный блок: C, вывод hi, D;0, A.
  fn assert_echo_block(m: &PtyManager, id: &str, out: &Output, mk: &str) {
    let from = run_pasted(m, id, out, "echo hi", &osc(mk, &["D;0", "A"]));
    let c = find_from(out, &osc(mk, &[&format!("C;{}", b64("echo hi"))]), from).expect("нет 133;C");
    let hi = find_from(out, "hi\r\n", c).expect("нет вывода hi");
    let d = find_from(out, &osc(mk, &["D;0"]), hi).expect("нет 133;D;0");
    assert!(c < hi && hi < d, "вывод: {:?}", out.text());
  }

  #[test]
  fn exec_zsh_keeps_integration() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshrc"), "alias kvtest='echo KV_OK'\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    for cmd in ["exec zsh", "exec -l zsh"] {
      // Новая оболочка подписывает приглашение той же меткой; 133;D у `exec` не бывает.
      let from = run_pasted(&m, &id, &out, cmd, &osc(&mk, &[&format!("C;{}", b64(cmd))]));
      let c = find_from(&out, &osc(&mk, &[&format!("C;{}", b64(cmd))]), from).unwrap();
      assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), c), "нет приглашения после {cmd:?}: {:?}", out.text());
      assert!(find_from(&out, "\x1b]133;D;", c).is_none(), "вывод: {:?}", out.text());
      assert_echo_block(&m, &id, &out, &mk);
      // Пользовательский .zshrc прочитан один раз, ZDOTDIR у пользователя прежний.
      run_pasted(&m, &id, &out, "kvtest", "KV_OK");
      run_pasted(&m, &id, &out, "echo \"ZD=${ZDOTDIR-unset};\"", "ZD=unset;");
      #[cfg(target_os = "macos")]
      run_pasted(&m, &id, &out, "echo \"HF=$HISTFILE;\"", &format!("HF={}/.zsh_history;", home.path().display()));
    }
    m.kill(&id).unwrap();
  }

  #[test]
  fn exec_zsh_keeps_user_zdotdir() {
    let home = temp_home();
    let zd = home.path().join("zd");
    std::fs::create_dir(&zd).unwrap();
    // Как часто бывает: ~/.zshenv переносит конфиг в свой ZDOTDIR.
    let zd_str = zd.to_string_lossy().into_owned();
    std::fs::write(home.path().join(".zshenv"), format!("export ZDOTDIR='{zd_str}'\n")).unwrap();
    std::fs::write(zd.join(".zshrc"), "print -r RC_READ\nalias kvtest='echo KV_OK'\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    let from = run_pasted(&m, &id, &out, "exec zsh", &osc(&mk, &[&format!("C;{}", b64("exec zsh"))]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), from + 1));
    assert_echo_block(&m, &id, &out, &mk);
    run_pasted(&m, &id, &out, "kvtest", "KV_OK");
    run_pasted(&m, &id, &out, "echo \"ZD=$ZDOTDIR;\"", &format!("ZD={zd_str};"));
    assert_eq!(out.text().matches("RC_READ").count(), 2, "по разу на запуск: {:?}", out.text());
    m.kill(&id).unwrap();
  }

  #[test]
  fn nested_zsh_signs_markers_and_outer_shell_continues() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    let level = |out: &Output| {
      let from = run_pasted(&m, &id, out, "echo \"L\"\"V=$SHLVL;\"", &osc(&mk, &["D;0", "A"]));
      out.wait_number("LV=", from).expect("нет SHLVL")
    };
    let outer = level(&out);
    let from = run_pasted(&m, &id, &out, "zsh", &osc(&mk, &[&format!("C;{}", b64("zsh"))]));
    // Вложенная оболочка — с интеграцией: подписанное приглашение без 133;D внешней.
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), from + 1), "вывод: {:?}", out.text());
    assert_eq!(level(&out), outer + 1);
    // Выход вложенной: её `exit` заканчивает 133;D внешней, дальше всё как обычно.
    run_pasted(&m, &id, &out, "exit", &osc(&mk, &["D;0", "A"]));
    assert_eq!(level(&out), outer);
    assert_echo_block(&m, &id, &out, &mk);
    m.kill(&id).unwrap();
  }

  #[test]
  fn bash_from_zsh_has_no_markers() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1"), ("BASH_SILENCE_DEPRECATION_WARNING", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    let from = run_pasted(&m, &id, &out, "bash --norc --noprofile", &osc(&mk, &[&format!("C;{}", b64("bash --norc --noprofile"))]));
    run(&m, &id, &out, "echo \"B=$BASH_VERSION\" | cut -c1-2\n", "B=");
    m.write(&id, b"exit\n").unwrap();
    assert!(out.wait_for(osc(&mk, &["D;0", "A"]).as_bytes(), from), "вывод: {:?}", out.text());
    // Внутри bash маркеров не было.
    let c = find_from(&out, "\x1b]133;C;", from).unwrap();
    let d = find_from(&out, &osc(&mk, &["D;0"]), c).unwrap();
    assert!(find_from(&out, "\x1b]133;A", c).is_some_and(|a| a > d), "вывод: {:?}", out.text());
    assert_echo_block(&m, &id, &out, &mk);
    m.kill(&id).unwrap();
  }

  #[test]
  fn foreign_prompt_marker_is_unsigned() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    // Чужой 133;A посреди команды (программа, ssh на хост со своей интеграцией) — без метки:
    // терминал его игнорирует (unmark), блок кончается своим 133;D.
    let from = run_pasted(&m, &id, &out, "printf '\\e]133;A\\a'; echo after", &osc(&mk, &["D;0", "A"]));
    let foreign = find_from(&out, "\x1b]133;A\x07", from).expect("нет чужого маркера");
    let after = find_from(&out, "after\r\n", foreign).expect("нет вывода after");
    let d = find_from(&out, &osc(&mk, &["D;0"]), after).expect("нет 133;D;0");
    assert!(foreign < after && after < d);
    m.kill(&id).unwrap();
  }

  #[test]
  fn scripts_and_foreign_terminals_get_user_zdotdir() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshenv"), "typeset -g ENV_READ=1\n").unwrap();
    std::fs::write(
      home.path().join("s.zsh"),
      "print -r \"NI=${ZDOTDIR-unset};${KODEVERTEX_MARK-unset};${_kv_mark-unset};$ENV_READ;\"\n",
    )
    .unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), 0));
    // Скрипт zsh: .zshenv пользователя прочитан, ZDOTDIR и метка — не наши.
    run_pasted(&m, &id, &out, "zsh s.zsh", "NI=unset;unset;unset;1;");
    // Интерактивный zsh внутри tmux — без интеграции (обычное приглашение, маркеров нет).
    run_pasted(&m, &id, &out, "TMUX=x zsh -i -c 'print -r \"T=${_kv_mark-none};\"'", "T=none;");
    m.kill(&id).unwrap();
  }

  /// Убирает управляющие последовательности: OSC (до BEL или ESC \\), CSI, прочие двухбайтовые ESC.
  fn strip_escapes(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(ch) = it.next() {
      if ch != '\x1b' {
        out.push(ch);
        continue;
      }
      match it.next() {
        Some(']') => {
          while let Some(c) = it.next() {
            if c == '\x07' || (c == '\x1b' && it.peek() == Some(&'\\')) {
              if c == '\x1b' {
                it.next();
              }
              break;
            }
          }
        }
        Some('[') => {
          for c in it.by_ref() {
            if ('\x40'..='\x7e').contains(&c) {
              break;
            }
          }
        }
        _ => {}
      }
    }
    out
  }

  #[test]
  fn strip_escapes_handles_csi_osc_and_two_byte() {
    assert_eq!(strip_escapes("a\x1b[?2004hb\x1b]7;x\x07c\x1b]7;y\x1b\\d\x1bMe\x1b[1m\x1b[7m%"), "abcde%");
  }

  /// Минимальный декодер base64 для проверки полезной нагрузки 133;C.
  fn b64_decode(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
    for c in s.bytes().filter(|&c| c != b'=') {
      acc = (acc << 6) | T.iter().position(|&t| t == c).expect("не base64") as u32;
      bits += 6;
      if bits >= 8 {
        bits -= 8;
        out.push((acc >> bits) as u8);
        acc &= (1 << bits) - 1;
      }
    }
    out
  }

  #[test]
  fn blocks_mode_long_multiline_command_roundtrips() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    let l1 = format!("echo \"{}", "a".repeat(40));
    let l2 = format!("{}\"", "б".repeat(30));
    let from = out.len();
    m.write(&id, format!("{l1}\n{l2}\n").as_bytes()).unwrap();
    assert!(out.wait_for(osc(&mk, &["A"]).as_bytes(), from + 1));
    let text = out.text();
    let start_i = text[from..].find("\x1b]133;C;").expect("нет 133;C") + from + "\x1b]133;C;".len();
    // Нагрузка — до параметра метки `;kv=`.
    let end_i = text[start_i..].find(';').expect("нет метки") + start_i;
    let payload = &text[start_i..end_i];
    assert!(!payload.contains(['\n', '\r']), "перевод строки в нагрузке: {payload:?}");
    assert_eq!(String::from_utf8(b64_decode(payload)).unwrap(), format!("{l1}\n{l2}"));
    m.kill(&id).unwrap();
  }

  #[test]
  fn blocks_mode_hides_prompt() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    let from = out.len();
    m.write(&id, b"echo hi\n").unwrap();
    assert!(out.wait_for(osc(&mk, &["D;0"]).as_bytes(), from));
    assert!(out.wait_for(osc(&mk, &["D;0", "A"]).as_bytes(), from));
    std::thread::sleep(Duration::from_millis(500));
    let text = out.text();
    let tail = &text[text.rfind(&osc(&mk, &["A"])).expect("нет 133;A")..];
    let visible = strip_escapes(tail);
    assert!(!visible.contains(['%', '$', '❯']), "виден prompt: {visible:?}");
    m.kill(&id).unwrap();
  }

  #[test]
  fn session_env_scrubs_claude_vars() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, _mk) = {
      let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
      unsafe { std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1") };
      unsafe { std::env::set_var("CLAUDECODE", "1") };
      let r = start_unlocked(&m, opts(home.path(), &[]));
      unsafe { std::env::remove_var("CLAUDE_CODE_CHILD_SESSION") };
      unsafe { std::env::remove_var("CLAUDECODE") };
      r
    };
    run(&m, &id, &out, "echo \"V=${CLAUDE_CODE_CHILD_SESSION:-none}${CLAUDECODE:-none};\"\n", "V=nonenone;");
    m.kill(&id).unwrap();
  }

  #[test]
  fn mark_reaches_commands_only_while_they_run() {
    let home = temp_home();
    // Пользовательский .zshenv метку в окружении не видит.
    std::fs::write(home.path().join(".zshenv"), "echo \"ZE=${KODEVERTEX_MARK-unset};\"\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx, mk) = start(&m, opts(home.path(), &[("KV_BLOCKS", "1")]));
    assert!(out.text().contains("ZE=unset;"), "вывод: {:?}", out.text());
    // Переменная оболочки с меткой не экспортируется.
    run(&m, &id, &out, "sh -c 'echo \"S=${_kv_mark-unset};\"'\n", "S=unset;");
    // Окружение команды — с меткой: так `exec zsh` и вложенный zsh подписывают свои маркеры.
    run(&m, &id, &out, "sh -c 'echo \"M=$KODEVERTEX_MARK;\"'\n", &format!("M={mk};"));
    // В простое метки в окружении нет: её не получат процессы, запущенные хуками и виджетами.
    run(&m, &id, &out, "print -r \"I=${(t)KODEVERTEX_MARK};\"\n", "I=scalar-export;");
    let from = out.len();
    m.write(&id, b"precmd_functions+=(_t_idle); _t_idle() { print -r \"P=${KODEVERTEX_MARK-unset};\" }\n").unwrap();
    assert!(out.wait_for(b"P=unset;", from), "вывод: {:?}", out.text());
    // Сама оболочка метку знает: маркеры её содержат.
    assert_eq!(mk.len(), 32);
    assert!(mk.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(out.text().contains(&osc(&mk, &["A"])));
    m.kill(&id).unwrap();
  }

  #[test]
  fn each_session_gets_its_own_mark() {
    let home = temp_home();
    let m = PtyManager::default();
    let (a, _out_a, _rx_a, mk_a) = start(&m, opts(home.path(), &[]));
    let (b, _out_b, _rx_b, mk_b) = start(&m, opts(home.path(), &[(MARK_ENV, "подмена")]));
    assert_ne!(mk_a, mk_b);
    assert_ne!(mk_b, "подмена", "переопределение окружения не меняет метку");
    m.kill(&a).unwrap();
    m.kill(&b).unwrap();
  }

  #[test]
  fn mark_only_for_zsh() {
    assert!(is_zsh("/bin/zsh"));
    assert!(is_zsh("/opt/homebrew/bin/zsh"));
    assert!(!is_zsh("/bin/bash"));
    assert!(!is_zsh("/usr/local/bin/fish"));
  }

  #[test]
  fn pty_resize_reaches_child() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx, _mk) = start(&m, opts(home.path(), &[]));
    m.resize(&id, 100, 30).unwrap();
    run(&m, &id, &out, "stty size\n", "30 100");
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_exit_event_and_no_zombie() {
    let home = temp_home();
    let m = PtyManager::default();

    // Выход по `exit`: событие приходит, сессия больше не принимает ввод.
    let (id, _out, rx, _mk) = start(&m, opts(home.path(), &[]));
    m.write(&id, b"exit\n").unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после exit");
    assert!(m.write(&id, b"echo\n").is_err());

    // kill у живой сессии: событие приходит, процесс убран (не зомби).
    let (id, _out, rx, _mk) = start(&m, opts(home.path(), &[]));
    let pid = m.pid(&id).expect("pid");
    m.kill(&id).unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после kill");
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    let errno = std::io::Error::last_os_error().raw_os_error();
    assert_eq!((rc, errno), (-1, Some(libc::ESRCH)), "процесс {pid} всё ещё существует");
    assert!(m.write(&id, b"echo\n").is_err());
  }

  fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
  }

  /// Добивает процесс в конце теста, даже если проверка упала.
  struct KillOnDrop(u32);

  impl Drop for KillOnDrop {
    fn drop(&mut self) {
      unsafe { libc::kill(self.0 as libc::pid_t, libc::SIGKILL) };
    }
  }

  fn wait_dead(pid: u32) -> bool {
    let deadline = Instant::now() + OUTPUT_TIMEOUT;
    while alive(pid) && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(50));
    }
    !alive(pid)
  }

  #[test]
  fn pty_kill_hangs_up_foreground_spares_nohup_jobs_and_releases_reader() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, rx, _mk) = start(&m, opts(home.path(), &[]));
    // Фоновое задание, которое игнорирует SIGHUP и держит слейв открытым.
    let from = out.len();
    m.write(&id, b"(trap '' HUP; exec sleep 300) & echo \"B\"\"G=$!;\"\n").unwrap();
    let bg = out.wait_number("BG=", from).unwrap_or_else(|| panic!("нет pid, вывод: {:?}", out.text()));
    let _bg_guard = KillOnDrop(bg);
    // Обычная программа на переднем плане.
    let from = out.len();
    m.write(&id, b"sh -c 'echo \"F\"\"G=$$;\"; exec sleep 300'\n").unwrap();
    let fg = out.wait_number("FG=", from).unwrap_or_else(|| panic!("нет pid, вывод: {:?}", out.text()));
    let _fg_guard = KillOnDrop(fg);
    assert!(alive(bg) && alive(fg));

    m.kill(&id).unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после kill");
    assert!(wait_dead(fg), "процесс переднего плана {fg} пережил kill");
    assert!(out.wait_reader_done(), "поток чтения не завершился");
    // После окна SIGKILL задание, игнорирующее SIGHUP, всё ещё живо.
    std::thread::sleep(KILL_GRACE + Duration::from_millis(300));
    assert!(alive(bg), "задание {bg} с trap '' HUP не пережило закрытие");
  }

  #[test]
  fn pty_kill_unknown_or_finished_session_is_ok() {
    let m = PtyManager::default();
    assert!(m.kill("нет-такой").is_ok());

    let home = temp_home();
    let (id, _out, rx, _mk) = start(&m, opts(home.path(), &[]));
    m.write(&id, b"exit\n").unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после exit");
    assert!(m.kill(&id).is_ok(), "kill после обычного exit должен быть no-op");
    // Повторный kill уже убитой сессии — тоже не ошибка.
    let (id, _out, rx, _mk) = start(&m, opts(home.path(), &[]));
    m.kill(&id).unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после kill");
    assert!(m.kill(&id).is_ok());
  }

  #[test]
  fn pty_reader_released_after_exit_with_disowned_job() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, rx, _mk) = start(&m, opts(home.path(), &[]));
    // Отвязанное задание держит слейв, поэтому EOF на мастере после exit не придёт.
    let from = out.len();
    m.write(&id, b"(trap '' HUP; exec sleep 300) &! echo \"B\"\"G=$!;\"\n").unwrap();
    let bg = out.wait_number("BG=", from).unwrap_or_else(|| panic!("нет pid, вывод: {:?}", out.text()));
    m.write(&id, b"exit\n").unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после exit");
    let reader_done = out.wait_reader_done();
    unsafe { libc::kill(bg as libc::pid_t, libc::SIGKILL) };
    assert!(reader_done, "поток чтения не завершился");
  }
}
