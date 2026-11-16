use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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

/// Аргументы `git`: защитные `-c`, `-C <cwd>`, затем `args`. Перекрытия фильтров сюда не
/// входят — они в окружении (`git_env`): в `-c имя=значение` git режет по первому `=`, и
/// фильтр с `=` в имени ушёл бы из-под перекрытия.
pub(crate) fn git_args<'a>(cwd: &'a str, args: &[&'a str]) -> Vec<&'a str> {
  let mut full: Vec<&str> = GIT_SAFE_CONFIG.to_vec();
  full.extend(["-C", cwd]);
  full.extend_from_slice(args);
  full
}

/// Окружение git: `GIT_ENV`, `extra` и перекрытия `keys` (каждому — пустое значение) через
/// `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`: ключ передаётся целиком,
/// без разбора по `=`. Счётчик задаётся всегда (и 0) — унаследованный `GIT_CONFIG_COUNT`
/// с чужими ключами не применяется.
pub(crate) fn git_env(keys: &[String], extra: &[(&str, &str)]) -> Vec<(String, String)> {
  let mut env: Vec<(String, String)> = GIT_ENV.iter().chain(extra).map(|(k, v)| (k.to_string(), v.to_string())).collect();
  env.push(("GIT_CONFIG_COUNT".into(), keys.len().to_string()));
  for (i, k) in keys.iter().enumerate() {
    env.push((format!("GIT_CONFIG_KEY_{i}"), k.clone()));
    env.push((format!("GIT_CONFIG_VALUE_{i}"), String::new()));
  }
  env
}

/// Где искать git. Приложение из Finder получает PATH `/usr/bin:/bin:…`, а `/usr/bin/git` —
/// заглушка Xcode: без Command Line Tools она падает (`xcrun: invalid active developer path`),
/// и панель проекта считала любую папку «не git». Поэтому кроме PATH — обычные места установки.
const GIT_CANDIDATES: &[&str] = &["git", "/opt/homebrew/bin/git", "/usr/local/bin/git", "/opt/local/bin/git"];

/// Первый кандидат, для которого `works` вернул true.
fn pick_git<'a>(candidates: &[&'a str], works: impl Fn(&str) -> bool) -> Option<&'a str> {
  candidates.iter().copied().find(|c| works(c))
}

/// Рабочий git (проверяется один раз — `git --version` с кодом 0); не нашли — просто "git".
pub(crate) fn git_bin() -> &'static str {
  static BIN: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
  BIN.get_or_init(|| {
    let works = |p: &str| {
      run_cmd_code(p, &["--version"], Path::new("."), GIT_ENV, Instant::now() + GIT_TIMEOUT).is_some_and(|(_, code)| code == Some(0))
    };
    pick_git(GIT_CANDIDATES, works).unwrap_or("git")
  })
}

/// Пары окружения как ссылки — для `run_cmd`.
pub(crate) fn env_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
  env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

/// `git -C <cwd> <args>` с общим дедлайном и защитными настройками.
fn run_git(cwd: &Path, args: &[&str], deadline: Instant) -> Option<String> {
  let env = git_env(&[], &[]);
  run_cmd(git_bin(), &git_args(cwd.to_str()?, args), Path::new("."), &env_refs(&env), deadline)
}

/// Фильтры (`filter.<имя>.clean/smudge/process`) из конфига: `git status`/`diff` запускают их
/// для файлов с атрибутом `filter=<имя>`. Отдаёт ключи для перекрытия пустой командой — git
/// тогда не фильтрует файл. Чтение конфига само ничего не запускает.
///
/// None — список получить не удалось (ошибка, таймаут, код не 0/1). Тогда вызывающий
/// НЕ запускает status/diff/ls-files вовсе: без перекрытий фильтр выполнился бы.
pub(crate) fn filter_overrides(cwd: &Path, deadline: Instant) -> Option<Vec<String>> {
  let c = cwd.to_str()?;
  let env = git_env(&[], &[]);
  let args = git_args(c, &["config", "-z", "--name-only", "--get-regexp", FILTER_RE]);
  // Код 1 — совпадений нет: это тоже ответ («фильтров нет»).
  let (names, code) = run_cmd_code(git_bin(), &args, Path::new("."), &env_refs(&env), deadline)?;
  matches!(code, Some(0 | 1)).then(|| filter_overrides_from(&names))
}

