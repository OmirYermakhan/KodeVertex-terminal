use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct GitInfo {
  pub root: Option<String>,
  pub branch: Option<String>,
  pub dirty: bool,
}

/// Запускает `program args` в `cwd`; убивает процесс по `deadline`. None при ошибке, таймауте или ненулевом коде.
fn run_cmd(program: &str, args: &[&str], cwd: &Path, deadline: Instant) -> Option<String> {
  let mut child = Command::new(program)
    .args(args)
    .current_dir(cwd)
    .env("GIT_OPTIONAL_LOCKS", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let mut out = child.stdout.take()?;
  // Читаем в отдельном потоке, чтобы большой вывод не блокировал процесс до таймаута.
  let reader = std::thread::spawn(move || {
    let mut s = String::new();
    let _ = out.read_to_string(&mut s);
    s
  });
  let status = loop {
    match child.try_wait() {
      Ok(Some(st)) => break st,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return None;
      }
    }
  };
  let text = reader.join().ok()?;
  status.success().then(|| text.trim_end().to_string())
}

/// `git -C <cwd> <args>` с общим дедлайном.
fn run_git(cwd: &Path, args: &[&str], deadline: Instant) -> Option<String> {
  let mut full = vec!["-C", cwd.to_str()?];
  full.extend_from_slice(args);
  run_cmd("git", &full, Path::new("."), deadline)
}

pub fn git_info_at(cwd: &Path) -> GitInfo {
  // Один общий дедлайн на все git-команды вызова.
  let deadline = Instant::now() + GIT_TIMEOUT;
  let Some(root) = run_git(cwd, &["rev-parse", "--show-toplevel"], deadline).filter(|s| !s.is_empty()) else {
    return GitInfo::default();
  };
  let branch = run_git(cwd, &["branch", "--show-current"], deadline)
    .filter(|s| !s.is_empty())
    .or_else(|| run_git(cwd, &["rev-parse", "--short", "HEAD"], deadline).filter(|s| !s.is_empty()));
  let dirty = run_git(cwd, &["status", "--porcelain"], deadline).is_some_and(|s| !s.is_empty());
  GitInfo { root: Some(root), branch, dirty }
}

/// Async-команда: git-подпроцессы идут в пуле, не в главном потоке.
#[tauri::command(async)]
pub fn git_info(cwd: String) -> GitInfo {
  git_info_at(Path::new(&cwd))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
      .args(args)
      .status()
      .unwrap()
      .success();
    assert!(ok, "git {:?} failed", args);
  }

  fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-b", "main"]);
    git(d.path(), &["commit", "--allow-empty", "-m", "init"]);
    d
  }

  #[test]
  fn clean_repo_reports_branch() {
    let d = repo();
    let i = git_info_at(d.path());
    assert_eq!(i.branch.as_deref(), Some("main"));
    assert!(!i.dirty);
    assert!(i.root.is_some());
  }

  #[test]
  fn new_file_makes_dirty() {
    let d = repo();
    std::fs::write(d.path().join("a.txt"), "x").unwrap();
    assert!(git_info_at(d.path()).dirty);
  }

  #[test]
  fn subdir_points_to_root() {
    let d = repo();
    let sub = d.path().join("a/b");
    std::fs::create_dir_all(&sub).unwrap();
    let want = std::fs::canonicalize(d.path()).unwrap();
    let got = git_info_at(&sub).root.unwrap();
    assert_eq!(std::fs::canonicalize(got).unwrap(), want);
  }

  #[test]
  fn outside_repo_is_empty() {
    let d = tempfile::tempdir().unwrap();
    // GIT_CEILING_DIRECTORIES не нужен: tempdir вне репозиториев.
    assert_eq!(git_info_at(d.path()), GitInfo::default());
  }

  #[test]
  fn missing_path_does_not_panic() {
    assert_eq!(git_info_at(Path::new("/definitely/not/here/kv")), GitInfo::default());
  }

  #[test]
  fn detached_head_gives_short_sha() {
    let d = repo();
    git(d.path(), &["checkout", "--detach"]);
    let sha = run_git(d.path(), &["rev-parse", "--short", "HEAD"], Instant::now() + Duration::from_secs(2)).unwrap();
    assert_eq!(git_info_at(d.path()).branch, Some(sha));
  }

  #[test]
  #[cfg(unix)]
  fn slow_child_is_killed_at_deadline() {
    let start = Instant::now();
    let r = run_cmd("sleep", &["5"], Path::new("."), start + Duration::from_millis(200));
    assert!(r.is_none());
    assert!(start.elapsed() < Duration::from_secs(2), "took {:?}", start.elapsed());
  }

  #[test]
  fn expired_deadline_skips_work_quickly() {
    let d = repo();
    let start = Instant::now();
    assert!(run_git(d.path(), &["status"], start - Duration::from_millis(1)).is_none());
    assert!(start.elapsed() < Duration::from_secs(1));
  }
}
