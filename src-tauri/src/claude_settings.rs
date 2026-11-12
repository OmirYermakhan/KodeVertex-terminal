// Модель и усилие «по умолчанию» для новых сессий Claude Code — как делает `/model` в TUI:
// `model` и `modelSettings.<id модели>.effortLevel` в ~/.claude/settings.json (остальные ключи не трогаем).
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::claude::EFFORTS;

/// `$CLAUDE_CONFIG_DIR/settings.json`, иначе `~/.claude/settings.json`.
fn settings_path() -> Option<PathBuf> {
  if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
    return Some(PathBuf::from(d).join("settings.json"));
  }
  dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// Что записать: `model` — псевдоним (`fable`), None — убрать (по умолчанию Claude Code);
/// `effort` — уровень для модели `model_id` (полное имя, `claude-fable-5-2`).
#[derive(Debug, Default, Clone)]
pub struct Defaults {
  pub model: Option<String>,
  pub model_id: Option<String>,
  pub effort: Option<String>,
}

/// Новый JSON настроек: `current` — содержимое файла (None — файла нет). Неверный JSON — ошибка,
/// файл тогда не перезаписывается.
pub fn merge(current: Option<&str>, d: &Defaults) -> Result<String, String> {
  let mut root: Map<String, Value> = match current.map(str::trim).filter(|s| !s.is_empty()) {
    None => Map::new(),
    Some(text) => match serde_json::from_str::<Value>(text) {
      Ok(Value::Object(m)) => m,
      Ok(_) => return Err("в файле настроек Claude Code не объект JSON — файл не изменён".into()),
      Err(e) => return Err(format!("файл настроек Claude Code — неверный JSON ({e}), файл не изменён")),
    },
  };
  match d.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
    Some(m) => {
      root.insert("model".into(), Value::String(m.into()));
    }
    None => {
      root.remove("model");
    }
  }
  if let Some(effort) = d.effort.as_deref() {
    if !EFFORTS.contains(&effort) {
      return Err(format!("неизвестный уровень усилия: {effort}"));
    }
    let id = d.model_id.as_deref().filter(|s| !s.is_empty()).ok_or("неизвестна модель для уровня усилия")?;
    const NOT_OBJECT: &str = "modelSettings в настройках Claude Code — не объект, файл не изменён";
    let ms = root.entry("modelSettings").or_insert_with(|| Value::Object(Map::new()));
    let ms = ms.as_object_mut().ok_or(NOT_OBJECT)?;
    let per = ms.entry(id.to_string()).or_insert_with(|| Value::Object(Map::new()));
    let per = per.as_object_mut().ok_or(NOT_OBJECT)?;
    per.insert("effortLevel".into(), Value::String(effort.into()));
  }
  let mut out = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?;
  out.push('\n');
  Ok(out)
}

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Читает, сливает и атомарно пишет настройки: временный файл (уникальное имя, create_new) в каталоге
/// настоящего файла + rename на него. Символическая ссылка остаётся ссылкой — пишется её цель.
pub fn save_to(path: &Path, d: &Defaults) -> Result<(), String> {
  let path = &std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
  let current = match std::fs::read_to_string(path) {
    Ok(s) => Some(s),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
    Err(e) => return Err(format!("не удалось прочитать {}: {e}", path.display())),
  };
  let text = merge(current.as_deref(), d)?;
  let dir = path.parent().ok_or("нет каталога настроек")?;
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
  let tmp = dir.join(format!(".settings.json.kv-{}-{seq}-{nanos}", std::process::id()));
  let write = || -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    // Права исходного файла сохраняем.
    if let Ok(meta) = std::fs::metadata(path) {
      f.set_permissions(meta.permissions())?;
    }
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
  };
  write().map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    format!("не удалось записать {}: {e}", path.display())
  })
}

