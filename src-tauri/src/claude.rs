use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::shell;

/// Сколько последних байт stderr отдаём в `on_exit`.
const STDERR_TAIL: usize = 4096;
/// Через сколько после SIGTERM добиваем процесс SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Сколько после выхода процесса ждать, пока читатели дочитают вывод.
const DRAIN_GRACE: Duration = Duration::from_millis(500);
/// Как часто при выходе из приложения проверяем, все ли процессы завершились.
const WAIT_POLL: Duration = Duration::from_millis(20);

const NOT_FOUND: &str = "Claude Code не найден. Установите: npm i -g @anthropic-ai/claude-code";
/// Сколько ждать login-оболочку, которая ищет `claude` в PATH пользователя.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// Сколько при выходе из приложения ждать, пока процессы `claude` завершатся по SIGTERM.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(1000);

/// Состояние процесса под замком: сигнал шлётся только пока процесс не подобран (`reaped`) —
/// иначе его pid (и id группы) мог бы уже достаться другому процессу.
#[derive(Default)]
struct Proc {
  /// Процесс подобран `wait`.
  reaped: bool,
  /// Попросили остановиться (SIGTERM отправлен).
  stopping: bool,
}

type LineSink = Box<dyn Fn(String) + Send>;
type ExitSink = Box<dyn Fn(Option<i32>, String) + Send>;

/// Связь процесса с окном: заменяемые колбэки и окно-владелец. Пока процесс отсоединён
/// (вкладка переезжает в другое окно), строки stdout копятся в `queue` — процесс не блокируется,
/// а выход запоминается в `exit`; `attach` отдаёт всё по порядку: строки, затем выход.
struct Link {
  owner: Option<String>,
  on_line: Option<LineSink>,
  on_exit: Option<ExitSink>,
  queue: Vec<String>,
  exit: Option<(Option<i32>, String)>,
  /// Номер отсоединения: таймер сироты останавливает процесс, только если с тех пор его не подключали.
  generation: u64,
}

impl Link {
  fn line(&mut self, line: String) {
    match &self.on_line {
      Some(f) => f(line),
      None => self.queue.push(line),
    }
  }

  fn exited(&mut self, code: Option<i32>, stderr: String) {
    match &self.on_exit {
      Some(f) => f(code, stderr),
      None => self.exit = Some((code, stderr)),
    }
  }
}

type SharedLink = Arc<Mutex<Link>>;

/// Сколько отсоединённый процесс ждёт нового окна, прежде чем его остановят (перенос потерялся).
pub const ORPHAN_TIMEOUT: Duration = Duration::from_secs(30);

struct Session {
  pid: u32,
  proc_: Arc<Mutex<Proc>>,
  stdin: Arc<Mutex<ChildStdin>>,
  link: SharedLink,
}

#[derive(Default, Clone)]
pub struct ClaudeManager {
  sessions: Arc<Mutex<HashMap<String, Session>>>,
  /// Отсоединённые процессы (в том числе уже вышедшие — их выход ждёт `attach`).
  detached: Arc<Mutex<HashMap<String, SharedLink>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

fn no_session(id: &str) -> String {
  format!("нет сессии {id}")
}

/// Оставляет в буфере только последние `STDERR_TAIL` байт.
fn trim_tail(buf: &mut Vec<u8>) {
  if buf.len() > STDERR_TAIL {
    buf.drain(..buf.len() - STDERR_TAIL);
  }
}

/// Уровни усилия, которые принимает `claude --effort`.
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Режимы разрешений, которые приложение передаёт `claude --permission-mode`.
pub const PERMISSION_MODES: [&str; 3] = ["default", "acceptEdits", "bypassPermissions"];
/// Режим по умолчанию: правки файлов без вопросов, команды и сеть — с разрешения пользователя.
pub const DEFAULT_PERMISSION_MODE: &str = "acceptEdits";

/// Режим из настроек: только из списка; нет, пусто или неизвестно — `acceptEdits`.
pub fn permission_mode(m: Option<&str>) -> &'static str {
  m.and_then(|m| PERMISSION_MODES.iter().find(|&&k| k == m)).copied().unwrap_or(DEFAULT_PERMISSION_MODE)
}

/// Параметры запуска процесса `claude`: продолжение сессии, модель, усилие и режим разрешений.
#[derive(Default, Clone, Debug)]
pub struct Launch {
  pub resume: Option<String>,
  /// Псевдоним (`opus`, `fable`, `default`) или полное имя модели.
  pub model: Option<String>,
  pub effort: Option<String>,
  /// `default` | `acceptEdits` | `bypassPermissions` (см. `permission_mode`).
  pub permission_mode: Option<String>,
  /// PATH login-оболочки пользователя: у приложения из Dock PATH системный, и `#!/usr/bin/env node`
  /// у claude из npm не нашёл бы node. None — PATH приложения как есть.
  pub path_env: Option<String>,
  /// Правка отправленного сообщения: продолжить сессию `resume` с сообщения `uuid` (включительно),
  /// всё после него отбрасывается (`--resume-session-at`, только вместе с `--resume`).
  pub resume_at: Option<String>,
  /// `--fork-session`: продолжение — в новой сессии, файл исходной остаётся как был.
  pub fork: bool,
  /// `--prompt-suggestions true`: после хода claude присылает `prompt_suggestion` — вероятную
  /// следующую реплику пользователя (короткий дополнительный запрос к модели). Нет — флаг не
  /// передаётся (в режиме -p подсказки выключены).
  pub prompt_suggestions: bool,
  /// `--append-system-prompt DIAGRAMS_HINT`: просит claude рисовать схемы блоками ```mermaid
  /// (лента показывает их картинкой). Нет — флаг не передаётся.
  pub diagrams_hint: bool,
  /// Окно-владелец (метка): его перезагрузка или закрытие останавливает процесс.
  pub owner: Option<String>,
}

/// Подсказка claude про схемы: терминал рисует блоки ```mermaid картинкой.
pub const DIAGRAMS_HINT: &str = "This terminal renders ```mermaid code blocks as diagrams. When a diagram genuinely helps explain something (architecture, flow, relationships, steps, timelines, simple charts), draw it as a mermaid block instead of ASCII art. Do not add diagrams when they don't help.";

