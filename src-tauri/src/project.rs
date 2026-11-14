//! Панель проекта: список папки и чтение файла строго внутри корня проекта.
//! Только просмотр — ничего не меняем. Пути от фронта относительные к корню.

use crate::git::{git_args, run_cmd, GIT_ENV};
use crate::preview::{io_message, looks_binary};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Записей в одной папке не больше; остаток — в `more`.
const LIST_MAX: usize = 2000;
/// Файл читаем не дальше этого размера и числа строк.
const READ_MAX_BYTES: u64 = 2 * 1024 * 1024;
const READ_MAX_LINES: usize = 20_000;
/// Сколько байт смотрим, чтобы понять, что файл двоичный.
const SNIFF: usize = 8192;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  pub name: String,
  pub is_dir: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirList {
  pub entries: Vec<Entry>,
  pub more: u32,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileText {
  #[serde(rename_all = "camelCase")]
  Text { lines: Vec<String>, truncated: bool, size: u64 },
  Binary { size: u64 },
  Missing,
  Error { message: String },
}

/// Путь `rel` (относительный к `root`) в канонизированном виде; None, если он выходит за корень
/// (`..`, абсолютный путь, симлинк наружу) или не существует.
pub fn inside_root(root: &Path, rel: &str) -> Option<PathBuf> {
  let rel_path = Path::new(rel);
  if rel_path.is_absolute() || has_parent(rel_path) {
    return None;
  }
  let root = root.canonicalize().ok()?;
  let full = root.join(rel_path).canonicalize().ok()?;
  full.starts_with(&root).then_some(full)
}

fn has_parent(p: &Path) -> bool {
  p.components().any(|c| matches!(c, Component::ParentDir))
}

/// Корень проекта: toplevel git-репозитория или сам `cwd`.
pub fn project_root_at(cwd: &Path) -> String {
  let deadline = Instant::now() + GIT_TIMEOUT;
  let top = cwd.to_str().and_then(|c| {
    let args = git_args(c, &[], &["rev-parse", "--show-toplevel"]);
    run_cmd("git", &args, Path::new("."), GIT_ENV, deadline)
  });
  match top.filter(|s| !s.is_empty()) {
    Some(t) => t,
    None => cwd.to_string_lossy().into_owned(),
  }
}

pub fn list_dir(root: &Path, rel: &str) -> Result<DirList, String> {
  let dir = inside_root(root, rel).ok_or_else(|| "Путь вне проекта".to_string())?;
  let rd = fs::read_dir(&dir).map_err(|e| io_message(&e))?;
  let mut all: Vec<Entry> = rd
    .filter_map(Result::ok)
    .filter_map(|e| {
      let name = e.file_name().to_string_lossy().into_owned();
      if name == ".git" {
        return None;
      }
      // Тип берём из записи каталога; metadata (с переходом по ссылке) — только для симлинков.
      // Симлинк на папку показываем папкой; битый — файлом.
      let ft = e.file_type().ok()?;
      let is_dir = if ft.is_symlink() { fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false) } else { ft.is_dir() };
      Some(Entry { name, is_dir })
    })
    .collect();
  all.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase(), e.name.clone()));
  let more = all.len().saturating_sub(LIST_MAX) as u32;
  all.truncate(LIST_MAX);
  Ok(DirList { entries: all, more })
}

