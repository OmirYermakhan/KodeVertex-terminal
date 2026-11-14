//! Панель проекта: список папки и чтение файла строго внутри корня проекта.
//! Только просмотр — ничего не меняем. Пути от фронта относительные к корню.

use crate::git::{git_args, run_cmd, run_cmd_capped, GIT_ENV};
use crate::preview::{io_message, looks_binary};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Коммитов за один запрос истории не больше.
const LOG_MAX: u32 = 500;
/// Diff больше этого размера урезаем.
const DIFF_MAX: usize = 4 * 1024 * 1024;
/// Последняя строка урезанного diff — фронт показывает её как пометку.
const DIFF_CUT_MARK: &str = "\\ Изменения урезаны: больше 4 МБ";
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

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Change {
  pub path: String,
  pub old_path: Option<String>,
  pub status: String,
  pub add: Option<u32>,
  pub del: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
  pub hash: String,
  pub short: String,
  pub subject: String,
  pub author: String,
  pub time: i64,
  pub refs: Vec<String>,
  pub head: bool,
}

/// Запуск git только для чтения: общий путь из `git.rs` (защитные `-c`, перекрытие фильтров,
/// GIT_ENV, stdin null) и один дедлайн на всю команду.
struct Git<'a> {
  cwd: &'a str,
  extra: Vec<String>,
  deadline: Instant,
}