/// Аргументы `claude` после обязательных: `--permission-mode`, `--model`, `--effort`, `--resume`
/// (с ним — `--resume-session-at`, `--fork-session`). Пустые значения, значения с `-` в начале
/// и неизвестное усилие пропускаются; неизвестный режим — `acceptEdits`. В конце — `--prompt-suggestions true`,
/// если подсказки включены, и `--append-system-prompt` с подсказкой про схемы, если она включена.
pub fn launch_args(l: &Launch) -> Vec<String> {
  let mut a = vec!["--permission-mode".to_string(), permission_mode(l.permission_mode.as_deref()).to_string()];
  if let Some(m) = l.model.as_deref().map(str::trim).filter(|m| !m.is_empty() && !m.starts_with('-')) {
    a.extend(["--model".to_string(), m.to_string()]);
  }
  if let Some(e) = l.effort.as_deref().filter(|e| EFFORTS.contains(e)) {
    a.extend(["--effort".to_string(), e.to_string()]);
  }
  let ok = |v: &&str| !v.is_empty() && !v.starts_with('-');
  if let Some(r) = l.resume.as_deref().filter(ok) {
    a.extend(["--resume".to_string(), r.to_string()]);
    // Точка перемотки и ответвление имеют смысл только у продолжаемой сессии.
    if let Some(u) = l.resume_at.as_deref().filter(ok) {
      a.extend(["--resume-session-at".to_string(), u.to_string()]);
    }
    if l.fork {
      a.push("--fork-session".to_string());
    }
  }
  if l.prompt_suggestions {
    a.extend(["--prompt-suggestions".to_string(), "true".to_string()]);
  }
  if l.diagrams_hint {
    a.extend(["--append-system-prompt".to_string(), DIAGRAMS_HINT.to_string()]);
  }
  a
}

/// Управляющий запрос протокола stream-json одной строкой (с `\n`).
pub fn control_line(request_id: &str, request: &serde_json::Value) -> String {
  let mut line = serde_json::json!({ "type": "control_request", "request_id": request_id, "request": request }).to_string();
  line.push('\n');
  line
}

/// Ответ на управляющий запрос `claude` (например, `can_use_tool`) одной строкой (с `\n`).
pub fn control_response_line(request_id: &str, response: &serde_json::Value) -> String {
  let mut line = serde_json::json!({
    "type": "control_response",
    "response": { "subtype": "success", "request_id": request_id, "response": response }
  })
  .to_string();
  line.push('\n');
  line
}

impl ClaudeManager {
  pub fn start(
    &self,
    program: &Path,
    cwd: &Path,
    launch: Launch,
    on_line: impl Fn(String) + Send + 'static,
    on_exit: impl Fn(Option<i32>, String) + Send + 'static,
  ) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Запросы разрешений (вопросы AskUserQuestion) — управляющими запросами в stdout.
      "--permission-prompt-tool",
      "stdio",
      // Режим из настроек меняется на лету (`set_permission_mode`), в том числе на bypassPermissions —
      // CLI разрешает это только процессу с этим флагом. Сам флаг режим не включает.
      "--allow-dangerously-skip-permissions",
    ]);
    cmd.args(launch_args(&launch));
    // Служебные переменные Claude Code из окружения приложения процессу не нужны.
    for (k, _) in std::env::vars_os() {
      if k.to_str().is_some_and(shell::is_claude_service_var) {
        cmd.env_remove(k);
      }
    }
    // Режим разрешений (`--permission-mode`) — в launch_args, из настроек.
    // С bypassPermissions запуск «где-то ещё» (например, в `/` у приложения из Dock) недопустим.
    if !cwd.is_dir() {
      return Err(format!("Каталог {} не существует", cwd.display()));
    }
    if let Some(path) = launch.path_env.as_deref().filter(|p| !p.is_empty()) {
      cmd.env("PATH", path);
    }
    cmd.current_dir(cwd);
    // Своя группа процессов: сигналы остановки и прерывания доходят и до инструментов claude.
    cmd.process_group(0);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("не удалось запустить {}: {e}", program.display()))?;
    let stdin = child.stdin.take().ok_or("нет stdin")?;
    let stdout = child.stdout.take().ok_or("нет stdout")?;
    let mut stderr = child.stderr.take().ok_or("нет stderr")?;

    let id = uuid::Uuid::new_v4().to_string();
    let pid = child.id();
    let proc_ = Arc::new(Mutex::new(Proc::default()));
    let link = Arc::new(Mutex::new(Link {
      owner: launch.owner.clone(),
      on_line: Some(Box::new(on_line)),
      on_exit: Some(Box::new(on_exit)),
      queue: Vec::new(),
      exit: None,
      generation: 0,
    }));
    lock(&self.sessions)
      .insert(id.clone(), Session { pid, proc_: proc_.clone(), stdin: Arc::new(Mutex::new(stdin)), link: link.clone() });

    let (out_done, out_done_rx) = mpsc::channel::<()>();
    let (err_done, err_done_rx) = mpsc::channel::<Vec<u8>>();
    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));

    let out_link = link.clone();
    spawn_thread(format!("claude-out-{id}"), move || {
      let mut reader = BufReader::new(stdout);
      let mut buf = Vec::new();
      loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
          Ok(0) | Err(_) => break,
          Ok(_) => {
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim_end_matches(['\n', '\r']);
            if !line.trim().is_empty() {
              lock(&out_link).line(line.to_string());
            }
          }
        }
      }
      let _ = out_done.send(());
    })?;

    let tail_w = tail.clone();
    spawn_thread(format!("claude-err-{id}"), move || {
      let mut chunk = [0u8; 4096];
      loop {
        match stderr.read(&mut chunk) {
          Ok(0) | Err(_) => break,
          Ok(n) => {
            let mut t = lock(&tail_w);
            t.extend_from_slice(&chunk[..n]);
            trim_tail(&mut t);
          }
        }
      }
      let _ = err_done.send(Vec::new());
    })?;

    let sessions = self.sessions.clone();
    let wait_id = id.clone();
    spawn_thread(format!("claude-wait-{id}"), move || {
      let mut child = child;
      // Блокирующее ожидание выхода без опроса; WNOWAIT — процесс ещё не подобран, pid занят.
      wait_exited(pid);
      let code = {
        let mut st = lock(&proc_);
        // Остановленная сессия: потомки (инструменты) не должны пережить claude. Лидер группы
        // ещё не подобран — id группы не переиспользован.
        if st.stopping {
          kill_group(pid, libc::SIGKILL);
        }
        let code = child.wait().ok().and_then(|s| s.code());
        st.reaped = true;
        code
      };
      // Сессию убираем до события, чтобы после on_exit send уже давал Err.
      lock(&sessions).remove(&wait_id);
      // Даём читателям дочитать хвост (потомок мог унаследовать пайпы и держать их).
      let _ = out_done_rx.recv_timeout(DRAIN_GRACE);
      let _ = err_done_rx.recv_timeout(DRAIN_GRACE);
      let text = String::from_utf8_lossy(&lock(&tail)).into_owned();
      // Отсоединён — выход ждёт `attach` (после накопленных строк).
      lock(&link).exited(code, text);
    })?;

    Ok(id)
  }

  /// Пишет текстовое сообщение пользователя в stdin процесса одной JSON-строкой.
  #[cfg(test)]
  pub fn send(&self, id: &str, text: &str) -> Result<(), String> {
    self.send_content(id, vec![serde_json::json!({ "type": "text", "text": text })])
  }

  /// Сообщение пользователя из готовых блоков (текст, image, document — см. attach::build_content).
  pub fn send_content(&self, id: &str, content: Vec<serde_json::Value>) -> Result<(), String> {
    let msg = serde_json::json!({
      "type": "user",
      "message": { "role": "user", "content": content }
    });
    let mut line = msg.to_string();
    line.push('\n');
    self.write_line(id, &line)
  }

  /// Управляющий запрос (`set_model`, `apply_flag_settings`, `get_settings`); ответ придёт строкой
  /// `control_response` с тем же `request_id`.
  pub fn control(&self, id: &str, request_id: &str, request: &serde_json::Value) -> Result<(), String> {
    if !request.get("subtype").is_some_and(|s| s.is_string()) {
      return Err("управляющий запрос без subtype".into());
    }
    self.write_line(id, &control_line(request_id, request))
  }

  /// Ответ на управляющий запрос процесса (`can_use_tool`: разрешение, ответы на вопросы).
  pub fn respond(&self, id: &str, request_id: &str, response: &serde_json::Value) -> Result<(), String> {
    if request_id.is_empty() {
      return Err("пустой request_id".into());
    }
    self.write_line(id, &control_response_line(request_id, response))
  }

  fn write_line(&self, id: &str, line: &str) -> Result<(), String> {
    let stdin = lock(&self.sessions).get(id).map(|s| s.stdin.clone()).ok_or_else(|| no_session(id))?;
    let mut w = lock(&stdin);
    w.write_all(line.as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())
  }

  /// SIGINT группе процесса `claude` (прерывает текущий ход и запущенные им команды).
  pub fn interrupt(&self, id: &str) -> Result<(), String> {
    let (pid, proc_) = lock(&self.sessions).get(id).map(|s| (s.pid, s.proc_.clone())).ok_or_else(|| no_session(id))?;
    let st = lock(&proc_);
    if st.reaped {
      return Err(no_session(id));
    }
    // Под замком состояния: пока процесс не подобран, его pid не переиспользован.
    signal(pid, libc::SIGINT)
  }

  /// Просит процесс завершиться (SIGTERM), через `KILL_GRACE` — SIGKILL (отдельный поток-таймер).
  /// Неизвестная или уже завершённая сессия — не ошибка.
  pub fn stop(&self, id: &str) -> Result<(), String> {
    // Отсоединённый процесс (даже вышедший) больше никто не подключит.
    lock(&self.detached).remove(id);
    let Some((pid, proc_)) = lock(&self.sessions).get(id).map(|s| (s.pid, s.proc_.clone())) else {
      return Ok(());
    };
    stop_proc(pid, &proc_);
    Ok(())
  }

  /// Остановить все сессии (выход из приложения, перезагрузка страницы): SIGTERM, через
  /// `SHUTDOWN_GRACE` оставшимся — SIGKILL вместе с потомками. Только сессии, бывшие на момент
  /// вызова: запущенные после (новой страницей) не трогаются.
  pub fn stop_all(&self) {
    lock(&self.detached).clear();
    self.stop_where(|_| true);
  }

  /// Остановить процессы окна `owner` (его страница перезагрузилась или окно закрыто) — как
  /// `stop_all`, но только его. Отсоединённые (владельца нет) не трогаются.
  pub fn stop_owner(&self, owner: &str) {
    self.stop_where(|l| l.owner.as_deref() == Some(owner));
  }

  fn stop_where(&self, pick: impl Fn(&Link) -> bool) {
    let procs: Vec<(u32, Arc<Mutex<Proc>>)> =
      lock(&self.sessions).values().filter(|s| pick(&lock(&s.link))).map(|s| (s.pid, s.proc_.clone())).collect();
    for (pid, p) in &procs {
      stop_proc(*pid, p);
    }
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while procs.iter().any(|(_, p)| !lock(p).reaped) && Instant::now() < deadline {
      std::thread::sleep(WAIT_POLL);
    }
    for (pid, p) in &procs {
      let st = lock(p);
      // Под замком: процесс ещё не подобран потоком ожидания, id группы не переиспользован.
      if !st.reaped {
        kill_group(*pid, libc::SIGKILL);
      }
    }
  }
}

