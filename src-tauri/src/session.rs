// Сохранённая сессия окна (вкладки, панели, каталоги, Claude-сессии, лента): JSON в папке данных
// приложения. Формат и версию знает фронтенд; здесь — атомарная запись, предел размера и `.bak`.
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Больше — не пишем (фронтенд урезает ленту до записи; это страховка).
pub const MAX_BYTES: usize = 24 * 1024 * 1024;
const FILE: &str = "session.json";

fn session_path(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_data_dir().ok().map(|d| d.join(FILE))
}

/// Читает файл сессии. Нет файла — `None`; битый — переименовывается в `.bak`, тоже `None`.
pub fn load_from(path: &Path) -> Option<Value> {
  let text = std::fs::read_to_string(path).ok()?;
  match serde_json::from_str::<Value>(&text) {
    Ok(v) if v.is_object() => Some(v),
    _ => {
      let _ = std::fs::rename(path, path.with_extension("json.bak"));
      None
    }
  }
}

/// Атомарная запись: временный файл рядом, затем rename. Текст должен быть JSON-объектом.
pub fn save_to(path: &Path, text: &str) -> Result<(), String> {
  if text.len() > MAX_BYTES {
    return Err(format!("сессия больше {} МБ", MAX_BYTES / 1024 / 1024));
  }
  let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
  if !v.is_object() {
    return Err("сессия — не объект".into());
  }
  let parent = path.parent().ok_or("нет родительской папки")?;
  std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  let tmp = path.with_extension("json.tmp");
  std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, path).map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    e.to_string()
  })
}

#[tauri::command]
pub fn session_load(app: AppHandle) -> Option<Value> {
  load_from(&session_path(&app)?)
}

#[tauri::command]
pub fn session_save(app: AppHandle, text: String) -> Result<(), String> {
  let path = session_path(&app).ok_or("не найдена папка данных приложения")?;
  save_to(&path, &text)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn save_then_load_roundtrip() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("a").join(FILE);
    save_to(&p, r#"{"version":1,"tabs":[]}"#).unwrap();
    assert_eq!(load_from(&p), Some(json!({"version":1,"tabs":[]})));
    assert!(!p.with_extension("json.tmp").exists());
  }

  #[test]
  fn missing_is_none() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(load_from(&d.path().join(FILE)), None);
  }

  #[test]
  fn corrupt_is_none_and_kept_as_bak() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(FILE);
    std::fs::write(&p, "{ not json").unwrap();
    assert_eq!(load_from(&p), None);
    assert!(!p.exists());
    assert_eq!(std::fs::read_to_string(p.with_extension("json.bak")).unwrap(), "{ not json");
  }

  #[test]
  fn non_object_is_corrupt() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(FILE);
    std::fs::write(&p, "[1,2]").unwrap();
    assert_eq!(load_from(&p), None);
    assert!(p.with_extension("json.bak").exists());
  }

  #[test]
  fn save_rejects_invalid_and_oversized() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(FILE);
    assert!(save_to(&p, "nope").is_err());
    assert!(save_to(&p, "[]").is_err());
    let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_BYTES));
    assert!(save_to(&p, &big).is_err());
    assert!(!p.exists());
  }
}
