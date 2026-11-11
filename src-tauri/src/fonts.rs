use serde::Serialize;
use std::sync::OnceLock;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FontFamily {
  pub name: String,
  pub monospace: bool,
}

/// Семьи системных шрифтов: отсортированы по имени, без дублей.
pub fn list_families() -> Vec<FontFamily> {
  let mut db = fontdb::Database::new();
  db.load_system_fonts();
  let mut out: Vec<FontFamily> = Vec::new();
  for face in db.faces() {
    let Some((name, _)) = face.families.first() else { continue };
    match out.iter_mut().find(|f| &f.name == name) {
      Some(f) => f.monospace |= face.monospaced,
      None => out.push(FontFamily { name: name.clone(), monospace: face.monospaced }),
    }
  }
  out.sort_by(|a, b| a.name.cmp(&b.name));
  out
}

static CACHE: OnceLock<Vec<FontFamily>> = OnceLock::new();

/// Скан системных шрифтов дорогой: делаем один раз и вне главного потока.
#[tauri::command(async)]
pub fn fonts_list() -> Vec<FontFamily> {
  CACHE.get_or_init(list_families).clone()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fonts_list_has_known_families() {
    let list = list_families();
    assert!(!list.is_empty());
    assert!(list.windows(2).all(|w| w[0].name < w[1].name), "sorted, no duplicates");
  }
}
