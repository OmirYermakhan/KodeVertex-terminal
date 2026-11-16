use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const GIT_TIMEOUT: Duration = Duration::from_secs(2);
/// Ключи фильтров в конфиге: `git status` запускает их команды.
const FILTER_RE: &str = r"^filter\..*\.(clean|smudge|process)$";

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
  run_git(cwd, &["config", "--name-only", "--get-regexp", FILTER_RE], deadline)
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

/// Время изменения файла (None — файла нет).
fn mtime(p: &Path) -> Option<SystemTime> {
  std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Ключ кэша перекрытий фильтров: время изменения конфигов, откуда git берёт `filter.*`
/// (репозиторий и пользователь). Системный конфиг отключён (`GIT_CONFIG_NOSYSTEM`).
type FilterKey = [Option<SystemTime>; 3];

fn filter_key(common_dir: &Path) -> FilterKey {
  let home = dirs::home_dir();
  let xdg = std::env::var_os("XDG_CONFIG_HOME")
    .filter(|v| !v.is_empty())
    .map(PathBuf::from)
    .or_else(|| home.as_ref().map(|h| h.join(".config")));
  [
    mtime(&common_dir.join("config")),
    home.and_then(|h| mtime(&h.join(".gitconfig"))),
    xdg.and_then(|x| mtime(&x.join("git").join("config"))),
  ]
}

/// Кэш перекрытий не старше этого: `include.path` может подтянуть файл, время которого не в ключе.
const FILTER_CACHE_TTL: Duration = Duration::from_secs(30);

type FilterCache = HashMap<PathBuf, (FilterKey, Instant, Vec<String>)>;

fn filter_cache() -> &'static Mutex<FilterCache> {
  static C: OnceLock<Mutex<FilterCache>> = OnceLock::new();
  C.get_or_init(Default::default)
}

/// `filter_overrides` с кэшем по общему каталогу `.git` (один на все worktree): пока конфиги
/// не менялись, `git config` не запускается на каждый опрос. Кэшируется только полученный ответ.
fn filter_overrides_cached(cwd: &Path, common_dir: &Path, deadline: Instant) -> Vec<String> {
  let key = filter_key(common_dir);
  if let Some((k, at, v)) = filter_cache().lock().ok().and_then(|c| c.get(common_dir).cloned())
    && k == key
    && at.elapsed() < FILTER_CACHE_TTL
  {
    return v;
  }
  let Some(c) = cwd.to_str() else { return Vec::new() };
  let args = git_args(c, &[], &["config", "--name-only", "--get-regexp", FILTER_RE]);
  // Код 1 — совпадений нет: это тоже ответ («фильтров нет»), его можно кэшировать.
  let Some((names, code)) = run_cmd_code("git", &args, Path::new("."), GIT_ENV, deadline) else { return Vec::new() };
  let v = filter_overrides_from(&names);
  if matches!(code, Some(0 | 1))
    && let Ok(mut cache) = filter_cache().lock()
  {
    cache.insert(common_dir.to_path_buf(), (key, Instant::now(), v.clone()));
  }
  v
}

/// Как `run_cmd`, но отдаёт вывод и при ненулевом коде (вместе с кодом). None — не запустился или не успел.
fn run_cmd_code(program: &str, args: &[&str], cwd: &Path, env: &[(&str, &str)], deadline: Instant) -> Option<(String, Option<i32>)> {
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
  let reader = std::thread::spawn(move || {
    let mut buf = Vec::new();
    let _ = out.take(DEFAULT_OUT_MAX as u64).read_to_end(&mut buf);
    buf
  });
  let status = loop {
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
  Some((String::from_utf8_lossy(&buf).trim_end().to_string(), status.code()))
}

/// Дедлайн подготовительных команд (корень, ветка, конфиг) — общий.
const PREP_TIMEOUT: Duration = Duration::from_secs(2);
/// Дедлайн проверки неотслеживаемых: она лишь дополняет ответ.
const UNTRACKED_TIMEOUT: Duration = Duration::from_secs(1);

pub fn git_info_at(cwd: &Path) -> GitInfo {
  let prep = Instant::now() + PREP_TIMEOUT;
  // Корень и общий каталог `.git` одним вызовом (каталог — ключ кэша фильтров).
  let Some(out) = run_git(cwd, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], prep) else {
    return GitInfo::default();
  };
  let mut lines = out.lines();
  let Some(root) = lines.next().map(str::to_string).filter(|s| !s.is_empty()) else {
    return GitInfo::default();
  };
  let common_dir = lines.next().map(PathBuf::from).unwrap_or_else(|| Path::new(&root).join(".git"));
  let branch = run_git(cwd, &["branch", "--show-current"], prep)
    .filter(|s| !s.is_empty())
    .or_else(|| run_git(cwd, &["rev-parse", "--short", "HEAD"], prep).filter(|s| !s.is_empty()));
  let filters = filter_overrides_cached(cwd, &common_dir, prep);
  let Some(c) = cwd.to_str() else { return GitInfo { root: Some(root), branch, dirty: false } };
  // Отслеживаемые изменения — без обхода неотслеживаемых (в большом репозитории он не успевал
  // за дедлайн) и без подмодулей (их конфиг с фильтрами не перекрыт). Дедлайн — свой, полный.
  let args = git_args(c, &filters, &["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"]);
  let tracked = run_cmd("git", &args, Path::new("."), GIT_ENV, Instant::now() + GIT_TIMEOUT);
  let mut dirty = tracked.is_some_and(|s| !s.is_empty());
  if !dirty {
    // Неотслеживаемые: хватает первого (потолок вывода в 1 байт — git сразу останавливается),
    // `--directory` не спускается в неотслеживаемые папки.
    let args = git_args(c, &filters, &["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory"]);
    dirty = run_cmd_capped("git", &args, Path::new("."), GIT_ENV, Instant::now() + UNTRACKED_TIMEOUT, 1)
      .is_some_and(|(s, _)| !s.is_empty());
  }
  GitInfo { root: Some(root), branch, dirty }
}

