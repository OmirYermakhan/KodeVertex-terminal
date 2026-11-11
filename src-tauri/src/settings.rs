use serde_json::Value;
use std::path::{Path, PathBuf};

/// Путь к конфигу: ~/.config/kodevertex-terminal/settings.toml
pub fn config_path() -> Option<PathBuf> {
  dirs::home_dir().map(|h| h.join(".config").join("kodevertex-terminal").join("settings.toml"))
}

/// Читает TOML-файл как JSON. Нет файла или он битый — `None`.
pub fn load_from(path: &Path) -> Option<Value> {
  let text = std::fs::read_to_string(path).ok()?;
  toml::from_str::<Value>(&text).ok()
}

/// Атомарная запись: временный файл рядом, затем rename.
pub fn save_to(path: &Path, v: &Value) -> Result<(), String> {
  let text = toml::to_string_pretty(v).map_err(|e| e.to_string())?;
  let parent = path.parent().ok_or("нет родительской папки")?;
  std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  let tmp = path.with_extension("toml.tmp");
  std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, path).map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    e.to_string()
  })
}

#[tauri::command]
pub fn settings_load() -> Option<Value> {
  load_from(&config_path()?)
}

#[tauri::command]
pub fn settings_save(value: Value) -> Result<(), String> {
  let path = config_path().ok_or("не найдена домашняя папка")?;
  save_to(&path, &value)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("kv-settings-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
  }

  #[test]
  fn save_then_load_roundtrip() {
    let p = tmp("rt").join("settings.toml");
    let v = json!({"theme":"kv","textSize":18});
    save_to(&p, &v).unwrap();
    assert!(std::fs::read_to_string(&p).unwrap().contains("theme"));
    assert_eq!(load_from(&p), Some(v));
  }

  #[test]
  fn load_missing_returns_none() {
    assert_eq!(load_from(&tmp("missing").join("nope.toml")), None);
  }

  #[test]
  fn load_corrupt_returns_null() {
    let d = tmp("corrupt");
    std::fs::create_dir_all(&d).unwrap();
    let p = d.join("settings.toml");
    std::fs::write(&p, "=== not toml").unwrap();
    assert_eq!(load_from(&p), None);
  }

  #[test]
  fn save_creates_parent_dirs() {
    let p = tmp("dirs").join("a/b/c/settings.toml");
    save_to(&p, &json!({"theme":"as"})).unwrap();
    assert!(p.exists());
  }
}
