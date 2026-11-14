use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct GitInfo {
  pub root: Option<String>,
  pub branch: Option<String>,
  pub dirty: bool,
}

/// Переменные окружения для git: без системного конфига, без блокировок индекса, без
/// вопросов о паролях (stdin закрыт — git повис бы до таймаута) и без докачки недостающих
/// объектов частичного клона (её транспорт — `core.sshCommand` из чужого конфига).
pub(crate) const GIT_ENV: &[(&str, &str)] =
  &[("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0"), ("GIT_NO_LAZY_FETCH", "1")];

/// Настройки, перекрывающие конфиг репозитория. git запускается сам при каждом `cd`, а
/// `.git/config` чужого репозитория (скачанный архив, клон) может назначить команды:
/// `core.fsmonitor` выполняется прямо из `git status`, хуки — из `hooksPath`. Сеть не нужна
/// никогда: `protocol.allow=never` запрещает любой транспорт (вторая защита от докачки).
pub(crate) const GIT_SAFE_CONFIG: &[&str] = &[
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.allow=never",
];

/// Запускает `program args` в `cwd` с окружением `env`; убивает процесс по `deadline`.
/// None при ошибке, таймауте или ненулевом коде. Вывод без хвостовых пробелов.
pub(crate) fn run_cmd(program: &str, args: &[&str], cwd: &Path, env: &[(&str, &str)], deadline: Instant) -> Option<String> {
  run_cmd_capped(program, args, cwd, env, deadline, DEFAULT_OUT_MAX).map(|(s, _)| s.trim_end().to_string())
}

/// Общий потолок вывода: чужой репозиторий не должен раздуть память.
pub(crate) const DEFAULT_OUT_MAX: usize = 16 * 1024 * 1024;

/// Как `run_cmd`, но читает не больше `max` байт и ничего не обрезает: пробелы в конце
/// (контекстная строка diff « ») сохраняются. При превышении процесс убивается, вывод
/// усечён до `max` байт, второй элемент — true. Не-UTF-8 заменяется на U+FFFD.
pub(crate) fn run_cmd_capped(program: &str, args: &[&str], cwd: &Path, env: &[(&str, &str)], deadline: Instant, max: usize) -> Option<(String, bool)> {
  let mut child = Command::new(program)
    .args(args)
    .current_dir(cwd)
    .envs(env.iter().copied())
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let out = child.stdout.take()?;
  let capped = Arc::new(AtomicBool::new(false));
  let flag = capped.clone();
  // Читаем в отдельном потоке, чтобы большой вывод не блокировал процесс до таймаута.
  let reader = std::thread::spawn(move || {
    let mut buf = Vec::new();
    let _ = out.take(max as u64 + 1).read_to_end(&mut buf);
    if buf.len() > max {
      buf.truncate(max);
      flag.store(true, Ordering::SeqCst);
    }
    buf
  });
  let status = loop {
    if capped.load(Ordering::SeqCst) {
      let _ = child.kill();
      let _ = child.wait();
      let buf = reader.join().ok()?;
      return Some((String::from_utf8_lossy(&buf).into_owned(), true));
    }
    match child.try_wait() {
      Ok(Some(st)) => break st,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        return None;
      }
    }
  };
  let buf = reader.join().ok()?;
  let truncated = capped.load(Ordering::SeqCst);
  (status.success() || truncated).then(|| (String::from_utf8_lossy(&buf).into_owned(), truncated))
}

/// Аргументы `git`: защитные `-c`, перекрытия `extra` (тоже пары `-c k=v`), `-C <cwd>`, затем `args`.
pub(crate) fn git_args<'a>(cwd: &'a str, extra: &'a [String], args: &[&'a str]) -> Vec<&'a str> {
  let mut full: Vec<&str> = GIT_SAFE_CONFIG.to_vec();
  full.extend(extra.iter().map(String::as_str));
  full.extend(["-C", cwd]);
  full.extend_from_slice(args);
  full
}

/// `git -C <cwd> <args>` с общим дедлайном и защитными настройками.
fn run_git(cwd: &Path, args: &[&str], deadline: Instant) -> Option<String> {
  run_cmd("git", &git_args(cwd.to_str()?, &[], args), Path::new("."), GIT_ENV, deadline)
}

/// Фильтры (`filter.<имя>.clean/process`) из конфига репозитория: `git status` запускает их
/// для изменённых файлов с атрибутом `filter=<имя>`. Отключаем каждый пустой командой —
/// git тогда не фильтрует файл. Чтение конфига само ничего не запускает.
pub(crate) fn filter_overrides(cwd: &Path, deadline: Instant) -> Vec<String> {
  let re = r"^filter\..*\.(clean|smudge|process)$";
  run_git(cwd, &["config", "--name-only", "--get-regexp", re], deadline)
    .map(|names| filter_overrides_from(&names))
    .unwrap_or_default()
}

