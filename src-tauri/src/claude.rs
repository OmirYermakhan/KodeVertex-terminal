use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
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
/// Как часто проверяем, не завершился ли процесс.
const WAIT_POLL: Duration = Duration::from_millis(20);

const NOT_FOUND: &str = "Claude Code не найден. Установите: npm i -g @anthropic-ai/claude-code";
/// Сколько ждать login-оболочку, которая ищет `claude` в PATH пользователя.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// Сколько при выходе из приложения ждать, пока процессы `claude` завершатся по SIGTERM.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(1000);

struct Session {
  child: Arc<Mutex<Child>>,
  stdin: Arc<Mutex<ChildStdin>>,
  /// Когда попросили остановиться (SIGTERM отправлен); по истечении `KILL_GRACE` — SIGKILL.
  stop_at: Arc<Mutex<Option<Instant>>>,
}

#[derive(Default, Clone)]
pub struct ClaudeManager {
  sessions: Arc<Mutex<HashMap<String, Session>>>,
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

/// Параметры запуска процесса `claude`: продолжение сессии, модель и усилие сессии.
#[derive(Default, Clone, Debug)]
pub struct Launch {
  pub resume: Option<String>,
  /// Псевдоним (`opus`, `fable`, `default`) или полное имя модели.
  pub model: Option<String>,
  pub effort: Option<String>,
}

/// Аргументы `claude` после обязательных: `--model`, `--effort`, `--resume`.
/// Пустые значения и неизвестное усилие пропускаются.
pub fn launch_args(l: &Launch) -> Vec<String> {
  let mut a = Vec::new();
  if let Some(m) = l.model.as_deref().map(str::trim).filter(|m| !m.is_empty() && !m.starts_with('-')) {
    a.extend(["--model".to_string(), m.to_string()]);
  }
  if let Some(e) = l.effort.as_deref().filter(|e| EFFORTS.contains(e)) {
    a.extend(["--effort".to_string(), e.to_string()]);
  }
  if let Some(r) = l.resume.as_deref().filter(|r| !r.is_empty()) {
    a.extend(["--resume".to_string(), r.to_string()]);
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
      "--permission-mode",
      "bypassPermissions",
      // Запросы разрешений (вопросы AskUserQuestion) — управляющими запросами в stdout.
      "--permission-prompt-tool",
      "stdio",
    ]);
    cmd.args(launch_args(&launch));
    // Служебные переменные Claude Code из окружения приложения процессу не нужны.
    for (k, _) in std::env::vars_os() {
      if k.to_str().is_some_and(shell::is_claude_service_var) {
        cmd.env_remove(k);
      }
    }
    // С bypassPermissions запуск «где-то ещё» (например, в `/` у приложения из Dock) недопустим.
    if !cwd.is_dir() {
      return Err(format!("Каталог {} не существует", cwd.display()));
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
    let child = Arc::new(Mutex::new(child));
    let stop_at = Arc::new(Mutex::new(None::<Instant>));
    lock(&self.sessions).insert(
      id.clone(),
      Session { child: child.clone(), stdin: Arc::new(Mutex::new(stdin)), stop_at: stop_at.clone() },
    );

    let (out_done, out_done_rx) = mpsc::channel::<()>();
    let (err_done, err_done_rx) = mpsc::channel::<Vec<u8>>();
    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));

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
              on_line(line.to_string());
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
      let code = loop {
        {
          let mut c = lock(&child);
          match c.try_wait() {
            Ok(Some(status)) => {
              // Остановленная сессия: потомки (инструменты) не должны пережить claude.
              if lock(&stop_at).is_some() {
                kill_group(c.id(), libc::SIGKILL);
              }
              break status.code();
            }
            Ok(None) => {
              let overdue = lock(&stop_at).is_some_and(|t| t.elapsed() >= KILL_GRACE);
              if overdue {
                kill_group(c.id(), libc::SIGKILL);
              }
            }
            Err(_) => break None,
          }
        }
        std::thread::sleep(WAIT_POLL);
      };
      // Сессию убираем до события, чтобы после on_exit send уже давал Err.
      lock(&sessions).remove(&wait_id);
      // Даём читателям дочитать хвост (потомок мог унаследовать пайпы и держать их).
      let _ = out_done_rx.recv_timeout(DRAIN_GRACE);
      let _ = err_done_rx.recv_timeout(DRAIN_GRACE);
      let text = String::from_utf8_lossy(&lock(&tail)).into_owned();
      on_exit(code, text);
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
    let child = lock(&self.sessions).get(id).map(|s| s.child.clone()).ok_or_else(|| no_session(id))?;
    let c = lock(&child);
    // Под замком `child`: пока `try_wait` не подобрал процесс, его pid не переиспользован.
    signal(&c, libc::SIGINT)
  }

  /// Просит процесс завершиться (SIGTERM), через `KILL_GRACE` — SIGKILL.
  /// Неизвестная или уже завершённая сессия — не ошибка.
  pub fn stop(&self, id: &str) -> Result<(), String> {
    let Some((child, stop_at)) = lock(&self.sessions).get(id).map(|s| (s.child.clone(), s.stop_at.clone())) else {
      return Ok(());
    };
    let c = lock(&child);
    *lock(&stop_at) = Some(Instant::now());
    signal(&c, libc::SIGTERM).or(Ok(()))
  }

  /// Выход из приложения: всем сессиям SIGTERM, через `SHUTDOWN_GRACE` оставшимся — SIGKILL (вместе с потомками).
  pub fn stop_all(&self) {
    let ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
    for id in &ids {
      let _ = self.stop(id);
    }
    // Поток ожидания убирает сессию из таблицы, когда процесс завершился.
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while !lock(&self.sessions).is_empty() && Instant::now() < deadline {
      std::thread::sleep(WAIT_POLL);
    }
    let left: Vec<_> = lock(&self.sessions).values().map(|s| s.child.clone()).collect();
    for child in left {
      let mut c = lock(&child);
      // Под замком `child`: процесс ещё не подобран потоком ожидания, id группы не переиспользован.
      kill_group(c.id(), libc::SIGKILL);
      let _ = c.try_wait();
    }
  }
}