pub fn read_file(root: &Path, rel: &str) -> FileText {
  let Some(path) = inside_root(root, rel) else {
    // Несуществующий файл — не ошибка (его могли удалить); всё остальное, включая `..`,
    // — выход за корень (иначе по Missing/Error можно узнать, что лежит снаружи).
    let rp = Path::new(rel);
    let exists = root.join(rp).symlink_metadata().is_ok();
    return if rp.is_absolute() || has_parent(rp) || exists { FileText::Error { message: "Путь вне проекта".to_string() } } else { FileText::Missing };
  };
  // O_NONBLOCK: открытие FIFO, подложенного вместо файла, не повиснет; тип проверяем по открытому дескриптору.
  let f = match fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&path) {
    Ok(f) => f,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FileText::Missing,
    Err(e) => return FileText::Error { message: io_message(&e) },
  };
  let meta = match f.metadata() {
    Ok(m) => m,
    Err(e) => return FileText::Error { message: io_message(&e) },
  };
  if meta.is_dir() {
    return FileText::Error { message: "Это папка".to_string() };
  }
  // FIFO, устройство: чтение может не закончиться.
  if !meta.is_file() {
    return FileText::Error { message: "Особый файл".to_string() };
  }
  let size = meta.len();
  let mut data = Vec::new();
  if let Err(e) = f.take(READ_MAX_BYTES).read_to_end(&mut data) {
    return FileText::Error { message: io_message(&e) };
  }
  if looks_binary(&data[..data.len().min(SNIFF)]) {
    return FileText::Binary { size };
  }
  let text = String::from_utf8_lossy(&data);
  let mut truncated = size > READ_MAX_BYTES;
  // +2: лишняя строка нужна, чтобы понять, что строк больше лимита; ещё одна — на пустой хвост после последнего \n.
  let mut lines: Vec<String> = text.split('\n').take(READ_MAX_LINES + 2).map(|l| l.trim_end_matches('\r').to_string()).collect();
  // Завершающий перевод строки не открывает новую строку.
  if lines.last().is_some_and(String::is_empty) {
    lines.pop();
  }
  if lines.len() > READ_MAX_LINES {
    lines.truncate(READ_MAX_LINES);
    truncated = true;
  }
  FileText::Text { lines, truncated, size }
}

/// Async-команды: ввод-вывод и git идут в пуле, не в главном потоке.
#[tauri::command(async)]
pub fn project_root(cwd: String) -> String {
  project_root_at(Path::new(&cwd))
}

#[tauri::command(async)]
pub fn project_list(root: String, rel: String) -> Result<DirList, String> {
  list_dir(Path::new(&root), &rel)
}