impl<'a> Git<'a> {
  fn new(root: &'a Path) -> Result<Self, String> {
    let cwd = root.to_str().ok_or_else(|| "not-git".to_string())?;
    let deadline = Instant::now() + GIT_TIMEOUT;
    let extra = crate::git::filter_overrides(root, deadline);
    let g = Git { cwd, extra, deadline };
    // Не репозиторий (или нет доступа) — единый ответ для фронта.
    if g.run(&["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
      return Err("not-git".to_string());
    }
    Ok(g)
  }

  fn env() -> Vec<(&'static str, &'static str)> {
    // Пути — буквально (без `:(top)` и масок); `--` ставит вызывающий.
    GIT_ENV.iter().copied().chain([("GIT_LITERAL_PATHSPECS", "1")]).collect()
  }

  fn run(&self, args: &[&str]) -> Option<String> {
    run_cmd("git", &git_args(self.cwd, &self.extra, args), Path::new("."), &Self::env(), self.deadline)
  }

  /// Вывод без обрезки пробелов и с потолком `max` байт; true — вывод урезан.
  fn run_raw(&self, args: &[&str], max: usize) -> Option<(String, bool)> {
    run_cmd_capped("git", &git_args(self.cwd, &self.extra, args), Path::new("."), &Self::env(), self.deadline, max)
  }

  fn has_head(&self) -> bool {
    self.run(&["rev-parse", "--verify", "--quiet", "HEAD"]).is_some()
  }
}

/// Ревизия — только короткий/полный hex-хеш: ничего, похожего на опцию или выражение.
fn valid_hash(h: &str) -> bool {
  (4..=40).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Относительный путь от фронта: непустой, без `..`, не абсолютный, без NUL.
fn valid_rel(rel: &str) -> bool {
  let p = Path::new(rel);
  !rel.is_empty() && !rel.contains('\0') && !p.is_absolute() && !has_parent(p)
}

/// Буква статуса: R/C-переименование и копия, A/D, всё прочее (M, T, конфликты) — M.
fn status_letter(c: char) -> &'static str {
  match c {
    'A' | 'C' => "A",
    'D' => "D",
    'R' => "R",
    _ => "M",
  }
}

/// Разбор `--numstat -z`: `add\tdel\tpath\0`, для переименования `add\tdel\t\0old\0new\0`.
/// Двоичный файл — `-` (None). Ключ — актуальный путь.
fn parse_numstat(out: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
  let mut map = HashMap::new();
  let mut it = out.split('\0');
  while let Some(tok) = it.next() {
    let mut f = tok.splitn(3, '\t');
    let (Some(a), Some(d), Some(path)) = (f.next(), f.next(), f.next()) else { continue };
    let path = if path.is_empty() {
      let _old = it.next();
      it.next().unwrap_or("")
    } else {
      path
    };
    map.insert(path.to_string(), (a.parse().ok(), d.parse().ok()));
  }
  map
}

fn with_counts(mut c: Change, nums: &HashMap<String, (Option<u32>, Option<u32>)>) -> Change {
  if let Some(&(a, d)) = nums.get(&c.path) {
    c.add = a;
    c.del = d;
  }
  c
}

fn change(path: &str, old: Option<&str>, status: &str) -> Change {
  Change { path: path.to_string(), old_path: old.map(str::to_string), status: status.to_string(), add: None, del: None }
}

/// Разбор `status --porcelain=v1 -z`: `XY path\0`, для R/C следом `old\0`.
fn parse_status(out: &str) -> Vec<Change> {
  let mut res = Vec::new();
  let mut it = out.split('\0');
  while let Some(e) = it.next() {
    let mut chars = e.chars();
    let (Some(x), Some(y)) = (chars.next(), chars.next()) else { continue };
    let Some(path) = e.get(3..) else { continue };
    let old = if x == 'R' || x == 'C' || y == 'R' || y == 'C' { it.next() } else { None };
    let st = match (x, y) {
      ('?', '?') => "?",
      ('!', '!') => continue,
      _ if x == 'R' || y == 'R' => "R",
      _ if x == 'A' || y == 'A' || x == 'C' || y == 'C' => "A",
      _ if x == 'D' || y == 'D' => "D",
      _ => "M",
    };
    res.push(change(path, old, st));
  }
  res
}

/// Разбор `--name-status -z`: `S\0path\0`, для R/C `SNN\0old\0new\0`.
fn parse_name_status(out: &str) -> Vec<Change> {
  let mut res = Vec::new();
  let mut it = out.split('\0').filter(|t| !t.is_empty());
  while let Some(s) = it.next() {
    let Some(letter) = s.chars().next() else { continue };
    if letter == 'R' || letter == 'C' {
      let (Some(old), Some(new)) = (it.next(), it.next()) else { break };
      res.push(change(new, (letter == 'R').then_some(old), status_letter(letter)));
    } else {
      let Some(path) = it.next() else { break };
      res.push(change(path, None, status_letter(letter)));
    }
  }
  res
}

pub fn git_status_at(root: &Path) -> Result<Vec<Change>, String> {
  let g = Git::new(root)?;
  let st = g.run(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]).ok_or("Не удалось получить состояние git")?;
  let mut changes = parse_status(&st);
  // Без коммитов сравниваем индекс с пустым деревом.
  let numstat = if g.has_head() {
    g.run(&["diff", "HEAD", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"])
  } else {
    g.run(&["diff", "--cached", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"])
  };
  let nums = parse_numstat(&numstat.unwrap_or_default());
  changes = changes.into_iter().map(|c| with_counts(c, &nums)).collect();
  Ok(changes)
}

pub fn git_log_at(root: &Path, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
  let g = Git::new(root)?;
  if !g.has_head() {
    return Ok(vec![]);
  }
  let skip = format!("--skip={skip}");
  let limit = format!("-n{}", limit.clamp(1, LOG_MAX));
  let out = g
    .run(&["log", "--no-show-signature", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%D%x1e", &skip, &limit])
    .ok_or("Не удалось прочитать историю")?;
  Ok(out.split('\x1e').filter_map(parse_commit).collect())
}

fn parse_commit(rec: &str) -> Option<Commit> {
  let mut f = rec.trim_start_matches('\n').split('\x1f');
  let (hash, short, subject, author, time, refs) = (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?, f.next()?);
  let refs: Vec<String> = refs.split(", ").filter(|r| !r.is_empty()).map(str::to_string).collect();
  let head = refs.iter().any(|r| r == "HEAD" || r.starts_with("HEAD -> "));
  Some(Commit { hash: hash.into(), short: short.into(), subject: subject.into(), author: author.into(), time: time.parse().ok()?, refs, head })
}

pub fn git_commit_files_at(root: &Path, hash: &str) -> Result<Vec<Change>, String> {
  if !valid_hash(hash) {
    return Err("Неверная ревизия".to_string());
  }
  let g = Git::new(root)?;
  // -m --first-parent: у слияния показываем изменения относительно первого родителя.
  let base = ["show", "--no-show-signature", "--format=", "-m", "--first-parent", "-M", "-z", "--no-ext-diff", "--no-textconv"];
  let mut ns = base.to_vec();
  ns.extend(["--name-status", hash, "--"]);
  let mut nm = base.to_vec();
  nm.extend(["--numstat", hash, "--"]);
  let names = g.run(&ns).ok_or("Коммит не найден")?;
  let nums = parse_numstat(&g.run(&nm).unwrap_or_default());
  Ok(parse_name_status(&names).into_iter().map(|c| with_counts(c, &nums)).collect())
}

/// Diff «всё добавлено» для неотслеживаемого файла; читаем через `read_file` (границы корня, 2 МБ).
fn untracked_diff(root: &Path, rel: &str) -> Result<String, String> {
  let head = format!("diff --git a/{rel} b/{rel}\nnew file mode 100644\n");
  match read_file(root, rel) {
    FileText::Text { lines, truncated, .. } => {
      let mut out = head;
      if !lines.is_empty() {
        out.push_str(&format!("--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n", lines.len()));
        for l in &lines {
          out.push('+');
          out.push_str(l);
          out.push('\n');
        }
      }
      if truncated {
        out.push_str("\\ Файл усечён\n");
      }
      Ok(out)
    }
    FileText::Binary { .. } => Ok(format!("{head}Binary files /dev/null and b/{rel} differ\n")),
    FileText::Missing => Err("Файл не найден".to_string()),
    FileText::Error { message } => Err(message),
  }
}

pub fn git_diff_at(root: &Path, rel: &str, rev: Option<&str>) -> Result<String, String> {
  if !valid_rel(rel) || rev.is_some_and(|h| !valid_hash(h)) {
    return Err("Неверный путь или ревизия".to_string());
  }
  let g = Git::new(root)?;
  const OPTS: [&str; 5] = ["-U3", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/"];
  let opts = || OPTS.iter().copied().chain(["--dst-prefix=b/"]);
  if let Some(h) = rev {
    let mut a = vec!["show", "--no-show-signature", "--format=", "-m", "--first-parent", "-M"];
    a.extend(opts());
    a.extend([h, "--", rel]);
    return g.run_raw(&a, DIFF_MAX).map(cut_mark).ok_or_else(|| "Коммит не найден".to_string());
  }
  // Неотслеживаемый: у git для него diff пуст, поэтому синтезируем.
  let untracked = g.run(&["ls-files", "--others", "--exclude-standard", "-z", "--", rel]).is_some_and(|s| !s.is_empty());
  if untracked {
    return untracked_diff(root, rel);
  }
  let mut a = vec!["diff"];
  a.push(if g.has_head() { "HEAD" } else { "--cached" });
  a.extend(opts());
  a.extend(["--", rel]);
  g.run_raw(&a, DIFF_MAX).map(cut_mark).ok_or_else(|| "Не удалось получить изменения".to_string())
}

/// Урезанный diff обрываем по границе строки и дописываем пометку.
fn cut_mark((mut s, cut): (String, bool)) -> String {
  if cut {
    s.truncate(s.rfind('\n').map_or(0, |i| i + 1));
    s.push_str(DIFF_CUT_MARK);
    s.push('\n');
  }
  s
}

#[tauri::command(async)]
pub fn git_status(root: String) -> Result<Vec<Change>, String> {
  git_status_at(Path::new(&root))
}

#[tauri::command(async)]
pub fn git_log(root: String, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
  git_log_at(Path::new(&root), skip, limit)
}

#[tauri::command(async)]
pub fn git_commit_files(root: String, hash: String) -> Result<Vec<Change>, String> {
  git_commit_files_at(Path::new(&root), &hash)
}

#[tauri::command(async)]
pub fn git_diff(root: String, rel: String, rev: Option<String>) -> Result<String, String> {
  git_diff_at(Path::new(&root), &rel, rev.as_deref())
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

  // ---- git: состояние, лог, файлы коммита, изменения ----

  fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
      .args(args)
      .env("GIT_CONFIG_GLOBAL", "/dev/null")
      .env("GIT_CONFIG_NOSYSTEM", "1")
      .status()
      .unwrap()
      .success();
    assert!(ok, "git {args:?} failed");
  }

  fn new_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q", "-b", "main"]);
    d
  }

  fn commit_all(d: &Path, msg: &str) {
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
  }

  fn find<'a>(v: &'a [Change], path: &str) -> &'a Change {
    v.iter().find(|c| c.path == path).unwrap_or_else(|| panic!("нет {path} в {v:?}"))
  }

  #[test]
  fn status_reports_all_kinds() {
    let d = new_repo();
    let p = d.path();
    touch(p, "a.txt", "one\n");
    touch(p, "с пробелом.txt", "x\n");
    touch(p, "del.txt", "gone\n");
    touch(p, "old.txt", "rename me\nline2\nline3\n");
    fs::write(p.join("bin.dat"), [0u8, 1, 2]).unwrap();
    commit_all(p, "init");
    touch(p, "a.txt", "one\ntwo\n");
    touch(p, "с пробелом.txt", "x\ny\n");
    fs::remove_file(p.join("del.txt")).unwrap();
    git(p, &["mv", "old.txt", "new.txt"]);
    touch(p, "added.txt", "a\n");
    git(p, &["add", "added.txt"]);
    touch(p, "нов файл.txt", "u\n");
    fs::write(p.join("bin.dat"), [0u8, 9, 9, 9]).unwrap();

    let s = git_status_at(p).unwrap();
    let a = find(&s, "a.txt");
    assert_eq!((a.status.as_str(), a.add, a.del, a.old_path.clone()), ("M", Some(1), Some(0), None));
    assert_eq!(find(&s, "с пробелом.txt").status, "M");
    let del = find(&s, "del.txt");
    assert_eq!((del.status.as_str(), del.add, del.del), ("D", Some(0), Some(1)));
    let r = find(&s, "new.txt");
    assert_eq!((r.status.as_str(), r.old_path.as_deref()), ("R", Some("old.txt")));
    assert_eq!(find(&s, "added.txt").status, "A");
    assert_eq!(find(&s, "added.txt").add, Some(1));
    let u = find(&s, "нов файл.txt");
    assert_eq!((u.status.as_str(), u.add, u.del), ("?", None, None));
    let b = find(&s, "bin.dat");
    assert_eq!((b.status.as_str(), b.add, b.del), ("M", None, None));
    assert_eq!(s.len(), 7);
  }

  #[test]
  fn status_without_commits() {
    let d = new_repo();
    touch(d.path(), "s.txt", "1\n2\n");
    git(d.path(), &["add", "s.txt"]);
    touch(d.path(), "u.txt", "u\n");
    let s = git_status_at(d.path()).unwrap();
    assert_eq!((find(&s, "s.txt").status.as_str(), find(&s, "s.txt").add), ("A", Some(2)));
    assert_eq!(find(&s, "u.txt").status, "?");
  }

  #[test]
  fn status_clean_is_empty_and_non_git_errs() {
    let d = new_repo();
    touch(d.path(), "a", "1\n");
    commit_all(d.path(), "c");
    assert_eq!(git_status_at(d.path()).unwrap(), vec![]);
    assert_eq!(git_status_at(Path::new("/nonexistent-kv-dir")), Err("not-git".to_string()));
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(git_status_at(plain.path()), Err("not-git".to_string()));
    assert_eq!(git_log_at(plain.path(), 0, 10), Err("not-git".to_string()));
  }

  #[test]
  fn log_three_commits_with_refs_and_head() {
    let d = new_repo();
    let p = d.path();
    assert_eq!(git_log_at(p, 0, 10).unwrap(), vec![]);
    for (i, m) in ["first", "second", "third"].iter().enumerate() {
      touch(p, "f", &format!("{i}\n"));
      commit_all(p, m);
      if i == 0 {
        git(p, &["tag", "v1"]);
      }
    }
    let l = git_log_at(p, 0, 10).unwrap();
    assert_eq!(l.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["third", "second", "first"]);
    assert!(l[0].head && !l[1].head && !l[2].head);
    assert!(l[0].refs.iter().any(|r| r == "HEAD -> main"), "{:?}", l[0].refs);
    assert!(l[2].refs.iter().any(|r| r == "tag: v1"), "{:?}", l[2].refs);
    assert_eq!(l[0].hash.len(), 40);
    assert!(l[0].hash.starts_with(&l[0].short));
    assert_eq!(l[0].author, "t");
    assert!(l[0].time > 1_600_000_000);
    let page = git_log_at(p, 1, 1).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].subject, "second");
  }

  #[test]
  fn commit_files_root_and_rename() {
    let d = new_repo();
    let p = d.path();
    touch(p, "a.txt", "1\n2\n");
    touch(p, "b c.txt", "same\nsame2\nsame3\n");
    commit_all(p, "root");
    git(p, &["mv", "b c.txt", "д.txt"]);
    fs::remove_file(p.join("a.txt")).unwrap();
    touch(p, "n.txt", "n\n");
    commit_all(p, "second");
    let l = git_log_at(p, 0, 10).unwrap();
    let root = git_commit_files_at(p, &l[1].hash).unwrap();
    assert_eq!(root.len(), 2);
    assert_eq!((find(&root, "a.txt").status.as_str(), find(&root, "a.txt").add), ("A", Some(2)));
    let sec = git_commit_files_at(p, &l[0].hash).unwrap();
    let r = find(&sec, "д.txt");
    assert_eq!((r.status.as_str(), r.old_path.as_deref()), ("R", Some("b c.txt")));
    assert_eq!(find(&sec, "a.txt").status, "D");
    assert_eq!(find(&sec, "n.txt").status, "A");
  }

  #[test]
  fn commit_files_rejects_bad_hash() {
    let d = new_repo();
    for h in ["--all", "zz12", "abc", "ABCD1234", "", "HEAD", &"a".repeat(41), "-p"] {
      assert!(git_commit_files_at(d.path(), h).is_err(), "{h}");
    }
    assert!(git_commit_files_at(d.path(), "deadbeef").is_err());
  }

  #[test]
  fn diff_modified_untracked_and_commit() {
    let d = new_repo();
    let p = d.path();
    touch(p, "a.txt", "one\n");
    commit_all(p, "c1");
    touch(p, "a.txt", "one\ntwo\n");
    let m = git_diff_at(p, "a.txt", None).unwrap();
    assert!(m.contains("--- a/a.txt") && m.contains("+++ b/a.txt") && m.contains("+two"), "{m}");

    touch(p, "нов файл.txt", "hello\nworld\n");
    let u = git_diff_at(p, "нов файл.txt", None).unwrap();
    assert!(u.contains("--- /dev/null") && u.contains("+++ b/нов файл.txt") && u.contains("@@ -0,0 +1,2 @@") && u.contains("+hello\n+world\n"), "{u}");

    fs::write(p.join("bin.dat"), [0u8, 1, 2]).unwrap();
    let b = git_diff_at(p, "bin.dat", None).unwrap();
    assert!(b.contains("Binary") && !b.contains("@@"), "{b}");

    commit_all(p, "c2");
    let h = git_log_at(p, 0, 1).unwrap().remove(0).hash;
    let c = git_diff_at(p, "a.txt", Some(&h)).unwrap();
    assert!(c.contains("+two") && !c.contains("hello"), "{c}");
  }

  #[test]
  fn diff_deleted_file_and_unborn_repo() {
    let d = new_repo();
    let p = d.path();
    touch(p, "s.txt", "1\n");
    git(p, &["add", "s.txt"]);
    assert!(git_diff_at(p, "s.txt", None).unwrap().contains("+1"));
    commit_all(p, "c");
    fs::remove_file(p.join("s.txt")).unwrap();
    assert!(git_diff_at(p, "s.txt", None).unwrap().contains("-1"));
  }

  #[test]
  fn diff_refuses_bad_input() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("r");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q"]);
    touch(&root, "a", "1\n");
    commit_all(&root, "c");
    touch(outer.path(), "secret", "s\n");
    std::os::unix::fs::symlink(outer.path().join("secret"), root.join("lnk")).unwrap();
    assert!(git_diff_at(&root, "../secret", None).is_err());
    assert!(git_diff_at(&root, outer.path().join("secret").to_str().unwrap(), None).is_err());
    assert!(git_diff_at(&root, "lnk", None).is_err());
    assert!(git_diff_at(&root, "a", Some("--all")).is_err());
    assert!(git_diff_at(&root, "a", Some("nothex1")).is_err());
    assert!(git_diff_at(&root, "", None).is_err());
  }

