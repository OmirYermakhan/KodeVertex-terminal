//! Доверие к папкам для Claude. `claude -p` (наш режим) не показывает диалог доверия CLI,
//! а `.claude/settings.json` склонированного репозитория может объявить хуки (SessionStart),
//! которые выполнились бы на первом же сообщении. Поэтому claude в папке запускается, только
//! если пользователь доверил её (или её родителя) у нас или в самом CLI.
//!
//! Контракт с фронтом: `claude_trust_check` → при false спросить пользователя →
//! `claude_trust_add` → `claude_start`. `claude_start` в недоверенной папке отвечает ровно
//! `Err("UNTRUSTED_DIR")`.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Ошибка `claude_start` в недоверенной папке (фронт показывает вопрос о доверии).
pub const UNTRUSTED_DIR: &str = "UNTRUSTED_DIR";
/// Наш список доверенных папок в каталоге данных приложения.
const FILE: &str = "trusted_dirs.json";
/// Потолок чтения `~/.claude.json` (в нём и история проектов — бывает в мегабайты).
const CLI_CONFIG_MAX: u64 = 64 * 1024 * 1024;

/// Откуда берётся доверие.
pub struct Sources<'a> {
  /// Наш список (канонические пути).
  pub ours: &'a [String],
  /// Разобранные конфиги CLI (`~/.claude.json`): `projects[<путь>].hasTrustDialogAccepted`.
  pub cli: &'a [Value],
  /// Домашняя папка: доверие к ней (и к `/`) не распространяется на вложенные папки.
  pub home: Option<&'a Path>,
}

/// Канонический путь папки; нет папки — та же ошибка, что у `claude_start`.
fn canonical(dir: &Path) -> Result<PathBuf, String> {
  dir.canonicalize().ok().filter(|p| p.is_dir()).ok_or_else(|| format!("Каталог {} не существует", dir.display()))
}

/// CLI доверяет папке `key` (ключ — путь строкой, как его пишет CLI).
fn cli_trusts(cli: &[Value], key: &str) -> bool {
  cli.iter().any(|v| v.get("projects").and_then(|p| p.get(key)).and_then(|p| p.get("hasTrustDialogAccepted")).and_then(Value::as_bool) == Some(true))
}

/// Доверена ли папка: она сама или её родитель — в нашем списке или доверен в CLI. Проверяются
/// и канонический путь, и исходный (CLI мог записать путь без разрешения ссылок). Доверие к
/// домашней папке и к `/` — только для них самих: иначе одно «доверяю ~» открыло бы хукам любой
/// репозиторий, склонированный в `~/Downloads`.
pub fn is_trusted(dir: &Path, canonical: &Path, src: &Sources) -> bool {
  let raw = dir.is_absolute().then_some(dir);
  [Some(canonical), raw].into_iter().flatten().any(|p| {
    p.ancestors().enumerate().any(|(i, a)| {
      let broad = a.parent().is_none() || src.home.is_some_and(|h| h == a);
      if i > 0 && broad {
        return false;
      }
      src.ours.iter().any(|o| Path::new(o) == a) || a.to_str().is_some_and(|k| cli_trusts(src.cli, k))
    })
  })
}

/// Наш список из файла. Нет файла или он битый — пусто (недоверие по умолчанию).
fn load_list(path: &Path) -> Vec<String> {
  std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok()).unwrap_or_default()
}

/// Конфиг CLI, только чтение (никогда не пишем). Нет, слишком большой, битый — None.
fn load_cli(path: &Path) -> Option<Value> {
  use std::io::Read;
  let mut buf = Vec::new();
  std::fs::File::open(path).ok()?.take(CLI_CONFIG_MAX + 1).read_to_end(&mut buf).ok()?;
  if buf.len() as u64 > CLI_CONFIG_MAX {
    return None;
  }
  serde_json::from_slice(&buf).ok()
}