/// git-подпроцессы — в пуле блокирующих задач: не в главном потоке и не в рабочих потоках tokio.
#[tauri::command]
pub async fn git_info(cwd: String) -> GitInfo {
  tauri::async_runtime::spawn_blocking(move || git_info_at(Path::new(&cwd))).await.unwrap_or_default()
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

  #[test]
  fn untracked_dir_and_staged_change_make_dirty() {
    let d = repo();
    std::fs::create_dir_all(d.path().join("new/deep")).unwrap();
    std::fs::write(d.path().join("new/deep/x"), "x").unwrap();
    assert!(git_info_at(d.path()).dirty);
    let d = repo();
    std::fs::write(d.path().join("a"), "1").unwrap();
    git(d.path(), &["add", "a"]);
    assert!(git_info_at(d.path()).dirty);
  }

  /// Кэш перекрытий фильтров: конфиг, изменённый после первого опроса, читается заново.
  #[test]
  #[cfg(unix)]
  fn filter_cache_sees_config_changed_later() {
    let d = repo();
    let pwned = d.path().join("pwned");
    std::fs::write(d.path().join(".gitattributes"), "*.txt filter=late\n").unwrap();
    std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-m", "a"]);
    assert!(!git_info_at(d.path()).dirty);
    // Время изменения файла — в ключе кэша; ждём, чтобы оно точно сменилось.
    std::thread::sleep(Duration::from_millis(20));
    hostile_config(d.path(), &format!("[filter \"late\"]\n\tclean = \"touch '{}'; cat\"\n", pwned.display()));
    std::fs::write(d.path().join("a.txt"), "b\n").unwrap();
    assert!(git_info_at(d.path()).dirty);
    assert!(!pwned.exists(), "фильтр из изменённого конфига выполнился");
  }

  /// Подмодуль с фильтром в своём конфиге: `git status` верхнего репозитория в него не заходит.
  #[test]
  #[cfg(unix)]
  fn submodule_filter_does_not_run() {
    let sub = repo();
    std::fs::write(sub.path().join(".gitattributes"), "*.txt filter=evil\n").unwrap();
    std::fs::write(sub.path().join("a.txt"), "a\n").unwrap();
    git(sub.path(), &["add", "."]);
    git(sub.path(), &["commit", "-m", "a"]);
    let d = repo();
    let src = sub.path().to_str().unwrap();
    git(d.path(), &["-c", "protocol.file.allow=always", "submodule", "add", src, "sub"]);
    git(d.path(), &["commit", "-m", "sub"]);
    let pwned = d.path().join("pwned");
    // Конфиг подмодуля: .git/modules/sub/config.
    let cfg = d.path().join(".git/modules/sub/config");
    let mut text = std::fs::read_to_string(&cfg).unwrap();
    text.push_str(&format!("[filter \"evil\"]\n\tclean = \"touch '{}'; cat\"\n", pwned.display()));
    std::fs::write(&cfg, text).unwrap();
    std::fs::write(d.path().join("sub/a.txt"), "b\n").unwrap();
    let _ = git_info_at(d.path());
    assert!(!pwned.exists(), "фильтр из конфига подмодуля выполнился");
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
