use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Путь к конфигу: ~/.config/kodevertex-terminal/settings.toml
pub fn config_path() -> Option<PathBuf> {
  dirs::home_dir().map(|h| h.join(".config").join("kodevertex-terminal").join("settings.toml"))
}

/// Читает TOML-файл как JSON. Нет файла — `Ok(None)`. Битый (не TOML, не UTF-8) — копия
/// рядом в `settings.toml.bak` и `Err` с ошибкой разбора: фронт не должен молча перезаписать
/// файл пользователя (с его запусками) настройками по умолчанию.
pub fn load_from(path: &Path) -> Result<Option<Value>, String> {
  let bytes = match std::fs::read(path) {
    Ok(b) => b,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("не удалось прочитать {}: {e}", path.display())),
  };
  let parsed = std::str::from_utf8(&bytes)
    .map_err(|e| e.to_string())
    .and_then(|text| toml::from_str::<Value>(text).map_err(|e| e.to_string()));
  parsed.map(Some).map_err(|e| {
    let bak = path.with_extension("toml.bak");
    let saved = match std::fs::copy(path, &bak) {
      Ok(_) => format!("копия — {}", bak.display()),
      Err(c) => format!("копию сохранить не удалось: {c}"),
    };
    format!("{} повреждён ({saved}): {e}", path.display())
  })
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Атомарная запись: временный файл с уникальным именем (create_new) в той же папке,
/// sync_all, затем rename. Две записи подряд не пишут в один временный файл, а после сбоя
/// питания на месте файла — либо старое содержимое, либо новое целиком.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let parent = path.parent().ok_or("нет родительской папки")?;
  std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
  let tmp = parent.join(format!(".{name}.kv-{}-{seq}-{nanos}.tmp", std::process::id()));
  let write = || -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
  };
  write().map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    e.to_string()
  })
}

/// Атомарная запись настроек (см. `atomic_write`).
pub fn save_to(path: &Path, v: &Value) -> Result<(), String> {
  let text = toml::to_string_pretty(v).map_err(|e| e.to_string())?;
  atomic_write(path, text.as_bytes())
}

/// Нет файла — `Ok(None)`; битый — `Err(текст ошибки)`, файл скопирован в `settings.toml.bak`.
#[tauri::command]
pub async fn settings_load() -> Result<Option<Value>, String> {
  let Some(path) = config_path() else { return Ok(None) };
  crate::blocking(move || load_from(&path)).await?
}

#[tauri::command]
pub async fn settings_save(value: Value) -> Result<(), String> {
  let path = config_path().ok_or("не найдена домашняя папка")?;
  crate::blocking(move || save_to(&path, &value)).await?
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn launchers_roundtrip() {
    let d = tmp("launchers");
    let p = d.join("settings.toml");
    let v = json!({"theme": "as", "launchers": [{"id": "a", "name": "prod", "command": "ssh u@h", "icon": "server", "color": "#4f8cff"}], "textSize": 16, "z": true});
    save_to(&p, &v).unwrap();
    assert_eq!(load_from(&p).unwrap(), Some(v));
    let _ = std::fs::remove_dir_all(&d);
  }

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
    assert_eq!(load_from(&p), Ok(Some(v)));
  }

  #[test]
  fn load_missing_returns_none() {
    assert_eq!(load_from(&tmp("missing").join("nope.toml")), Ok(None));
  }

  #[test]
  fn load_corrupt_is_error_and_backed_up() {
    let d = tmp("corrupt");
    std::fs::create_dir_all(&d).unwrap();
    let p = d.join("settings.toml");
    std::fs::write(&p, "=== not toml").unwrap();
    let e = load_from(&p).unwrap_err();
    assert!(e.contains("settings.toml"), "{e}");
    // Сам файл не тронут, рядом — копия.
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "=== not toml");
    assert_eq!(std::fs::read_to_string(d.join("settings.toml.bak")).unwrap(), "=== not toml");
    // Не UTF-8 — тоже повреждён.
    std::fs::write(&p, b"theme = \"\xff\"").unwrap();
    assert!(load_from(&p).is_err());
  }

  #[test]
  fn save_leaves_no_temp_files() {
    let d = tmp("tmpfiles");
    let p = d.join("settings.toml");
    for i in 0..3 {
      save_to(&p, &json!({"n": i})).unwrap();
    }
    let names: Vec<_> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("settings.toml")]);
    assert_eq!(load_from(&p), Ok(Some(json!({"n": 2}))));
  }

  #[test]
  fn save_creates_parent_dirs() {
    let p = tmp("dirs").join("a/b/c/settings.toml");
    save_to(&p, &json!({"theme":"as"})).unwrap();
    assert!(p.exists());
  }
}