/// Имена ключей `filter.<имя>.<команда>` по строке → пары `-c filter.<имя>.<команда>=`.
fn filter_overrides_from(names: &str) -> Vec<String> {
  let mut drivers: Vec<&str> = names
    .lines()
    .filter_map(|k| k.strip_prefix("filter.")?.rsplit_once('.').map(|(name, _)| name))
    .collect();
  drivers.sort_unstable();
  drivers.dedup();
  drivers
    .into_iter()
    .flat_map(|d| ["clean", "smudge", "process"].map(|c| ["-c".to_string(), format!("filter.{d}.{c}=")]))
    .flatten()
    .collect()
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
  let filters = filter_overrides(cwd, deadline);
  let dirty = cwd.to_str().and_then(|c| {
    let args = git_args(c, &filters, &["status", "--porcelain"]);
    run_cmd("git", &args, Path::new("."), GIT_ENV, deadline)
  });
  let dirty = dirty.is_some_and(|s| !s.is_empty());
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
    let r = run_cmd("sleep", &["5"], Path::new("."), &[], start + Duration::from_millis(200));
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

  #[test]
  fn git_args_put_safe_config_first() {
    let extra = vec!["-c".to_string(), "filter.x.clean=".to_string()];
    let a = git_args("/r", &extra, &["status", "--porcelain"]);
    #[rustfmt::skip]
    let want = [
      "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false",
      "-c", "protocol.allow=never", "-c", "filter.x.clean=", "-C", "/r", "status", "--porcelain",
    ];
    assert_eq!(a, want);
    assert!(GIT_ENV.contains(&("GIT_CONFIG_NOSYSTEM", "1")));
    assert!(GIT_ENV.contains(&("GIT_OPTIONAL_LOCKS", "0")));
    assert!(GIT_ENV.contains(&("GIT_TERMINAL_PROMPT", "0")));
    assert!(GIT_ENV.contains(&("GIT_NO_LAZY_FETCH", "1")));
  }

  #[test]
  fn filter_overrides_cover_every_driver() {
    let o = filter_overrides_from("filter.lfs.clean\nfilter.lfs.process\nfilter.a.b.smudge\n");
    #[rustfmt::skip]
    let want = [
      "-c", "filter.a.b.clean=", "-c", "filter.a.b.smudge=", "-c", "filter.a.b.process=",
      "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=",
    ];
    assert_eq!(o, want);
    assert!(filter_overrides_from("").is_empty());
  }

  /// Дописывает строки в `.git/config` репозитория (как сделал бы чужой архив).
  fn hostile_config(d: &Path, text: &str) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(d.join(".git/config")).unwrap();
    f.write_all(text.as_bytes()).unwrap();
  }

  #[test]
  #[cfg(unix)]
  fn hostile_fsmonitor_and_filter_do_not_run() {
    let d = repo();
    let pwned = d.path().join("pwned");
    let p = pwned.display();
    std::fs::write(d.path().join(".gitattributes"), "*.txt filter=evil\n").unwrap();
    std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
    git(d.path(), &["-c", "filter.evil.clean=cat", "add", "."]);
    git(d.path(), &["-c", "filter.evil.clean=cat", "commit", "-m", "a"]);
    hostile_config(
      d.path(),
      &format!(
        "[core]\n\tfsmonitor = \"touch '{p}'; false\"\n\tuntrackedCache = true\n\
         [filter \"evil\"]\n\tclean = \"touch '{p}'; cat\"\n\tprocess = \"touch '{p}'\"\n"
      ),
    );
    // Изменённый файл с filter=evil: без защиты git status запустил бы clean-фильтр.
    std::fs::write(d.path().join("a.txt"), "b\n").unwrap();
    let i = git_info_at(d.path());
    assert!(i.dirty);
    assert!(!pwned.exists(), "команда из .git/config выполнилась");
  }

  /// Без защиты те же настройки действительно выполняют команду — тест выше что-то проверяет.
  #[test]
  #[cfg(unix)]
  fn hostile_config_runs_without_protection() {
    let d = repo();
    let pwned = d.path().join("pwned");
    hostile_config(d.path(), &format!("[core]\n\tfsmonitor = \"touch '{}'; false\"\n", pwned.display()));
    let _ = Command::new("git").arg("-C").arg(d.path()).args(["status", "--porcelain"]).output().unwrap();
    assert!(pwned.exists());

    // И clean-фильтр: git status запускает его для изменённого файла с filter=evil.
    let d = repo();
    let pwned = d.path().join("pwned");
    std::fs::write(d.path().join(".gitattributes"), "*.txt filter=evil\n").unwrap();
    std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
    git(d.path(), &["-c", "filter.evil.clean=cat", "add", "."]);
    git(d.path(), &["-c", "filter.evil.clean=cat", "commit", "-m", "a"]);
    hostile_config(d.path(), &format!("[filter \"evil\"]\n\tclean = \"touch '{}'; cat\"\n", pwned.display()));
    std::fs::write(d.path().join("a.txt"), "b\n").unwrap();
    let _ = Command::new("git").arg("-C").arg(d.path()).args(["status", "--porcelain"]).output().unwrap();
    assert!(pwned.exists());
  }
}