impl ClaudeManager {
  /// Отсоединить процесс от окна (вкладка переезжает): строки копятся, владельца нет.
  /// Возвращает номер отсоединения для `expire_orphan`.
  pub fn detach(&self, id: &str) -> Result<u64, String> {
    let link = lock(&self.sessions).get(id).map(|s| s.link.clone()).ok_or_else(|| no_session(id))?;
    let generation = {
      let mut l = lock(&link);
      l.on_line = None;
      l.on_exit = None;
      l.owner = None;
      l.generation += 1;
      l.generation
    };
    lock(&self.detached).insert(id.to_string(), link);
    Ok(generation)
  }

  /// Подключить отсоединённый процесс к окну `owner`: сначала накопленные строки по порядку,
  /// затем живые; выход, случившийся без окна, — после строк. Неизвестный id — ошибка.
  pub fn attach(
    &self,
    id: &str,
    owner: Option<String>,
    on_line: impl Fn(String) + Send + 'static,
    on_exit: impl Fn(Option<i32>, String) + Send + 'static,
  ) -> Result<(), String> {
    let link = lock(&self.detached)
      .remove(id)
      .or_else(|| lock(&self.sessions).get(id).map(|s| s.link.clone()))
      .ok_or_else(|| no_session(id))?;
    // Под замком связи: читатель stdout ждёт, пока очередь не отдана и колбэк не поставлен.
    let mut l = lock(&link);
    for line in std::mem::take(&mut l.queue) {
      on_line(line);
    }
    l.owner = owner;
    l.on_line = Some(Box::new(on_line));
    if let Some((code, stderr)) = l.exit.take() {
      on_exit(code, stderr);
    }
    l.on_exit = Some(Box::new(on_exit));
    Ok(())
  }

  /// Таймер сироты: процесс так и не подключён с отсоединения `generation` — остановить.
  /// true — остановлен.
  pub fn expire_orphan(&self, id: &str, generation: u64) -> bool {
    let stale = lock(&self.detached).get(id).is_some_and(|l| {
      let l = lock(l);
      l.generation == generation && l.on_line.is_none()
    });
    if stale {
      log::warn!("отсоединённый claude {id} не подключён за {ORPHAN_TIMEOUT:?}: останавливаем");
      let _ = self.stop(id);
    }
    stale
  }
}

/// SIGTERM группе процесса и таймер на SIGKILL через `KILL_GRACE` (если к тому времени не завершился).
fn stop_proc(pid: u32, proc_: &Arc<Mutex<Proc>>) {
  let mut st = lock(proc_);
  if st.reaped {
    return;
  }
  if !st.stopping {
    st.stopping = true;
    let p = proc_.clone();
    let _ = spawn_thread(format!("claude-kill-{pid}"), move || {
      std::thread::sleep(KILL_GRACE);
      if !lock(&p).reaped {
        kill_group(pid, libc::SIGKILL);
      }
    });
  }
  let _ = signal(pid, libc::SIGTERM);
}

