use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::shell;

/// Размер буфера чтения из PTY.
const READ_BUF: usize = 16 * 1024;
/// Сколько ждать выхода после SIGHUP, прежде чем добить SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(2);

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
  /// Отдельный замок, чтобы долгая запись не блокировала весь менеджер.
  writer: Arc<Mutex<Box<dyn Write + Send>>>,
  killer: Box<dyn ChildKiller + Send + Sync>,
  pid: Option<u32>,
  exited: Arc<AtomicBool>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

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
  ) -> Result<String, String> {
    let pair = native_pty_system()
      .openpty(PtySize { rows: opts.rows, cols: opts.cols, pixel_width: 0, pixel_height: 0 })
      .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(shell::login_shell(&opts.env));
    cmd.arg("-l");
    let orig_zdotdir = std::env::var("ZDOTDIR").ok();
    for (k, v) in shell::session_env(&opts.zdotdir, orig_zdotdir).into_iter().chain(opts.env) {
      cmd.env(k, v);
    }
    let cwd = opts.cwd.filter(|p| p.is_dir()).or_else(dirs::home_dir);
    if let Some(cwd) = cwd {
      cmd.cwd(cwd);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Слейв нужен только ребёнку: иначе чтение мастера не увидит EOF после выхода.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let exited = Arc::new(AtomicBool::new(false));

    lock(&self.sessions).insert(
      id.clone(),
      Session {
        master: pair.master,
        writer: Arc::new(Mutex::new(writer)),
        killer: child.clone_killer(),
        pid: child.process_id(),
        exited: exited.clone(),
      },
    );

    std::thread::Builder::new()
      .name(format!("pty-read-{id}"))
      .spawn(move || read_loop(reader, on_data))
      .map_err(|e| e.to_string())?;

    let sessions = self.sessions.clone();
    let wait_id = id.clone();
    std::thread::Builder::new()
      .name(format!("pty-wait-{id}"))
      .spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        exited.store(true, Ordering::SeqCst);
        // Сессию убираем до события, чтобы после on_exit write уже давал Err.
        lock(&sessions).remove(&wait_id);
        on_exit(code);
      })
      .map_err(|e| e.to_string())?;

    Ok(id)
  }

  pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
    let writer = lock(&self.sessions).get(id).map(|s| s.writer.clone()).ok_or_else(|| no_session(id))?;
    let mut w = lock(&writer);
    w.write_all(data).and_then(|_| w.flush()).map_err(|e| e.to_string())
  }

  pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = lock(&self.sessions);
    let s = sessions.get(id).ok_or_else(|| no_session(id))?;
    s.master
      .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
      .map_err(|e| e.to_string())
  }

  /// Шлёт оболочке SIGHUP и закрывает мастер; если процесс не вышел за
  /// `KILL_GRACE`, добивает SIGKILL. Ожидающий поток затем соберёт статус.
  pub fn kill(&self, id: &str) -> Result<(), String> {
    let mut s = lock(&self.sessions).remove(id).ok_or_else(|| no_session(id))?;
    let _ = s.killer.kill();
    let (pid, exited) = (s.pid, s.exited.clone());
    drop(s);
    if let Some(pid) = pid {
      std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        if !exited.load(Ordering::SeqCst) {
          // Процесс ещё не собран ожидающим потоком, значит pid всё ещё его.
          unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        }
      });
    }
    Ok(())
  }

  /// PID оболочки живой сессии.
  #[allow(dead_code)] // нужен тестам; командам пока не требуется
  pub fn pid(&self, id: &str) -> Option<u32> {
    lock(&self.sessions).get(id).and_then(|s| s.pid)
  }
}

/// Читает PTY и отдаёт байты как есть, без декодирования.
fn read_loop(mut reader: Box<dyn Read + Send>, on_data: impl Fn(Vec<u8>)) {
  let mut buf = vec![0u8; READ_BUF];
  loop {
    match reader.read(&mut buf) {
      Ok(0) => break,
      Ok(n) => on_data(buf[..n].to_vec()),
      Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
      Err(_) => break,
    }
  }
}

#[tauri::command]
pub fn pty_spawn(
  app: AppHandle,
  manager: State<'_, PtyManager>,
  cwd: Option<String>,
  cols: u16,
  rows: u16,
  on_data: Channel<InvokeResponseBody>,
  on_exit: Channel<Option<u32>>,
) -> Result<String, String> {
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

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
  manager.write(&id, data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(manager: State<'_, PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
  manager.resize(&id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
  manager.kill(&id)
}

#[cfg(test)]
mod tests {
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

  /// Запускает zsh и ждёт первого приглашения (OSC 7 из precmd).
  fn start(m: &PtyManager, o: SpawnOpts) -> (String, Output, mpsc::Receiver<Option<u32>>) {
    let out = Output::default();
    let (tx, rx) = mpsc::channel();
    let id = m
      .spawn(o, out.sink(), move |code| {
        let _ = tx.send(code);
      })
      .expect("spawn");
    assert!(out.wait_for(OSC7, 0), "нет приглашения zsh, вывод: {:?}", out.text());
    (id, out, rx)
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
    let (id, out, _rx) = start(&m, opts(home.path(), &[]));
    run(&m, &id, &out, "echo \"Привет 👋\"\n", "Привет 👋");
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_user_zshrc_is_sourced() {
    let home = temp_home();
    std::fs::write(home.path().join(".zshrc"), "alias kvtest='echo KV_OK'\n").unwrap();
    let m = PtyManager::default();
    let (id, out, _rx) = start(&m, opts(home.path(), &[]));
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
    let (id, out, _rx) = start(&m, opts(home.path(), &[("KV_ORIG_ZDOTDIR", &zd_str)]));
    run(&m, &id, &out, "kvtest\n", "KV_OK");
    // После .zlogin у пользователя снова его собственный ZDOTDIR.
    run(&m, &id, &out, "echo \"ZD=$ZDOTDIR;\"\n", &format!("ZD={zd_str};"));
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_emits_osc7() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx) = start(&m, opts(home.path(), &[]));
    assert!(out.wait_for(OSC7, 0));
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_resize_reaches_child() {
    let home = temp_home();
    let m = PtyManager::default();
    let (id, out, _rx) = start(&m, opts(home.path(), &[]));
    m.resize(&id, 100, 30).unwrap();
    run(&m, &id, &out, "stty size\n", "30 100");
    m.kill(&id).unwrap();
  }

  #[test]
  fn pty_exit_event_and_no_zombie() {
    let home = temp_home();
    let m = PtyManager::default();

    // Выход по `exit`: событие приходит, сессия больше не принимает ввод.
    let (id, _out, rx) = start(&m, opts(home.path(), &[]));
    m.write(&id, b"exit\n").unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после exit");
    assert!(m.write(&id, b"echo\n").is_err());

    // kill у живой сессии: событие приходит, процесс убран (не зомби).
    let (id, _out, rx) = start(&m, opts(home.path(), &[]));
    let pid = m.pid(&id).expect("pid");
    m.kill(&id).unwrap();
    rx.recv_timeout(EXIT_TIMEOUT).expect("on_exit после kill");
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    let errno = std::io::Error::last_os_error().raw_os_error();
    assert_eq!((rc, errno), (-1, Some(libc::ESRCH)), "процесс {pid} всё ещё существует");
    assert!(m.write(&id, b"echo\n").is_err());
  }
}