/// Конфиги CLI: `$CLAUDE_CONFIG_DIR/.claude.json` (если задан) и `~/.claude.json`.
fn cli_config_paths(home: Option<&Path>) -> Vec<PathBuf> {
  let mut v: Vec<PathBuf> = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()).map(|d| PathBuf::from(d).join(".claude.json")).into_iter().collect();
  v.extend(home.map(|h| h.join(".claude.json")));
  v
}

/// Проверка с явными путями к нашему списку и конфигам CLI (тесты не трогают настоящий дом).
pub fn check_at(dir: &Path, store: &Path, cli_files: &[PathBuf], home: Option<&Path>) -> Result<bool, String> {
  let canon = canonical(dir)?;
  let ours = load_list(store);
  let cli: Vec<Value> = cli_files.iter().filter_map(|p| load_cli(p)).collect();
  let home = home.and_then(|h| h.canonicalize().ok());
  Ok(is_trusted(dir, &canon, &Sources { ours: &ours, cli: &cli, home: home.as_deref() }))
}

/// Добавляет папку (канонический путь) в наш список; запись атомарная.
pub fn add_at(dir: &Path, store: &Path) -> Result<(), String> {
  static LOCK: Mutex<()> = Mutex::new(());
  let canon = canonical(dir)?;
  let s = canon.to_str().ok_or("Путь не в UTF-8")?.to_string();
  let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
  // Битый файл не затираем молча: копия рядом, затем новый список.
  if store.exists() && std::fs::read(store).ok().and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok()).is_none() {
    let _ = std::fs::copy(store, store.with_extension("json.bak"));
  }
  let mut list = load_list(store);
  if list.contains(&s) {
    return Ok(());
  }
  list.push(s);
  let text = serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?;
  crate::settings::atomic_write(store, &text)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_data_dir().map(|d| d.join(FILE)).map_err(|e| e.to_string())
}

/// Доверена ли папка (для `claude_start` и `claude_trust_check`).
pub fn check(app: &AppHandle, dir: &Path) -> Result<bool, String> {
  let home = dirs::home_dir();
  check_at(dir, &store_path(app)?, &cli_config_paths(home.as_deref()), home.as_deref())
}

/// `Ok(())` — можно запускать claude в `dir`; недоверенная папка — `Err("UNTRUSTED_DIR")`.
pub fn ensure(app: &AppHandle, dir: &Path) -> Result<(), String> {
  if check(app, dir)? { Ok(()) } else { Err(UNTRUSTED_DIR.to_string()) }
}

#[tauri::command]
pub async fn claude_trust_check(app: AppHandle, path: String) -> Result<bool, String> {
  crate::blocking(move || check(&app, Path::new(&path))).await?
}

