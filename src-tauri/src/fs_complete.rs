use serde::Serialize;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

const MAX_ENTRIES: usize = 2000;
const PREVIEW_ENTRIES: usize = 20;
const PREVIEW_LINES: usize = 20;
const PREVIEW_LINE_CHARS: usize = 200;
const MAX_TEXT_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
  pub name: String,
  pub is_dir: bool,
  pub is_symlink: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FsPreview {
  Dir { entries: Vec<FsEntry>, total: usize },
  Text { lines: Vec<String>, truncated: bool },
  Binary { size: u64 },
  Error { message: String },
}

fn io_message(e: &io::Error) -> String {
  match e.kind() {
    io::ErrorKind::NotFound => "Не найдено".to_string(),
    io::ErrorKind::PermissionDenied => "Нет доступа".to_string(),
    _ => e.to_string(),
  }
}

/// Записей папки читаем не больше: папка на сотни тысяч файлов не должна надолго занять поток.
const SCAN_MAX: usize = 100_000;

#[cfg(test)]
pub fn list_dir(dir: &Path, dirs_only: bool, include_hidden: bool) -> Result<Vec<FsEntry>, String> {
  list_matching(dir, dirs_only, include_hidden, "", MAX_ENTRIES).map(|(v, _)| v)
}

/// Записи папки: сначала отбор (скрытые, только папки, начало имени `prefix` без учёта регистра),
/// затем сортировка (папки первыми, по имени без учёта регистра), и только потом первые `limit`.
/// Второе значение — сколько записей подошло всего (из первых SCAN_MAX прочитанных).
pub fn list_matching(dir: &Path, dirs_only: bool, include_hidden: bool, prefix: &str, limit: usize) -> Result<(Vec<FsEntry>, usize), String> {
  let rd = fs::read_dir(dir).map_err(|e| io_message(&e))?;
  let prefix = prefix.to_lowercase();
  let mut out = Vec::new();
  // Лимит на число ПРОЧИТАННЫХ записей (включая ошибки итератора и отфильтрованные).
  for item in rd.take(SCAN_MAX) {
    let Ok(item) = item else { continue };
    // Имя не в UTF-8 нельзя ни показать, ни подставить без искажения — пропускаем.
    let Ok(name) = item.file_name().into_string() else { continue };
    if !include_hidden && name.starts_with('.') {
      continue;
    }
    if !prefix.is_empty() && !name.to_lowercase().starts_with(&prefix) {
      continue;
    }
    let Ok(ft) = item.file_type() else { continue };
    let is_symlink = ft.is_symlink();
    // metadata (stat) только для симлинков; битая ссылка — не каталог
    let is_dir = if is_symlink {
      fs::metadata(item.path()).map(|m| m.is_dir()).unwrap_or(false)
    } else {
      ft.is_dir()
    };
    if dirs_only && !is_dir {
      continue;
    }
    out.push(FsEntry { name, is_dir, is_symlink });
  }
  out.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase(), e.name.clone()));
  let total = out.len();
  out.truncate(limit);
  Ok((out, total))
}

pub fn preview(path: &Path) -> FsPreview {
  let meta = match fs::metadata(path) {
    Ok(m) => m,
    Err(e) => return FsPreview::Error { message: io_message(&e) },
  };
  if meta.is_dir() {
    return match list_matching(path, false, true, "", PREVIEW_ENTRIES) {
      Ok((entries, total)) => FsPreview::Dir { entries, total },
      Err(message) => FsPreview::Error { message },
    };
  }
  // FIFO, устройство, сокет: open/read может блокироваться навсегда на общем пуле.
  if !meta.is_file() {
    return FsPreview::Error { message: "Особый файл".to_string() };
  }
  // Открытие без блокировки, тип — у открытого дескриптора: файл могли подменить после stat.
  let (f, meta) = match crate::attach::open_regular(path) {
    Ok(v) => v,
    Err(e) if e.kind() == io::ErrorKind::InvalidInput => return FsPreview::Error { message: "Особый файл".to_string() },
    Err(e) => return FsPreview::Error { message: io_message(&e) },
  };
  let size = meta.len();
  if size > MAX_TEXT_BYTES {
    return FsPreview::Binary { size };
  }
  let mut buf = Vec::with_capacity(size as usize);
  if let Err(e) = f.take(MAX_TEXT_BYTES).read_to_end(&mut buf) {
    return FsPreview::Error { message: io_message(&e) };
  }
  if buf.contains(&0) {
    return FsPreview::Binary { size };
  }
  let Ok(text) = String::from_utf8(buf) else {
    return FsPreview::Binary { size };
  };
  let mut all = text.lines();
  let lines: Vec<String> = all
    .by_ref()
    .take(PREVIEW_LINES)
    .map(|l| l.chars().take(PREVIEW_LINE_CHARS).collect())
    .collect();
  let truncated = all.next().is_some();
  FsPreview::Text { lines, truncated }
}