/// Сигнал группе процесса `claude` (группу он возглавляет: `process_group(0)`).
fn signal(child: &Child, sig: libc::c_int) -> Result<(), String> {
  if unsafe { libc::killpg(child.id() as libc::pid_t, sig) } == 0 {
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

static CLAUDE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Ищет `claude` в PATH login-оболочки (приложение из Dock не видит PATH пользователя).
/// Успешный результат кэшируется.
pub fn resolve_claude() -> Result<PathBuf, String> {
  if let Some(p) = CLAUDE_PATH.get() {
    return Ok(p.clone());
  }
  let sh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
  let path = find_in_login_shell(Path::new(&sh), RESOLVE_TIMEOUT)?;
  Ok(CLAUDE_PATH.get_or_init(|| path).clone())
}

/// `command -v claude` в login-оболочке `sh` (POSIX: работает и не в zsh). Алиас снимаем:
/// нужен путь к файлу. Оболочка, не ответившая за `timeout`, убивается вместе с потомками.
fn find_in_login_shell(sh: &Path, timeout: Duration) -> Result<PathBuf, String> {
  let mut child = Command::new(sh)
    .args(["-lic", "unalias claude 2>/dev/null; command -v claude"])
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
  // rc-файлы могут печатать лишнее: берём последнюю строку, которая — существующий абсолютный путь.
  stdout
    .lines()
    .rev()
    .map(str::trim)
    .find(|l| l.starts_with('/') && Path::new(l).is_file())
    .map(PathBuf::from)
    .ok_or_else(|| NOT_FOUND.to_string())
}

#[derive(Serialize, Clone)]
pub struct ClaudeExit {
  pub code: Option<i32>,
  pub stderr: String,
}

#[tauri::command]
pub async fn claude_start(
  manager: State<'_, ClaudeManager>,
  cwd: String,
  resume: Option<String>,
  model: Option<String>,
  effort: Option<String>,
  on_line: Channel<String>,
  on_exit: Channel<ClaudeExit>,
) -> Result<String, String> {
  let program = tauri::async_runtime::spawn_blocking(resolve_claude).await.map_err(|e| e.to_string())??;
  manager.start(
    &program,
    Path::new(&cwd),
    Launch { resume, model, effort },
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
    m.start(&p, Path::new("/"), Launch { resume: Some("abc-123".into()), model: Some("fable".into()), effort: Some("high".into()) }, move |l| {
      let _ = ltx.send(l);
    }, |_, _| {})
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    let a = v["args"].as_str().unwrap();
    assert_eq!(
      a,
      "-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions --permission-prompt-tool stdio --model fable --effort high --resume abc-123"
    );
  }

  #[test]
  fn launch_args_skip_empty_and_unknown() {
    assert!(launch_args(&Launch::default()).is_empty());
    let l = Launch { resume: Some(String::new()), model: Some("--evil".into()), effort: Some("huge".into()) };
    assert!(launch_args(&l).is_empty());
    let l = Launch { resume: None, model: Some("default".into()), effort: Some("max".into()) };
    assert_eq!(launch_args(&l), ["--model", "default", "--effort", "max"]);
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
    let (_s, sh) = script(&format!("export PATH='{}':\"$PATH\"\necho мусор из rc\nalias claude=echo 2>/dev/null\nexec /bin/sh -c \"$2\"", bin.display()));
    let found = find_in_login_shell(&sh, Duration::from_secs(5)).unwrap();
    assert_eq!(found, bin.join("claude"));
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
}