/// Ждёт завершения процесса, не подбирая его (WNOWAIT): pid остаётся занятым, пока `wait` не
/// вызван явно. Ошибка (процесса нет) — сразу возврат.
fn wait_exited(pid: u32) {
  loop {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
    if r == 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
      return;
    }
  }
}

/// Сигнал группе процесса `claude` (группу он возглавляет: `process_group(0)`).
fn signal(pid: u32, sig: libc::c_int) -> Result<(), String> {
  if unsafe { libc::killpg(pid as libc::pid_t, sig) } == 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error().to_string())
  }
}

fn kill_group(pid: u32, sig: libc::c_int) {
  unsafe { libc::killpg(pid as libc::pid_t, sig) };
}

fn spawn_thread(name: String, f: impl FnOnce() + Send + 'static) -> Result<(), String> {
  std::thread::Builder::new().name(name).spawn(f).map(|_| ()).map_err(|e| e.to_string())
}

/// Найденный `claude` и PATH login-оболочки (его получает процесс `claude`).
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
  pub program: PathBuf,
  pub path_env: Option<String>,
}

static CLAUDE_PATH: OnceLock<Resolved> = OnceLock::new();

/// Метки строк с путём к claude и PATH в выводе оболочки (rc-файлы могут печатать что угодно).
/// К каждой добавляется случайный для запуска суффикс: rc-файл не угадает метку заранее.
const PATH_MARK: &str = "__KODEVERTEX_PATH_";
const CLAUDE_MARK: &str = "__KODEVERTEX_CLAUDE_";

/// Суффикс меток одного запуска оболочки.
fn mark_nonce() -> String {
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
  format!("{:x}{:x}__=", std::process::id(), nanos)
}

/// Значение последней строки с меткой `mark` (печатается после rc-файлов).
fn marked<'a>(out: &'a str, mark: &str) -> Option<&'a str> {
  out.lines().rev().find_map(|l| l.strip_prefix(mark))
}

/// Ищет `claude` в PATH login-оболочки (приложение из Dock не видит PATH пользователя) и
/// запоминает сам PATH. Успешный результат кэшируется.
pub fn resolve_claude() -> Result<Resolved, String> {
  if let Some(p) = CLAUDE_PATH.get() {
    return Ok(p.clone());
  }
  let sh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
  let r = find_in_login_shell(Path::new(&sh), RESOLVE_TIMEOUT)?;
  Ok(CLAUDE_PATH.get_or_init(|| r).clone())
}

/// `command -v claude` и `$PATH` в login-оболочке `sh` (POSIX: работает и не в zsh). Алиас
/// снимаем: нужен путь к файлу. Оболочка, не ответившая за `timeout`, убивается вместе с потомками.
fn find_in_login_shell(sh: &Path, timeout: Duration) -> Result<Resolved, String> {
  let nonce = mark_nonce();
  let (claude_mark, path_mark) = (format!("{CLAUDE_MARK}{nonce}"), format!("{PATH_MARK}{nonce}"));
  let script = format!(
    "unalias claude 2>/dev/null; __kv_p=$(command -v claude); printf '\\n%s%s\\n%s%s\\n' '{claude_mark}' \"$__kv_p\" '{path_mark}' \"$PATH\""
  );
  let mut child = Command::new(sh)
    .args(["-lic", &script])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .process_group(0)
    .spawn()
    .map_err(|_| NOT_FOUND.to_string())?;
  let mut stdout = child.stdout.take().ok_or_else(|| NOT_FOUND.to_string())?;
  let (tx, rx) = mpsc::channel();
  spawn_thread("claude-resolve".into(), move || {
    let mut buf = Vec::new();
    let _ = stdout.read_to_end(&mut buf);
    let _ = tx.send(buf);
  })?;
  let deadline = Instant::now() + timeout;
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(WAIT_POLL),
      _ => {
        kill_group(child.id(), libc::SIGKILL);
        let _ = child.wait();
        return Err(format!(
          "Не удалось найти Claude Code: оболочка {} не ответила за {} с (проверьте ~/.zshrc)",
          sh.display(),
          timeout.as_secs()
        ));
      }
    }
  }
  // Потомок оболочки мог унаследовать stdout — не ждём его дольше короткого окна.
  let out = rx.recv_timeout(DRAIN_GRACE).unwrap_or_default();
  let stdout = String::from_utf8_lossy(&out);
  // rc-файлы могут печатать лишнее: путь берём только из строки с меткой этого запуска.
  let program = marked(&stdout, &claude_mark)
    .filter(|l| l.starts_with('/') && Path::new(l).is_file())
    .map(PathBuf::from)
    .ok_or_else(|| NOT_FOUND.to_string())?;
  let path_env = marked(&stdout, &path_mark).map(str::to_string).filter(|p| !p.is_empty());
  Ok(Resolved { program, path_env })
}

