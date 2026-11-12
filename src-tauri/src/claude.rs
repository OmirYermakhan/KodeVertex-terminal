use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
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

struct Session {
  child: Arc<Mutex<Child>>,
  stdin: Arc<Mutex<ChildStdin>>,
  /// Когда попросили остановиться (SIGTERM отправлен); по истечении `KILL_GRACE` — SIGKILL.
  stop_at: Arc<Mutex<Option<Instant>>>,
}

#[derive(Default)]
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

impl ClaudeManager {
  pub fn start(
    &self,
    program: &Path,
    cwd: &Path,
    resume: Option<String>,
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
    ]);
    if let Some(r) = resume {
      cmd.args(["--resume", &r]);
    }
    // Служебные переменные Claude Code из окружения приложения процессу не нужны.
    for (k, _) in std::env::vars_os() {
      if k.to_str().is_some_and(shell::is_claude_service_var) {
        cmd.env_remove(k);
      }
    }
    if cwd.is_dir() {
      cmd.current_dir(cwd);
    }
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
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
              let overdue = lock(&stop_at).is_some_and(|t| t.elapsed() >= KILL_GRACE);
              if overdue {
                let _ = c.kill();
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

  /// Пишет сообщение пользователя в stdin процесса одной JSON-строкой.
  pub fn send(&self, id: &str, text: &str) -> Result<(), String> {
    let stdin = lock(&self.sessions).get(id).map(|s| s.stdin.clone()).ok_or_else(|| no_session(id))?;
    let msg = serde_json::json!({
      "type": "user",
      "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    let mut line = msg.to_string();
    line.push('\n');
    let mut w = lock(&stdin);
    w.write_all(line.as_bytes()).and_then(|_| w.flush()).map_err(|e| e.to_string())
  }

  /// SIGINT процессу `claude` (прерывает текущий ход).
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
}

fn signal(child: &Child, sig: libc::c_int) -> Result<(), String> {
  if unsafe { libc::kill(child.id() as libc::pid_t, sig) } == 0 {
    Ok(())
  } else {
    Err(std::io::Error::last_os_error().to_string())
  }
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
  let out = Command::new(sh)
    .args(["-lic", "whence -p claude"])
    .stdin(Stdio::null())
    .stderr(Stdio::null())
    .output()
    .map_err(|_| NOT_FOUND.to_string())?;
  let stdout = String::from_utf8_lossy(&out.stdout);
  // rc-файлы могут печатать лишнее: берём последнюю строку, которая — существующий абсолютный путь.
  let path = stdout
    .lines()
    .rev()
    .map(str::trim)
    .find(|l| l.starts_with('/') && Path::new(l).is_file())
    .map(PathBuf::from)
    .ok_or_else(|| NOT_FOUND.to_string())?;
  Ok(CLAUDE_PATH.get_or_init(|| path).clone())
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
  on_line: Channel<String>,
  on_exit: Channel<ClaudeExit>,
) -> Result<String, String> {
  let program = tauri::async_runtime::spawn_blocking(resolve_claude).await.map_err(|e| e.to_string())??;
  manager.start(
    &program,
    Path::new(&cwd),
    resume,
    move |line| {
      let _ = on_line.send(line);
    },
    move |code, stderr| {
      let _ = on_exit.send(ClaudeExit { code, stderr });
    },
  )
}

#[tauri::command]
pub async fn claude_send(manager: State<'_, ClaudeManager>, id: String, text: String) -> Result<(), String> {
  manager.send(&id, &text)
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
      None,
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
    m.start(&p, Path::new("/"), Some("abc-123".into()), move |l| {
      let _ = ltx.send(l);
    }, |_, _| {})
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&lrx.recv_timeout(WAIT).unwrap()).unwrap();
    let a = v["args"].as_str().unwrap();
    assert_eq!(
      a,
      "-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions --resume abc-123"
    );
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