/// `prefix` — необязательное начало имени (без учёта регистра): с ним 2000 записей берутся из
/// подходящих, а не из первых попавшихся. Фронт может его не передавать.
#[tauri::command]
pub async fn fs_list(dir: String, dirs_only: bool, include_hidden: bool, prefix: Option<String>) -> Result<Vec<FsEntry>, String> {
  crate::blocking(move || {
    list_matching(Path::new(&dir), dirs_only, include_hidden, prefix.as_deref().unwrap_or(""), MAX_ENTRIES).map(|(v, _)| v)
  })
  .await?
}

#[tauri::command]
pub async fn fs_preview(path: String) -> FsPreview {
  crate::blocking(move || preview(Path::new(&path))).await.unwrap_or_else(|message| FsPreview::Error { message })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::os::unix::fs::{symlink, PermissionsExt};
  use tempfile::tempdir;

  fn names(v: &[FsEntry]) -> Vec<&str> {
    v.iter().map(|e| e.name.as_str()).collect()
  }

  #[test]
  fn sorts_dirs_first_case_insensitive() {
    let t = tempdir().unwrap();
    fs::create_dir(t.path().join("B")).unwrap();
    fs::create_dir(t.path().join("a")).unwrap();
    fs::write(t.path().join("c.txt"), "").unwrap();
    fs::write(t.path().join("D.md"), "").unwrap();
    let r = list_dir(t.path(), false, false).unwrap();
    assert_eq!(names(&r), ["a", "B", "c.txt", "D.md"]);
    assert!(r[0].is_dir && r[1].is_dir && !r[2].is_dir);
  }

  #[test]
  fn dirs_only_filters_files() {
    let t = tempdir().unwrap();
    fs::create_dir(t.path().join("a")).unwrap();
    fs::write(t.path().join("f"), "").unwrap();
    let r = list_dir(t.path(), true, false).unwrap();
    assert_eq!(names(&r), ["a"]);
  }

  #[test]
  fn hidden_only_when_requested() {
    let t = tempdir().unwrap();
    fs::create_dir(t.path().join(".git")).unwrap();
    fs::write(t.path().join("x"), "").unwrap();
    assert_eq!(names(&list_dir(t.path(), false, false).unwrap()), ["x"]);
    assert_eq!(names(&list_dir(t.path(), false, true).unwrap()), [".git", "x"]);
  }

  #[test]
  fn symlink_to_dir_is_dir() {
    let t = tempdir().unwrap();
    fs::create_dir(t.path().join("real")).unwrap();
    symlink(t.path().join("real"), t.path().join("link")).unwrap();
    let r = list_dir(t.path(), true, false).unwrap();
    let l = r.iter().find(|e| e.name == "link").unwrap();
    assert!(l.is_dir && l.is_symlink);
    let real = r.iter().find(|e| e.name == "real").unwrap();
    assert!(!real.is_symlink);
  }

  #[test]
  fn caps_at_2000_entries() {
    let t = tempdir().unwrap();
    for i in 0..2500 {
      fs::write(t.path().join(format!("f{i}")), "").unwrap();
    }
    let all = list_dir(t.path(), false, false).unwrap();
    assert_eq!(all.len(), 2000);
    // Первые по алфавиту, а не первые попавшиеся.
    let mut want: Vec<String> = (0..2500).map(|i| format!("f{i}")).collect();
    want.sort();
    assert_eq!(names(&all), want[..2000].iter().map(String::as_str).collect::<Vec<_>>());
    match preview(t.path()) {
      FsPreview::Dir { entries, total } => {
        assert_eq!(names(&entries), want[..20].iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(total, 2500);
      }
      other => panic!("{other:?}"),
    }
  }

  #[test]
  fn prefix_filters_before_limit() {
    let t = tempdir().unwrap();
    for i in 0..2500 {
      fs::write(t.path().join(format!("a{i}")), "").unwrap();
    }
    fs::write(t.path().join("Zeta.txt"), "").unwrap();
    fs::create_dir(t.path().join("zoo")).unwrap();
    let (v, total) = list_matching(t.path(), false, false, "z", MAX_ENTRIES).unwrap();
    assert_eq!(names(&v), ["zoo", "Zeta.txt"]);
    assert_eq!(total, 2);
  }

  #[test]
  fn dirs_only_in_file_heavy_dir_is_bounded_and_empty() {
    let t = tempdir().unwrap();
    for i in 0..2500 {
      fs::write(t.path().join(format!("f{i}")), "").unwrap();
    }
    let start = std::time::Instant::now();
    assert!(list_dir(t.path(), true, false).unwrap().is_empty());
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
  }

  #[test]
  fn hidden_filtering_counts_read_entries() {
    let t = tempdir().unwrap();
    for i in 0..500 {
      fs::write(t.path().join(format!(".h{i}")), "").unwrap();
    }
    for i in 0..2500 {
      fs::write(t.path().join(format!("v{i}")), "").unwrap();
    }
    // 3000 записей: скрытые отброшены до лимита, видимых — ровно 2000 первых
    let v = list_dir(t.path(), false, false).unwrap();
    assert_eq!(v.len(), 2000);
    assert!(v.iter().all(|e| !e.name.starts_with('.')));
  }

  #[test]
  fn text_preview_truncates_lines() {
    let t = tempdir().unwrap();
    let p = t.path().join("a.txt");
    let body: String = (0..30).map(|i| format!("line {i}\n")).collect();
    fs::write(&p, body).unwrap();
    match preview(&p) {
      FsPreview::Text { lines, truncated } => {
        assert_eq!(lines.len(), 20);
        assert!(truncated);
      }
      other => panic!("{other:?}"),
    }
  }

  #[test]
  fn short_text_not_truncated() {
    let t = tempdir().unwrap();
    let p = t.path().join("a.txt");
    fs::write(&p, "a\nb\n").unwrap();
    assert_eq!(
      preview(&p),
      FsPreview::Text { lines: vec!["a".into(), "b".into()], truncated: false }
    );
  }

  #[test]
  fn long_line_cut_to_200_chars() {
    let t = tempdir().unwrap();
    let p = t.path().join("a.txt");
    fs::write(&p, "ж".repeat(500)).unwrap();
    match preview(&p) {
      FsPreview::Text { lines, .. } => assert_eq!(lines[0].chars().count(), 200),
      other => panic!("{other:?}"),
    }
  }

  #[test]
  fn nul_bytes_are_binary() {
    let t = tempdir().unwrap();
    let p = t.path().join("b.bin");
    fs::write(&p, [1u8, 0, 2, 3]).unwrap();
    assert_eq!(preview(&p), FsPreview::Binary { size: 4 });
  }

  #[test]
  fn big_file_is_binary() {
    let t = tempdir().unwrap();
    let p = t.path().join("big.txt");
    fs::write(&p, vec![b'a'; 1024 * 1024 + 1]).unwrap();
    assert!(matches!(preview(&p), FsPreview::Binary { .. }));
  }

  #[test]
  fn missing_path_is_not_found() {
    let t = tempdir().unwrap();
    assert_eq!(
      preview(&t.path().join("nope")),
      FsPreview::Error { message: "Не найдено".into() }
    );
  }

  #[test]
  fn fifo_is_special_and_does_not_block() {
    let t = tempdir().unwrap();
    let p = t.path().join("pipe");
    let st = std::process::Command::new("mkfifo").arg(&p).status().unwrap();
    assert!(st.success());
    // Без проверки типа File::open на FIFO без писателя ждал бы вечно.
    let (tx, rx) = std::sync::mpsc::channel();
    let path = p.clone();
    std::thread::spawn(move || tx.send(preview(&path)).unwrap());
    let r = rx.recv_timeout(std::time::Duration::from_secs(2)).expect("preview заблокировался на FIFO");
    assert_eq!(r, FsPreview::Error { message: "Особый файл".into() });
  }

  #[test]
  fn device_is_special() {
    assert_eq!(
      preview(Path::new("/dev/null")),
      FsPreview::Error { message: "Особый файл".into() }
    );
  }

  #[test]
  fn skips_non_utf8_names() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let t = tempdir().unwrap();
    fs::write(t.path().join("ok"), "").unwrap();
    let bad = t.path().join(OsStr::from_bytes(b"bad\xff"));
    if fs::write(&bad, "").is_err() {
      // APFS не даёт создать имя не в UTF-8 — на такой ФС такого входа и не будет.
      eprintln!("ФС не принимает имена не в UTF-8, проверяем только валидные");
    }
    assert_eq!(names(&list_dir(t.path(), false, false).unwrap()), ["ok"]);
  }

  #[test]
  fn unreadable_dir_is_denied() {
    let t = tempdir().unwrap();
    let d = t.path().join("locked");
    fs::create_dir(&d).unwrap();
    fs::set_permissions(&d, fs::Permissions::from_mode(0o000)).unwrap();
    let p = preview(&d);
    let l = list_dir(&d, false, false);
    fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(p, FsPreview::Error { message: "Нет доступа".into() });
    assert!(l.is_err());
  }
}