#[derive(Serialize, Clone)]
pub struct ClaudeExit {
  pub code: Option<i32>,
  pub stderr: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // параметры команды — поля JSON от фронта
pub async fn claude_start(
  app: tauri::AppHandle,
  window: tauri::WebviewWindow,
  manager: State<'_, ClaudeManager>,
  cwd: String,
  resume: Option<String>,
  model: Option<String>,
  effort: Option<String>,
  permission_mode: Option<String>,
  resume_at: Option<String>,
  fork: Option<bool>,
  prompt_suggestions: Option<bool>,
  diagrams_hint: Option<bool>,
  on_line: Channel<String>,
  on_exit: Channel<ClaudeExit>,
) -> Result<String, String> {
  // Недоверенная папка — `Err("UNTRUSTED_DIR")` до запуска: `-p` пропускает диалог доверия CLI,
  // и хуки из `.claude/settings.json` чужого репозитория выполнились бы без согласия.
  // Возобновление и ответвление (`resume`/`fork`) идут этим же путём.
  let dir = PathBuf::from(&cwd);
  crate::blocking(move || crate::claude_trust::ensure(&app, &dir)).await??;
  let Resolved { program, path_env } = tauri::async_runtime::spawn_blocking(resolve_claude).await.map_err(|e| e.to_string())??;
  manager.start(
    &program,
    Path::new(&cwd),
    Launch {
      path_env,
      resume,
      model,
      effort,
      permission_mode,
      resume_at,
      fork: fork.unwrap_or(false),
      prompt_suggestions: prompt_suggestions.unwrap_or(false),
      diagrams_hint: diagrams_hint.unwrap_or(false),
      owner: Some(window.label().to_string()),
    },
    move |line| {
      let _ = on_line.send(line);
    },
    move |code, stderr| {
      let _ = on_exit.send(ClaudeExit { code, stderr });
    },
  )
}

/// Отсоединить процесс claude от окна (вкладка переезжает). Не подключённый за `ORPHAN_TIMEOUT`
/// — останавливается.
#[tauri::command]
pub fn claude_detach(manager: State<'_, ClaudeManager>, id: String) -> Result<(), String> {
  let generation = manager.detach(&id)?;
  let m = manager.inner().clone();
  std::thread::spawn(move || {
    std::thread::sleep(ORPHAN_TIMEOUT);
    m.expire_orphan(&id, generation);
  });
  Ok(())
}

/// Подключить отсоединённый процесс claude к окну вызова с новыми каналами.
#[tauri::command]
pub fn claude_attach(
  window: tauri::WebviewWindow,
  manager: State<'_, ClaudeManager>,
  id: String,
  on_line: Channel<String>,
  on_exit: Channel<ClaudeExit>,
) -> Result<(), String> {
  manager.attach(
    &id,
    Some(window.label().to_string()),
    move |line| {
      let _ = on_line.send(line);
    },
    move |code, stderr| {
      let _ = on_exit.send(ClaudeExit { code, stderr });
    },
  )
}

#[tauri::command]
pub async fn claude_send(
  manager: State<'_, ClaudeManager>,
  id: String,
  text: String,
  files: Option<Vec<crate::attach::SendFile>>,
) -> Result<Vec<String>, String> {
  // Чтение и base64 вложений, запись в пайп (может блокироваться, если claude не читает stdin) —
  // не в async-потоке.
  let m = manager.inner().clone();
  tauri::async_runtime::spawn_blocking(move || {
    let (content, skipped) = crate::attach::build_content(&text, files.as_deref().unwrap_or(&[]))?;
    m.send_content(&id, content)?;
    // Не приложенные файлы (пропали) — заметкой в ленте; сообщение ушло без них.
    Ok(skipped)
  })
  .await
  .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_control(
  manager: State<'_, ClaudeManager>,
  id: String,
  request_id: String,
  request: serde_json::Value,
) -> Result<(), String> {
  let m = manager.inner().clone();
  tauri::async_runtime::spawn_blocking(move || m.control(&id, &request_id, &request)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_respond(
  manager: State<'_, ClaudeManager>,
  id: String,
  request_id: String,
  response: serde_json::Value,
) -> Result<(), String> {
  let m = manager.inner().clone();
  tauri::async_runtime::spawn_blocking(move || m.respond(&id, &request_id, &response)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_interrupt(manager: State<'_, ClaudeManager>, id: String) -> Result<(), String> {
  manager.interrupt(&id)
}

#[tauri::command]
pub async fn claude_stop(manager: State<'_, ClaudeManager>, id: String) -> Result<(), String> {
  manager.stop(&id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc;
  use std::time::Duration;

  const WAIT: Duration = Duration::from_secs(10);

  fn fake() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-claude.sh")
  }

  fn fixture_lines() -> Vec<String> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/claude/fixtures/bash-ls.jsonl");
    std::fs::read_to_string(p).unwrap().lines().filter(|l| !l.trim().is_empty()).map(String::from).collect()
  }

  type Exit = (Option<i32>, String);

  fn start(m: &ClaudeManager, program: &Path) -> Result<(String, mpsc::Receiver<String>, mpsc::Receiver<Exit>), String> {
    let (ltx, lrx) = mpsc::channel();
    let (etx, erx) = mpsc::channel();
    let id = m.start(
      program,
      Path::new("/"),
      Launch::default(),
      move |l| {
        let _ = ltx.send(l);
      },
      move |c, e| {
        let _ = etx.send((c, e));
      },
    )?;
    Ok((id, lrx, erx))
  }

  fn script(body: &str) -> (tempfile::TempDir, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("claude.sh");
    std::fs::write(&p, format!("#!/bin/bash\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, p)
  }

  fn take(rx: &mpsc::Receiver<String>, n: usize) -> Vec<String> {
    (0..n).map(|_| rx.recv_timeout(WAIT).expect("строка")).collect()
  }

  #[test]
  fn all_fixture_lines_arrive_in_order() {
    let m = ClaudeManager::default();
    let (id, lrx, _erx) = start(&m, &fake()).unwrap();
    assert_eq!(take(&lrx, 38), fixture_lines());
    m.stop(&id).unwrap();
  }

  #[test]
  fn send_echoes_valid_json_with_cyrillic_and_quotes() {
    let m = ClaudeManager::default();
    let (id, lrx, _erx) = start(&m, &fake()).unwrap();
    take(&lrx, 38);
    let text = "Привет, \"мир\"\nвторая строка \\ слеш";
    m.send(&id, text).unwrap();
    let echo: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    assert_eq!(echo["type"], "echo");
    let line = &echo["line"];
    assert_eq!(line["type"], "user");
    assert_eq!(line["message"]["role"], "user");
    assert_eq!(line["message"]["content"][0]["type"], "text");
    assert_eq!(line["message"]["content"][0]["text"], text);
    m.stop(&id).unwrap();
  }

  #[test]
  fn send_content_writes_text_and_image_blocks() {
    let d = tempfile::tempdir().unwrap();
    let img = d.path().join("s.png");
    image::RgbaImage::from_pixel(3, 3, image::Rgba([1, 2, 3, 255])).save(&img).unwrap();
    let files = vec![crate::attach::SendFile { kind: "image".into(), path: img.to_string_lossy().into() }];
    let (content, _) = crate::attach::build_content("вот [Изображение 1]", &files).unwrap();
    let m = ClaudeManager::default();
    let (id, lrx, _erx) = start(&m, &fake()).unwrap();
    take(&lrx, 38);
    m.send_content(&id, content).unwrap();
    let echo: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    let c = &echo["line"]["message"]["content"];
    assert_eq!(c[0]["text"], "вот [Изображение 1]");
    assert_eq!(c[1]["type"], "image");
    assert_eq!(c[1]["source"]["type"], "base64");
    m.stop(&id).unwrap();
  }

  #[test]
  fn stop_calls_on_exit_and_removes_session() {
    let m = ClaudeManager::default();
    let (id, lrx, erx) = start(&m, &fake()).unwrap();
    take(&lrx, 38);
    m.stop(&id).unwrap();
    erx.recv_timeout(WAIT).expect("on_exit");
    assert!(m.send(&id, "x").is_err());
  }

  /// SIGTERM игнорируется — через KILL_GRACE таймер добивает SIGKILL; ожидание выхода без опроса.
  #[test]
  fn stop_escalates_to_sigkill_after_grace() {
    let (_d, p) = script("trap '' TERM\necho '{\"ready\":1}'\nwhile :; do sleep 0.05; done");
    let m = ClaudeManager::default();
    let (id, lrx, erx) = start(&m, &p).unwrap();
    take(&lrx, 1);
    let t = Instant::now();
    m.stop(&id).unwrap();
    // Повторный stop не заводит второй таймер и не ошибка.
    m.stop(&id).unwrap();
    let (code, _) = erx.recv_timeout(WAIT).expect("on_exit");
    assert_eq!(code, None, "убит сигналом");
    assert!(t.elapsed() >= KILL_GRACE - Duration::from_millis(100), "{:?}", t.elapsed());
    assert!(t.elapsed() < KILL_GRACE + Duration::from_secs(2), "{:?}", t.elapsed());
    assert!(m.interrupt(&id).is_err());
  }

  #[test]
  fn missing_program_is_error() {
    let m = ClaudeManager::default();
    assert!(start(&m, Path::new("/nonexistent/claude-nope")).is_err());
  }

  #[test]
  fn crash_reports_code_and_stderr() {
    let (_d, p) = script("echo 'что-то сломалось' >&2\nexit 3");
    let m = ClaudeManager::default();
    let (_id, _lrx, erx) = start(&m, &p).unwrap();
    let (code, err) = erx.recv_timeout(WAIT).unwrap();
    assert_eq!(code, Some(3));
    assert!(err.contains("что-то сломалось"), "{err}");
  }

  #[test]
  fn stderr_tail_is_limited_to_4k() {
    let (_d, p) = script("head -c 20000 /dev/zero | tr '\\0' 'a' >&2\necho END >&2\nexit 1");
    let m = ClaudeManager::default();
    let (_id, _lrx, erx) = start(&m, &p).unwrap();
    let (_, err) = erx.recv_timeout(WAIT).unwrap();
    assert!(err.len() <= 4096, "{}", err.len());
    assert!(err.trim_end().ends_with("END"));
  }

  #[test]
  fn args_include_stream_json_and_resume() {
    let (_d, p) = script("printf '{\"args\":\"%s\"}\\n' \"$*\"");
    let m = ClaudeManager::default();
    let (ltx, lrx) = mpsc::channel();
    m.start(&p, Path::new("/"), Launch { resume: Some("abc-123".into()), model: Some("fable".into()), effort: Some("high".into()), permission_mode: Some("default".into()), prompt_suggestions: true, ..Launch::default() }, move |l| {
      let _ = ltx.send(l);
    }, |_, _| {})
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    let a = v["args"].as_str().unwrap();
    assert_eq!(
      a,
      "-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --allow-dangerously-skip-permissions --permission-mode default --model fable --effort high --resume abc-123 --prompt-suggestions true"
    );
  }

  #[test]
  fn launch_args_skip_empty_and_unknown() {
    assert_eq!(launch_args(&Launch::default()), ["--permission-mode", "acceptEdits"]);
    let l = Launch { resume: Some(String::new()), model: Some("--evil".into()), effort: Some("huge".into()), permission_mode: None, ..Launch::default() };
    assert_eq!(launch_args(&l), ["--permission-mode", "acceptEdits"]);
    let l = Launch { resume: None, model: Some("default".into()), effort: Some("max".into()), permission_mode: None, ..Launch::default() };
    assert_eq!(launch_args(&l), ["--permission-mode", "acceptEdits", "--model", "default", "--effort", "max"]);
  }

  #[test]
  fn launch_args_reject_resume_that_looks_like_flag() {
    let l = Launch { resume: Some("--dangerously-skip-permissions".into()), ..Launch::default() };
    assert_eq!(launch_args(&l), ["--permission-mode", "acceptEdits"]);
    let l = Launch { resume: Some("-p".into()), ..Launch::default() };
    assert!(!launch_args(&l).contains(&"--resume".to_string()));
    let l = Launch { resume: Some("abc-123".into()), ..Launch::default() };
    assert_eq!(launch_args(&l)[2..], ["--resume", "abc-123"]);
  }

  #[test]
  fn launch_args_rewind_and_fork_only_with_resume() {
    let l = Launch { resume: Some("s-1".into()), resume_at: Some("u-9".into()), fork: true, ..Launch::default() };
    assert_eq!(launch_args(&l)[2..], ["--resume", "s-1", "--resume-session-at", "u-9", "--fork-session"]);
    // Без --resume точки перемотки и ответвления нет: новая сессия.
    let l = Launch { resume: None, resume_at: Some("u-9".into()), fork: true, ..Launch::default() };
    assert_eq!(launch_args(&l), ["--permission-mode", "acceptEdits"]);
    // Значение, похожее на флаг, или пустое — пропускается; --fork-session остаётся.
    let l = Launch { resume: Some("s-1".into()), resume_at: Some("--dangerously-skip-permissions".into()), fork: true, ..Launch::default() };
    assert_eq!(launch_args(&l)[2..], ["--resume", "s-1", "--fork-session"]);
    let l = Launch { resume: Some("s-1".into()), resume_at: Some(String::new()), fork: false, ..Launch::default() };
    assert_eq!(launch_args(&l)[2..], ["--resume", "s-1"]);
    // Модель, усилие и режим при перезапуске сохраняются.
    let l = Launch { resume: Some("s-1".into()), resume_at: Some("u-9".into()), fork: true, model: Some("fable".into()), effort: Some("high".into()), permission_mode: Some("default".into()), prompt_suggestions: false, diagrams_hint: false, path_env: None, owner: None };
    assert_eq!(launch_args(&l), ["--permission-mode", "default", "--model", "fable", "--effort", "high", "--resume", "s-1", "--resume-session-at", "u-9", "--fork-session"]);
  }

  #[test]
  fn prompt_suggestions_flag_only_when_on() {
    assert!(!launch_args(&Launch::default()).contains(&"--prompt-suggestions".to_string()));
    let l = Launch { prompt_suggestions: true, ..Launch::default() };
    assert_eq!(launch_args(&l), ["--permission-mode", "acceptEdits", "--prompt-suggestions", "true"]);
    // С продолжением сессии флаг — последним, после --resume и точки перемотки.
    let l = Launch { resume: Some("s-1".into()), resume_at: Some("u-9".into()), fork: true, prompt_suggestions: true, ..Launch::default() };
    assert_eq!(launch_args(&l)[2..], ["--resume", "s-1", "--resume-session-at", "u-9", "--fork-session", "--prompt-suggestions", "true"]);
  }

  #[test]
  fn diagrams_hint_flag_only_when_on() {
    assert!(!launch_args(&Launch::default()).contains(&"--append-system-prompt".to_string()));
    let l = Launch { diagrams_hint: true, ..Launch::default() };
    assert_eq!(launch_args(&l), ["--permission-mode", "acceptEdits", "--append-system-prompt", DIAGRAMS_HINT]);
    // После --prompt-suggestions true подсказка идёт последней.
    let l = Launch { prompt_suggestions: true, diagrams_hint: true, ..Launch::default() };
    assert_eq!(launch_args(&l)[2..], ["--prompt-suggestions", "true", "--append-system-prompt", DIAGRAMS_HINT]);
  }

  #[test]
  fn permission_mode_is_whitelisted() {
    assert_eq!(permission_mode(None), "acceptEdits");
    assert_eq!(permission_mode(Some("")), "acceptEdits");
    assert_eq!(permission_mode(Some("plan")), "acceptEdits");
    assert_eq!(permission_mode(Some("BypassPermissions")), "acceptEdits");
    assert_eq!(permission_mode(Some("--dangerously-skip-permissions")), "acceptEdits");
    for m in PERMISSION_MODES {
      assert_eq!(permission_mode(Some(m)), m);
    }
  }

  #[test]
  fn launch_args_carry_chosen_mode() {
    for m in PERMISSION_MODES {
      let l = Launch { permission_mode: Some(m.into()), ..Launch::default() };
      assert_eq!(launch_args(&l), ["--permission-mode", m]);
    }
    let l = Launch { permission_mode: Some("yolo".into()), ..Launch::default() };
    assert_eq!(launch_args(&l), ["--permission-mode", "acceptEdits"]);
  }

  #[test]
  fn control_line_has_protocol_shape() {
    let req = serde_json::json!({ "subtype": "set_model", "model": "fable" });
    let line = control_line("kv-1", &req);
    assert!(line.ends_with('\n') && !line[..line.len() - 1].contains('\n'));
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "control_request", "request_id": "kv-1", "request": req }));
  }

  #[test]
  fn respond_writes_control_response() {
    let m = ClaudeManager::default();
    let (id, lrx, _erx) = start(&m, &fake()).unwrap();
    take(&lrx, 38);
    let resp = serde_json::json!({ "behavior": "allow", "updatedInput": { "answers": { "Цвет?": "Синий" } } });
    m.respond(&id, "req-1", &resp).unwrap();
    let echo: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    assert_eq!(
      echo["line"],
      serde_json::json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "req-1", "response": resp } })
    );
    assert!(m.respond(&id, "", &resp).is_err());
    m.stop(&id).unwrap();
  }

  #[test]
  fn control_writes_request_to_stdin() {
    let m = ClaudeManager::default();
    let (id, lrx, _erx) = start(&m, &fake()).unwrap();
    take(&lrx, 38);
    let req = serde_json::json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": "high" } });
    m.control(&id, "r7", &req).unwrap();
    let echo: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    assert_eq!(echo["line"]["type"], "control_request");
    assert_eq!(echo["line"]["request_id"], "r7");
    assert_eq!(echo["line"]["request"], req);
    assert!(m.control(&id, "r8", &serde_json::json!({ "model": "x" })).is_err());
    assert!(m.control("nope", "r9", &req).is_err());
    m.stop(&id).unwrap();
  }

  #[test]
  fn interrupt_sends_sigint() {
    let (_d, p) = script("trap 'echo \"{\\\"got\\\":\\\"int\\\"}\"; exit 0' INT\necho '{\"ready\":1}'\nwhile true; do sleep 0.05; done");
    let m = ClaudeManager::default();
    let (id, lrx, erx) = start(&m, &p).unwrap();
    take(&lrx, 1);
    m.interrupt(&id).unwrap();
    assert!(lrx.recv_timeout(WAIT).unwrap().contains("int"));
    assert_eq!(erx.recv_timeout(WAIT).unwrap().0, Some(0));
  }

  #[test]
  fn missing_cwd_is_error_not_fallback() {
    let m = ClaudeManager::default();
    let err = m.start(&fake(), Path::new("/nonexistent/kv-dir"), Launch::default(), |_| {}, |_, _| {}).unwrap_err();
    assert!(err.contains("не существует"), "{err}");
    assert!(lock(&m.sessions).is_empty());
  }

  #[test]
  fn starts_in_given_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let (_d, p) = script("printf '{\"cwd\":\"%s\"}\\n' \"$PWD\"");
    let m = ClaudeManager::default();
    let (ltx, lrx) = mpsc::channel();
    m.start(&p, dir.path(), Launch::default(), move |l| {
      let _ = ltx.send(l);
    }, |_, _| {})
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    let want = dir.path().canonicalize().unwrap();
    assert_eq!(Path::new(v["cwd"].as_str().unwrap()).canonicalize().unwrap(), want);
  }

  fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
  }

  fn wait_dead(pid: u32) -> bool {
    let deadline = std::time::Instant::now() + WAIT;
    while alive(pid) && std::time::Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(20));
    }
    !alive(pid)
  }

  struct KillOnDrop(u32);
  impl Drop for KillOnDrop {
    fn drop(&mut self) {
      unsafe { libc::kill(self.0 as libc::pid_t, libc::SIGKILL) };
    }
  }

  /// Скрипт запускает «инструмент» (sleep) в фоне и сообщает его pid.
  const WITH_TOOL: &str = "sleep 300 &\necho \"{\\\"tool\\\":$!}\"\nwhile true; do sleep 0.05; done";

  fn tool_pid(lrx: &mpsc::Receiver<String>) -> u32 {
    let v: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    v["tool"].as_u64().unwrap() as u32
  }

  #[test]
  fn stop_kills_tool_children() {
    let (_d, p) = script(WITH_TOOL);
    let m = ClaudeManager::default();
    let (id, lrx, erx) = start(&m, &p).unwrap();
    let tool = tool_pid(&lrx);
    let _g = KillOnDrop(tool);
    assert!(alive(tool));
    m.stop(&id).unwrap();
    erx.recv_timeout(WAIT).expect("on_exit");
    assert!(wait_dead(tool), "инструмент {tool} пережил остановку claude");
  }

  #[test]
  fn interrupt_reaches_tool_children() {
    // Инструмент на переднем плане ловит SIGINT и сообщает об этом.
    let (_d, p) = script(
      "echo '{\"ready\":1}'\nsh -c 'trap \"echo {\\\"tool\\\":\\\"int\\\"}; exit 0\" INT; while :; do sleep 0.05; done'\nexit 0",
    );
    let m = ClaudeManager::default();
    let (id, lrx, _erx) = start(&m, &p).unwrap();
    take(&lrx, 1);
    std::thread::sleep(Duration::from_millis(200));
    m.interrupt(&id).unwrap();
    let line = lrx.recv_timeout(WAIT).expect("инструмент не получил SIGINT");
    assert!(line.contains("int"), "{line}");
  }

  #[test]
  fn stop_all_kills_sessions_and_children() {
    // claude, игнорирующий SIGTERM: stop_all добивает его SIGKILL вместе с инструментом.
    let (_d, p) = script(&format!("trap '' TERM\n{WITH_TOOL}"));
    let m = ClaudeManager::default();
    let (_id, lrx, erx) = start(&m, &p).unwrap();
    let tool = tool_pid(&lrx);
    let _g = KillOnDrop(tool);
    let t = std::time::Instant::now();
    m.stop_all();
    assert!(t.elapsed() < Duration::from_secs(2), "stop_all ждал слишком долго");
    erx.recv_timeout(WAIT).expect("on_exit");
    assert!(wait_dead(tool), "инструмент {tool} пережил выход приложения");
  }

  #[test]
  fn resolve_finds_claude_via_command_v() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let (_d, claude) = script("true");
    std::fs::copy(&claude, bin.join("claude")).unwrap();
    // Login-оболочка — sh: подменяем её скриптом, который выставляет PATH и исполняет переданную команду.
    // rc-файл печатает «чужой» путь к существующему файлу — он не должен быть принят за claude.
    let (_s, sh) = script(&format!(
      "export PATH='{}':\"$PATH\"\necho мусор из rc\necho /bin/sh\necho __KODEVERTEX_CLAUDE_x__=/bin/sh\nalias claude=echo 2>/dev/null\nexec /bin/sh -c \"$2\"",
      bin.display()
    ));
    let found = find_in_login_shell(&sh, Duration::from_secs(5)).unwrap();
    assert_eq!(found.program, bin.join("claude"));
    // PATH оболочки пользователя тоже получен: с ним claude найдёт node из `#!/usr/bin/env node`.
    let path = found.path_env.unwrap();
    assert!(path.starts_with(&format!("{}:", bin.display())), "{path}");
  }

  #[test]
  fn resolve_times_out_on_hanging_shell() {
    let (_s, sh) = script("sleep 300");
    let t = std::time::Instant::now();
    let err = find_in_login_shell(&sh, Duration::from_millis(300)).unwrap_err();
    assert!(t.elapsed() < Duration::from_secs(3));
    assert!(err.contains("не ответила"), "{err}");
  }

  #[test]
  fn env_has_no_claude_service_vars() {
    let (_d, p) = script("printf '{\"v\":\"%s|%s\"}\\n' \"${CLAUDECODE:-none}\" \"${CLAUDE_CODE_ENTRYPOINT:-none}\"");
    let m = ClaudeManager::default();
    let (_id, lrx, _erx) = {
      let _g = crate::pty::tests::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
      unsafe { std::env::set_var("CLAUDECODE", "1") };
      unsafe { std::env::set_var("CLAUDE_CODE_ENTRYPOINT", "cli") };
      let r = start(&m, &p).unwrap();
      unsafe { std::env::remove_var("CLAUDECODE") };
      unsafe { std::env::remove_var("CLAUDE_CODE_ENTRYPOINT") };
      r
    };
    let v: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    assert_eq!(v["v"], "none|none");
  }

  fn attach_rx(m: &ClaudeManager, id: &str) -> Result<(mpsc::Receiver<String>, mpsc::Receiver<Exit>), String> {
    let (ltx, lrx) = mpsc::channel();
    let (etx, erx) = mpsc::channel();
    m.attach(
      id,
      Some("w-2".into()),
      move |l| {
        let _ = ltx.send(l);
      },
      move |c, e| {
        let _ = etx.send((c, e));
      },
    )?;
    Ok((lrx, erx))
  }

  /// Строки, пришедшие без окна, копятся и отдаются по порядку, затем — живые и выход.
  #[test]
  fn detach_queues_lines_in_order_and_attach_flushes_them() {
    let m = ClaudeManager::default();
    let (id, lrx, erx) = start(&m, &fake()).unwrap();
    take(&lrx, 38);
    m.detach(&id).unwrap();
    for i in 0..3 {
      m.send(&id, &format!("m{i}")).unwrap();
    }
    std::thread::sleep(Duration::from_millis(300));
    assert!(lrx.try_recv().is_err(), "строка ушла в старый колбэк");
    let (lrx2, erx2) = attach_rx(&m, &id).unwrap();
    let texts: Vec<String> = take(&lrx2, 3)
      .iter()
      .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["line"]["message"]["content"][0]["text"].as_str().unwrap().to_string())
      .collect();
    assert_eq!(texts, ["m0", "m1", "m2"]);
    // Живые строки — в новый колбэк.
    m.send(&id, "live").unwrap();
    assert!(lrx2.recv_timeout(WAIT).unwrap().contains("live"));
    m.stop(&id).unwrap();
    erx2.recv_timeout(WAIT).expect("on_exit нового окна");
    assert!(erx.try_recv().is_err());
  }

  /// Процесс вышел без окна — выход приходит при attach, после накопленных строк.
  #[test]
  fn exit_while_detached_comes_after_queued_lines() {
    let (_d, p) = script("read _\necho '{\"a\":1}'\necho '{\"b\":2}'\necho 'конец' >&2\nexit 4");
    let m = ClaudeManager::default();
    let (id, _lrx, erx) = start(&m, &p).unwrap();
    m.detach(&id).unwrap();
    m.send(&id, "go").unwrap();
    let deadline = Instant::now() + WAIT;
    while m.send(&id, "x").is_ok() && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(DRAIN_GRACE);
    assert!(erx.try_recv().is_err(), "выход ушёл в старый колбэк");
    let (lrx2, erx2) = attach_rx(&m, &id).unwrap();
    assert_eq!(take(&lrx2, 2), [r#"{"a":1}"#, r#"{"b":2}"#]);
    let (code, err) = erx2.recv_timeout(Duration::from_millis(100)).expect("on_exit при attach");
    assert_eq!(code, Some(4));
    assert!(err.contains("конец"));
    assert!(attach_rx(&m, &id).is_err(), "повторно подключить нечего");
  }

  #[test]
  fn attach_unknown_is_error_and_orphan_is_stopped() {
    let m = ClaudeManager::default();
    assert!(attach_rx(&m, "нет").is_err());
    assert!(m.detach("нет").is_err());
    let (id, lrx, _erx) = start(&m, &fake()).unwrap();
    take(&lrx, 38);
    let g1 = m.detach(&id).unwrap();
    let (_l, erx2) = attach_rx(&m, &id).unwrap();
    let g2 = m.detach(&id).unwrap();
    assert!(!m.expire_orphan(&id, g1));
    assert!(m.send(&id, "x").is_ok());
    assert!(m.expire_orphan(&id, g2));
    // Остановлен, выход некому отдать.
    let deadline = Instant::now() + WAIT;
    while m.send(&id, "x").is_ok() && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(20));
    }
    assert!(m.send(&id, "x").is_err());
    assert!(erx2.try_recv().is_err());
    assert!(attach_rx(&m, &id).is_err());
  }

  /// Перезагрузка/закрытие окна останавливает только его процессы.
  #[test]
  fn stop_owner_stops_only_that_window() {
    let m = ClaudeManager::default();
    let start_as = |owner: &str| {
      let (etx, erx) = mpsc::channel::<Exit>();
      let id = m
        .start(&fake(), Path::new("/"), Launch { owner: Some(owner.into()), ..Launch::default() }, |_| {}, move |c, e| {
          let _ = etx.send((c, e));
        })
        .unwrap();
      (id, erx)
    };
    let (a, erxa) = start_as("main");
    let (b, erxb) = start_as("w-1");
    let (c, _erxc) = start_as("main");
    m.detach(&c).unwrap();
    m.stop_owner("main");
    erxa.recv_timeout(WAIT).expect("процесс окна main остановлен");
    assert!(m.send(&a, "x").is_err());
    assert!(m.send(&b, "x").is_ok());
    assert!(m.send(&c, "x").is_ok(), "отсоединённый процесс остановлен вместе с окном");
    assert!(erxb.try_recv().is_err());
    m.stop(&b).unwrap();
    m.stop(&c).unwrap();
  }
}