#[tauri::command]
pub async fn claude_save_defaults(model: Option<String>, model_id: Option<String>, effort: Option<String>) -> Result<(), String> {
  let path = settings_path().ok_or("не найден домашний каталог")?;
  tauri::async_runtime::spawn_blocking(move || save_to(&path, &Defaults { model, model_id, effort }))
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn d(model: Option<&str>, id: Option<&str>, effort: Option<&str>) -> Defaults {
    Defaults { model: model.map(Into::into), model_id: id.map(Into::into), effort: effort.map(Into::into) }
  }

  fn parse(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
  }

  #[test]
  fn sets_model_and_keeps_unknown_keys() {
    let cur = r#"{"theme":"dark","env":{"A":"1"},"model":"opus"}"#;
    let v = parse(&merge(Some(cur), &d(Some("fable"), None, None)).unwrap());
    assert_eq!(v["model"], "fable");
    assert_eq!(v["theme"], "dark");
    assert_eq!(v["env"]["A"], "1");
  }

  #[test]
  fn none_model_removes_override() {
    let v = parse(&merge(Some(r#"{"model":"opus","x":1}"#), &d(None, None, None)).unwrap());
    assert!(v.get("model").is_none());
    assert_eq!(v["x"], 1);
  }

  #[test]
  fn effort_goes_to_model_settings_and_merges() {
    let cur = r#"{"modelSettings":{"claude-opus-5-5":{"effortLevel":"medium","other":true}}}"#;
    let v = parse(&merge(Some(cur), &d(Some("opus"), Some("claude-opus-5-5"), Some("high"))).unwrap());
    assert_eq!(v["modelSettings"]["claude-opus-5-5"]["effortLevel"], "high");
    assert_eq!(v["modelSettings"]["claude-opus-5-5"]["other"], true);
    let v = parse(&merge(Some(cur), &d(Some("fable"), Some("claude-fable-5-2"), Some("max"))).unwrap());
    assert_eq!(v["modelSettings"]["claude-opus-5-5"]["effortLevel"], "medium");
    assert_eq!(v["modelSettings"]["claude-fable-5-2"]["effortLevel"], "max");
  }

  #[test]
  fn key_order_is_kept() {
    let out = merge(Some(r#"{"z":1,"model":"opus","a":2}"#), &d(Some("fable"), None, None)).unwrap();
    let z = out.find("\"z\"").unwrap();
    let m = out.find("\"model\"").unwrap();
    let a = out.find("\"a\"").unwrap();
    assert!(z < m && m < a, "{out}");
  }

  #[test]
  fn invalid_input_is_error() {
    assert!(merge(Some("{oops"), &d(Some("opus"), None, None)).is_err());
    assert!(merge(Some("[1,2]"), &d(Some("opus"), None, None)).is_err());
    assert!(merge(Some("{}"), &d(Some("opus"), Some("m"), Some("huge"))).is_err());
    assert!(merge(Some("{}"), &d(Some("opus"), None, Some("high"))).is_err());
  }

  #[test]
  fn non_object_model_settings_is_error() {
    assert!(merge(Some(r#"{"modelSettings":[1]}"#), &d(Some("opus"), Some("m"), Some("high"))).is_err());
    assert!(merge(Some(r#"{"modelSettings":{"m":"x"}}"#), &d(Some("opus"), Some("m"), Some("high"))).is_err());
    // Без усилия modelSettings не трогаем — и не проверяем.
    assert!(merge(Some(r#"{"modelSettings":[1]}"#), &d(Some("opus"), None, None)).is_ok());
  }

  #[test]
  fn symlink_stays_link_and_target_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let real_dir = dir.path().join("dotfiles");
    std::fs::create_dir(&real_dir).unwrap();
    let target = real_dir.join("settings.json");
    std::fs::write(&target, r#"{"theme":"dark"}"#).unwrap();
    let link = dir.path().join("settings.json");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    save_to(&link, &d(Some("fable"), None, None)).unwrap();
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    let v = parse(&std::fs::read_to_string(&target).unwrap());
    assert_eq!(v["model"], "fable");
    assert_eq!(v["theme"], "dark");
    // Временных файлов нет ни рядом со ссылкой, ни у цели.
    assert_eq!(std::fs::read_dir(&real_dir).unwrap().count(), 1);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
  }

  #[test]
  fn concurrent_saves_both_succeed_and_leave_valid_json() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("settings.json");
    std::fs::write(&p, "{}").unwrap();
    let hs: Vec<_> = ["opus", "haiku", "sonnet", "fable"]
      .into_iter()
      .map(|m| {
        let p = p.clone();
        std::thread::spawn(move || save_to(&p, &d(Some(m), None, None)))
      })
      .collect();
    for h in hs {
      h.join().unwrap().unwrap();
    }
    let v = parse(&std::fs::read_to_string(&p).unwrap());
    assert!(["opus", "haiku", "sonnet", "fable"].contains(&v["model"].as_str().unwrap()));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
  }

  #[test]
  fn missing_or_empty_file_starts_from_scratch() {
    assert_eq!(parse(&merge(None, &d(Some("haiku"), None, None)).unwrap()), serde_json::json!({ "model": "haiku" }));
    assert_eq!(parse(&merge(Some("  \n"), &d(None, None, None)).unwrap()), serde_json::json!({}));
  }

  #[test]
  fn save_writes_atomically_and_leaves_invalid_file_alone() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("sub").join("settings.json");
    save_to(&p, &d(Some("sonnet"), Some("claude-sonnet-5-5"), Some("low"))).unwrap();
    let v = parse(&std::fs::read_to_string(&p).unwrap());
    assert_eq!(v["model"], "sonnet");
    assert_eq!(v["modelSettings"]["claude-sonnet-5-5"]["effortLevel"], "low");
    // Временных файлов не осталось.
    assert_eq!(std::fs::read_dir(p.parent().unwrap()).unwrap().count(), 1);

    std::fs::write(&p, "{broken").unwrap();
    assert!(save_to(&p, &d(Some("opus"), None, None)).is_err());
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "{broken");
  }
}