  #[test]
  fn show_never_runs_foreign_gpg_program() {
    use std::os::unix::fs::PermissionsExt;
    let d = new_repo();
    let p = d.path();
    touch(p, "a", "1\n");
    commit_all(p, "c");
    let marker = p.join("GPG_RAN");
    let prog = tempfile::tempdir().unwrap();
    let script = prog.path().join("gpg.sh");
    fs::write(&script, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display())).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    git(p, &["config", "log.showSignature", "true"]);
    git(p, &["config", "gpg.program", script.to_str().unwrap()]);
    // Коммит с подписью в заголовке: git пытается её проверить внешней программой.
    let out = |args: &[&str]| {
      let o = std::process::Command::new("git").arg("-C").arg(p).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
      String::from_utf8(o.stdout).unwrap().trim().to_string()
    };
    let tree = out(&["write-tree"]);
    let parent = out(&["rev-parse", "HEAD"]);
    let body = format!("tree {tree}\nparent {parent}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n");
    let bf = prog.path().join("commit.txt");
    fs::write(&bf, body).unwrap();
    let h = out(&["hash-object", "-w", "-t", "commit", "--literally", bf.to_str().unwrap()]);
    git(p, &["update-ref", "refs/heads/main", &h]);
    git_commit_files_at(p, &h).unwrap();
    git_diff_at(p, "a", Some(&h)).unwrap();
    assert!(!marker.exists(), "git show запустил gpg.program из конфига репозитория");
  }

  #[test]
  fn huge_diff_is_cut_with_marker() {
    let d = new_repo();
    let p = d.path();
    touch(p, "big", "a\n");
    commit_all(p, "c");
    touch(p, "big", &"xxxxxxxxx\n".repeat(800_000));
    let t = Instant::now();
    let s = git_diff_at(p, "big", None).unwrap();
    assert!(t.elapsed() < Duration::from_secs(5));
    assert!(s.len() <= 4 * 1024 * 1024 + 100 && s.len() > 3 * 1024 * 1024, "{}", s.len());
    assert!(s.ends_with("\\ Изменения урезаны: больше 4 МБ\n"));
  }

  #[test]
  fn non_utf8_diff_is_not_empty() {
    let d = new_repo();
    let p = d.path();
    fs::write(p.join("l.txt"), b"caf\xe9\n").unwrap();
    commit_all(p, "c");
    fs::write(p.join("l.txt"), b"caf\xe9\nna\xefve\n").unwrap();
    let s = git_diff_at(p, "l.txt", None).unwrap();
    assert!(s.contains("+na"), "{s:?}");
  }

  #[test]
  fn diff_keeps_trailing_context_line() {
    let d = new_repo();
    let p = d.path();
    touch(p, "t", "a\nb\n\n");
    commit_all(p, "c");
    touch(p, "t", "A\nb\n\n");
    let s = git_diff_at(p, "t", None).unwrap();
    assert!(s.ends_with("\n \n"), "{s:?}");
  }
}