#[tauri::command]
pub async fn claude_trust_add(app: AppHandle, path: String) -> Result<(), String> {
  crate::blocking(move || add_at(Path::new(&path), &store_path(&app)?)).await?
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn src<'a>(ours: &'a [String], cli: &'a [Value], home: Option<&'a Path>) -> Sources<'a> {
    Sources { ours, cli, home }
  }

  fn t(dir: &str, s: &Sources) -> bool {
    is_trusted(Path::new(dir), Path::new(dir), s)
  }

  #[test]
  fn ancestor_in_our_list_trusts_subdirs() {
    let ours = vec!["/Users/u/work".to_string()];
    let s = src(&ours, &[], Some(Path::new("/Users/u")));
    assert!(t("/Users/u/work", &s));
    assert!(t("/Users/u/work/a/b", &s));
    assert!(!t("/Users/u/workshop", &s), "префикс строки — не родитель");
    assert!(!t("/Users/u", &s));
    assert!(!t("/Users/u/other", &s));
  }

  #[test]
  fn home_and_root_trust_only_themselves() {
    let ours = vec!["/Users/u".to_string(), "/".to_string()];
    let s = src(&ours, &[], Some(Path::new("/Users/u")));
    assert!(t("/Users/u", &s));
    assert!(t("/", &s));
    assert!(!t("/Users/u/Downloads/evil", &s));
    assert!(!t("/tmp/x", &s));
    // Так же для доверия, взятого из CLI.
    let cli = vec![json!({"projects": {"/Users/u": {"hasTrustDialogAccepted": true}}})];
    let s = src(&[], &cli, Some(Path::new("/Users/u")));
    assert!(t("/Users/u", &s));
    assert!(!t("/Users/u/Downloads/evil", &s));
  }

  #[test]
  fn cli_trust_is_read_from_projects() {
    let cli = vec![json!({"projects": {
      "/w/ok": {"hasTrustDialogAccepted": true},
      "/w/no": {"hasTrustDialogAccepted": false},
      "/w/missing": {"allowedTools": []},
      "/w/str": {"hasTrustDialogAccepted": "true"}
    }})];
    let s = src(&[], &cli, None);
    assert!(t("/w/ok", &s));
    assert!(t("/w/ok/sub", &s));
    assert!(!t("/w/no", &s));
    assert!(!t("/w/missing", &s));
    assert!(!t("/w/str", &s));
    assert!(!t("/w", &s));
    assert!(!t("/elsewhere", &src(&[], &[json!({}), json!([1, 2])], None)));
  }

  /// Исходный путь тоже проверяется: CLI мог записать `/tmp/x`, а канонический — `/private/tmp/x`.
  #[test]
  fn raw_and_canonical_paths_both_count() {
    let cli = vec![json!({"projects": {"/tmp/x": {"hasTrustDialogAccepted": true}}})];
    let s = src(&[], &cli, None);
    assert!(is_trusted(Path::new("/tmp/x/a"), Path::new("/private/tmp/x/a"), &s));
    let ours = vec!["/private/tmp/x".to_string()];
    let s = src(&ours, &[], None);
    assert!(is_trusted(Path::new("/tmp/x/a"), Path::new("/private/tmp/x/a"), &s));
    assert!(!is_trusted(Path::new("/tmp/y"), Path::new("/private/tmp/y"), &s));
  }

  #[test]
  fn files_add_then_check_and_bad_files_fail_closed() {
    let d = tempfile::tempdir().unwrap();
    let store = d.path().join("data/trusted_dirs.json");
    let repo = d.path().join("repo");
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    let cli = d.path().join(".claude.json");
    assert!(!check_at(&repo, &store, std::slice::from_ref(&cli), None).unwrap());
    add_at(&repo, &store).unwrap();
    add_at(&repo, &store).unwrap();
    assert_eq!(load_list(&store).len(), 1, "повтор не дублирует");
    assert!(check_at(&repo.join("sub"), &store, &[], None).unwrap());
    // Нет папки — ошибка, а не «недоверена».
    assert!(check_at(&d.path().join("nope"), &store, &[], None).unwrap_err().contains("не существует"));
    assert!(add_at(&d.path().join("nope"), &store).is_err());
    // Битый наш список — недоверие; при добавлении копия сохраняется.
    std::fs::write(&store, "{oops").unwrap();
    assert!(!check_at(&repo, &store, &[], None).unwrap());
    add_at(&repo, &store).unwrap();
    assert!(store.with_extension("json.bak").exists());
    assert!(check_at(&repo, &store, &[], None).unwrap());
  }

  #[test]
  fn cli_file_grants_trust_and_is_never_written() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("repo")).unwrap();
    let repo = d.path().join("repo").canonicalize().unwrap();
    let cli = d.path().join(".claude.json");
    let body = serde_json::to_string(&json!({"projects": {repo.to_str().unwrap(): {"hasTrustDialogAccepted": true}}})).unwrap();
    std::fs::write(&cli, &body).unwrap();
    let store = d.path().join("trusted_dirs.json");
    assert!(check_at(&repo, &store, std::slice::from_ref(&cli), None).unwrap());
    assert_eq!(std::fs::read_to_string(&cli).unwrap(), body);
    assert!(!store.exists());
    // Битый конфиг CLI — просто не источник доверия.
    std::fs::write(&cli, "not json").unwrap();
    assert!(!check_at(&repo, &store, std::slice::from_ref(&cli), None).unwrap());
  }
}