#[tauri::command(async)]
pub fn project_read(root: String, rel: String) -> FileText {
  read_file(Path::new(&root), &rel)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn touch(dir: &Path, name: &str, body: &str) {
    fs::write(dir.join(name), body).unwrap();
  }

  #[test]
  fn list_sorts_dirs_first_case_insensitive_and_hides_git() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir(d.path().join(".git")).unwrap();
    fs::create_dir(d.path().join("src")).unwrap();
    fs::create_dir(d.path().join("Assets")).unwrap();
    touch(d.path(), "b.txt", "");
    touch(d.path(), "A.txt", "");
    touch(d.path(), ".gitignore", "");
    let l = list_dir(d.path(), "").unwrap();
    let names: Vec<_> = l.entries.iter().map(|e| (e.name.as_str(), e.is_dir)).collect();
    assert_eq!(names, vec![("Assets", true), ("src", true), (".gitignore", false), ("A.txt", false), ("b.txt", false)]);
    assert_eq!(l.more, 0);
  }

  #[test]
  fn list_caps_at_2000_with_more() {
    let d = tempfile::tempdir().unwrap();
    for i in 0..2100 {
      touch(d.path(), &format!("f{i:04}"), "");
    }
    let l = list_dir(d.path(), "").unwrap();
    assert_eq!(l.entries.len(), 2000);
    assert_eq!(l.more, 100);
  }

  #[test]
  fn list_subdir_works() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir(d.path().join("sub")).unwrap();
    touch(&d.path().join("sub"), "x", "");
    assert_eq!(list_dir(d.path(), "sub").unwrap().entries.len(), 1);
  }

  #[test]
  fn parent_and_symlink_escape_refused() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::create_dir(outer.path().join("x")).unwrap();
    touch(outer.path(), "secret", "s");
    assert!(list_dir(&root, "../x").is_err());
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(outer.path().join("x"), root.join("link")).unwrap();
      std::os::unix::fs::symlink(outer.path().join("secret"), root.join("slink")).unwrap();
      assert!(list_dir(&root, "link").is_err());
      assert!(matches!(read_file(&root, "slink"), FileText::Error { .. }));
      // Сама ссылка в списке видна как папка, но внутрь не пускаем.
      assert!(list_dir(&root, "").unwrap().entries.iter().any(|e| e.name == "link" && e.is_dir));
    }
    assert!(matches!(read_file(&root, "../secret"), FileText::Error { .. }));
    assert!(matches!(read_file(&root, outer.path().join("secret").to_str().unwrap()), FileText::Error { .. }));
  }

  #[test]
  fn read_text_binary_missing() {
    let d = tempfile::tempdir().unwrap();
    touch(d.path(), "a.txt", "one\r\ntwo\n");
    fs::write(d.path().join("b.bin"), [1u8, 0, 2]).unwrap();
    assert_eq!(read_file(d.path(), "a.txt"), FileText::Text { lines: vec!["one".into(), "two".into()], truncated: false, size: 9 });
    assert_eq!(read_file(d.path(), "b.bin"), FileText::Binary { size: 3 });
    assert_eq!(read_file(d.path(), "nope.txt"), FileText::Missing);
    assert!(matches!(read_file(d.path(), "."), FileText::Error { .. }));
  }

  #[test]
  fn read_line_limit() {
    let d = tempfile::tempdir().unwrap();
    touch(d.path(), "big", &"x\n".repeat(25_000));
    touch(d.path(), "edge", &"x\n".repeat(20_000));
    match read_file(d.path(), "big") {
      FileText::Text { lines, truncated, .. } => assert!(truncated && lines.len() == 20_000),
      o => panic!("{o:?}"),
    }
    match read_file(d.path(), "edge") {
      FileText::Text { lines, truncated, .. } => assert!(!truncated && lines.len() == 20_000),
      o => panic!("{o:?}"),
    }
  }

  #[test]
  fn read_newlines_only_is_bounded() {
    let d = tempfile::tempdir().unwrap();
    touch(d.path(), "nl", &"\n".repeat(2 * 1024 * 1024));
    match read_file(d.path(), "nl") {
      FileText::Text { lines, truncated, .. } => assert!(truncated && lines.len() == 20_000),
      o => panic!("{o:?}"),
    }
  }

  #[test]
  fn parent_component_is_always_error() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("root");
    fs::create_dir(&root).unwrap();
    touch(outer.path(), "real", "x");
    assert!(matches!(read_file(&root, "../real"), FileText::Error { .. }));
    assert!(matches!(read_file(&root, "../nope"), FileText::Error { .. }));
    assert!(list_dir(&root, "../nope").is_err());
  }

  #[test]
  fn fifo_is_error_without_hang() {
    let d = tempfile::tempdir().unwrap();
    let p = std::ffi::CString::new(d.path().join("pipe").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(p.as_ptr(), 0o600) }, 0);
    assert!(matches!(read_file(d.path(), "pipe"), FileText::Error { .. }));
  }

  #[test]
  fn read_byte_limit_truncates() {
    let d = tempfile::tempdir().unwrap();
    touch(d.path(), "wide", &"y".repeat(3 * 1024 * 1024));
    match read_file(d.path(), "wide") {
      FileText::Text { truncated, size, .. } => assert!(truncated && size == 3 * 1024 * 1024),
      o => panic!("{o:?}"),
    }
  }

  #[test]
  fn root_is_cwd_outside_git_and_toplevel_inside() {
    let d = tempfile::tempdir().unwrap();
    let plain = d.path().canonicalize().unwrap();
    // Временная папка может лежать внутри git-репозитория, поэтому проверяем только форму ответа.
    assert!(!project_root_at(&plain).is_empty());
    let ok = std::process::Command::new("git").arg("-C").arg(&plain).args(["init", "-q"]).status().unwrap().success();
    assert!(ok);
    fs::create_dir(plain.join("sub")).unwrap();
    assert_eq!(project_root_at(&plain.join("sub")), plain.to_string_lossy());
  }

  #[test]
  fn root_without_git_returns_cwd() {
    // Несуществующий cwd: git не запустится, вернётся сам путь.
    assert_eq!(project_root_at(Path::new("/nonexistent-kv-dir")), "/nonexistent-kv-dir");
  }
}