/// Имена ключей `filter.<имя>.<команда>` (через NUL или перевод строки) → ключи
/// `filter.<имя>.clean/smudge/process` для перекрытия. Имя может содержать `.` и `=`.
fn filter_overrides_from(names: &str) -> Vec<String> {
  let mut drivers: Vec<&str> = names
    .split(['\0', '\n'])
    .filter_map(|k| k.strip_prefix("filter.")?.rsplit_once('.').map(|(name, _)| name))
    .collect();
  drivers.sort_unstable();
  drivers.dedup();
  drivers.into_iter().flat_map(|d| ["clean", "smudge", "process"].map(|c| format!("filter.{d}.{c}"))).collect()
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

/// Источник перекрытий фильтров (в тестах подменяется отказом).
pub(crate) type FilterLister = fn(&Path, Instant) -> Option<Vec<String>>;

pub fn git_info_at(cwd: &Path) -> GitInfo {
  git_info_with(cwd, filter_overrides)
}

fn git_info_with(cwd: &Path, list_filters: FilterLister) -> GitInfo {
  let prep = Instant::now() + PREP_TIMEOUT;
  let Some(root) = run_git(cwd, &["rev-parse", "--show-toplevel"], prep).filter(|s| !s.is_empty()) else {
    return GitInfo::default();
  };
  let branch = run_git(cwd, &["branch", "--show-current"], prep)
    .filter(|s| !s.is_empty())
    .or_else(|| run_git(cwd, &["rev-parse", "--short", "HEAD"], prep).filter(|s| !s.is_empty()));
  // Список фильтров не получен — status не запускаем вовсе (fail closed): без перекрытий
  // `git status` выполнил бы clean-фильтр из чужого конфига.
  let Some(filters) = list_filters(cwd, prep) else { return GitInfo { root: Some(root), branch, dirty: false } };
  let Some(c) = cwd.to_str() else { return GitInfo { root: Some(root), branch, dirty: false } };
  let env = git_env(&filters, &[]);
  let env = env_refs(&env);
  // Отслеживаемые изменения — без обхода неотслеживаемых (в большом репозитории он не успевал
  // за дедлайн) и без подмодулей (их конфиг с фильтрами не перекрыт). Дедлайн — свой, полный.
  let args = git_args(c, &["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"]);
  let tracked = run_cmd(git_bin(), &args, Path::new("."), &env, Instant::now() + GIT_TIMEOUT);
  let mut dirty = tracked.is_some_and(|s| !s.is_empty());
  if !dirty {
    // Неотслеживаемые: хватает первого (потолок вывода в 1 байт — git сразу останавливается),
    // `--directory` не спускается в неотслеживаемые папки.
    let args = git_args(c, &["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory"]);
    dirty = run_cmd_capped(git_bin(), &args, Path::new("."), &env, Instant::now() + UNTRACKED_TIMEOUT, 1).is_some_and(|(s, _)| !s.is_empty());
  }
  GitInfo { root: Some(root), branch, dirty }
}

/// git-подпроцессы — в пуле блокирующих задач: не в главном потоке и не в рабочих потоках tokio.
#[tauri::command]
pub async fn git_info(cwd: String) -> GitInfo {
  tauri::async_runtime::spawn_blocking(move || git_info_at(Path::new(&cwd))).await.unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  #[test]
  fn pick_git_skips_broken_candidates() {
    // Из Finder PATH = /usr/bin:…, а /usr/bin/git без Command Line Tools — нерабочая заглушка.
    let works = |p: &str| p == "/opt/homebrew/bin/git";
    assert_eq!(pick_git(&["git", "/opt/homebrew/bin/git", "/usr/bin/git"], works), Some("/opt/homebrew/bin/git"));
    assert_eq!(pick_git(&["git", "/opt/homebrew/bin/git"], |_| true), Some("git"));
    assert_eq!(pick_git(&["git"], |_| false), None);
  }

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
    let a = git_args("/r", &["status", "--porcelain"]);
    #[rustfmt::skip]
    let want = [
      "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false",
      "-c", "protocol.allow=never", "-C", "/r", "status", "--porcelain",
    ];
    assert_eq!(a, want);
    assert!(GIT_ENV.contains(&("GIT_CONFIG_NOSYSTEM", "1")));
    assert!(GIT_ENV.contains(&("GIT_OPTIONAL_LOCKS", "0")));
    assert!(GIT_ENV.contains(&("GIT_TERMINAL_PROMPT", "0")));
    assert!(GIT_ENV.contains(&("GIT_NO_LAZY_FETCH", "1")));
  }

  #[test]
  fn git_env_passes_overrides_whole() {
    let env = git_env(&["filter.a=b.clean".to_string()], &[("X", "1")]);
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(get("GIT_CONFIG_COUNT"), Some("1"));
    assert_eq!(get("GIT_CONFIG_KEY_0"), Some("filter.a=b.clean"));
    assert_eq!(get("GIT_CONFIG_VALUE_0"), Some(""));
    assert_eq!(get("X"), Some("1"));
    // Без перекрытий счётчик всё равно задан: унаследованные GIT_CONFIG_KEY_* не применяются.
    assert_eq!(git_env(&[], &[]).iter().find(|(n, _)| n == "GIT_CONFIG_COUNT").map(|(_, v)| v.as_str()), Some("0"));
  }

  #[test]
  fn filter_overrides_cover_every_driver() {
    let o = filter_overrides_from("filter.lfs.clean\0filter.lfs.process\0filter.a.b.smudge\0filter.x=y.clean\0");
    #[rustfmt::skip]
    let want = [
      "filter.a.b.clean", "filter.a.b.smudge", "filter.a.b.process",
      "filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.process",
      "filter.x=y.clean", "filter.x=y.smudge", "filter.x=y.process",
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

  /// Конфиг, изменённый после первого опроса, читается заново (кэша перекрытий нет).
  #[test]
  #[cfg(unix)]
  fn config_changed_later_is_seen() {
    let d = repo();
    let pwned = d.path().join("pwned");
    std::fs::write(d.path().join(".gitattributes"), "*.txt filter=late\n").unwrap();
    std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-m", "a"]);
    assert!(!git_info_at(d.path()).dirty);
    hostile_config(d.path(), &format!("[filter \"late\"]\n\tclean = \"touch '{}'; cat\"\n", pwned.display()));
    std::fs::write(d.path().join("a.txt"), "b\n").unwrap();
    assert!(git_info_at(d.path()).dirty);
    assert!(!pwned.exists(), "фильтр из изменённого конфига выполнился");
  }

  /// Репозиторий с изменённым файлом под `filter=<name>` и clean-фильтром, создающим метку.
  #[cfg(unix)]
  pub(crate) fn filtered_repo(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let d = repo();
    let pwned = d.path().join("pwned");
    std::fs::write(d.path().join(".gitattributes"), format!("*.txt filter={name}\n")).unwrap();
    std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-m", "a"]);
    hostile_config(d.path(), &format!("[filter \"{name}\"]\n\tclean = \"touch '{}'; cat\"\n", pwned.display()));
    std::fs::write(d.path().join("a.txt"), "b\n").unwrap();
    (d, pwned)
  }

  /// `=` в имени фильтра: `-c filter.a=b.clean=` git разобрал бы как ключ `filter.a`,
  /// перекрытие через окружение задаёт ключ целиком.
  #[test]
  #[cfg(unix)]
  fn filter_name_with_equals_does_not_run() {
    let (d, pwned) = filtered_repo("a=b");
    let i = git_info_at(d.path());
    assert!(i.dirty);
    assert!(!pwned.exists(), "фильтр с `=` в имени выполнился");
  }

  /// Список фильтров не получен — status/ls-files не запускаются (иначе фильтр выполнился бы).
  #[test]
  #[cfg(unix)]
  fn filter_list_failure_fails_closed() {
    let (d, pwned) = filtered_repo("evil");
    let i = git_info_with(d.path(), |_, _| None);
    assert!(i.root.is_some());
    assert!(!i.dirty);
    assert!(!pwned.exists(), "status запустился без перекрытий фильтров");
    // Настоящий список (код 0) — работает как обычно.
    assert!(filter_overrides(d.path(), Instant::now() + Duration::from_secs(2)).is_some_and(|v| v.len() == 3));
  }

  /// Нет ни одного фильтра (`git config` с кодом 1) — пустой список, а не отказ.
  #[test]
  fn no_filters_is_empty_list() {
    let d = repo();
    assert_eq!(filter_overrides(d.path(), Instant::now() + Duration::from_secs(2)), Some(vec![]));
    assert_eq!(filter_overrides(Path::new("/definitely/not/here/kv"), Instant::now() + Duration::from_secs(2)), None);
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

    // Перекрытие `-c` не спасает фильтр с `=` в имени — поэтому оно в окружении.
    let (d, pwned) = filtered_repo("a=b");
    let c = ["-c", "filter.a=b.clean=", "-c", "filter.a=b.process="];
    let _ = Command::new("git").args(c).arg("-C").arg(d.path()).args(["status", "--porcelain"]).output().unwrap();
    assert!(pwned.exists());
  }
}
