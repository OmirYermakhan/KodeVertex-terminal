// Пользовательские slash-команды Claude Code: `<cwd>/.claude/commands/**/*.md` и
// `~/.claude/commands/**/*.md` (подкаталог → `dir:name`). Для попапа подсказок строки ввода.
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Всего файлов (проект + личные).
const MAX_FILES: usize = 200;
/// Читается из начала файла.
const MAX_READ: u64 = 8 * 1024;
const MAX_DEPTH: usize = 4;
const DESC_CHARS: usize = 60;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SlashCommand {
  pub name: String,
  pub description: String,
  /// "project" | "user"
  pub source: &'static str,
}

/// Описание: `description:` из frontmatter, иначе первая непустая строка (без `#`), ≤ 60 символов.
pub fn describe(text: &str) -> String {
  let mut lines = text.lines();
  let mut body: Vec<&str> = Vec::new();
  let mut first = lines.next();
  if first.map(str::trim_end) == Some("---") {
    first = None;
    for l in lines.by_ref() {
      if l.trim_end() == "---" {
        break;
      }
      if let Some(v) = l.strip_prefix("description:") {
        let v = v.trim();
        let v = v
          .strip_prefix('"')
          .and_then(|s| s.strip_suffix('"'))
          .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
          .unwrap_or(v);
        if !v.is_empty() {
          return clip(v);
        }
      }
    }
  }
  body.extend(first);
  body.extend(lines);
  body
    .iter()
    .map(|l| l.trim().trim_start_matches('#').trim())
    .find(|l| !l.is_empty())
    .map(clip)
    .unwrap_or_default()
}

fn clip(s: &str) -> String {
  let clean: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
  let clean = clean.trim();
  if clean.chars().count() <= DESC_CHARS {
    return clean.to_string();
  }
  let mut out: String = clean.chars().take(DESC_CHARS - 1).collect();
  out = out.trim_end().to_string();
  out.push('…');
  out
}

fn read_head(path: &Path) -> String {
  let mut buf = Vec::new();
  if let Ok(f) = fs::File::open(path) {
    let _ = f.take(MAX_READ).read_to_end(&mut buf);
  }
  String::from_utf8_lossy(&buf).into_owned()
}

fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
  let mut v: Vec<PathBuf> = match fs::read_dir(dir) {
    Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
    Err(_) => return Vec::new(),
  };
  v.sort();
  v
}

fn walk(dir: &Path, prefix: &str, depth: usize, source: &'static str, budget: &mut usize, out: &mut Vec<SlashCommand>) {
  for path in sorted_entries(dir) {
    if *budget == 0 {
      return;
    }
    let Some(file) = path.file_name().and_then(|n| n.to_str()) else { continue };
    if file.starts_with('.') || file.chars().any(char::is_control) || file.contains(':') {
      continue;
    }
    let Ok(meta) = fs::metadata(&path) else { continue };
    if meta.is_dir() {
      if depth + 1 < MAX_DEPTH {
        walk(&path, &format!("{prefix}{file}:"), depth + 1, source, budget, out);
      }
    } else if let Some(stem) = file.strip_suffix(".md") {
      if stem.is_empty() || stem.contains(char::is_whitespace) {
        continue;
      }
      *budget -= 1;
      out.push(SlashCommand { name: format!("{prefix}{stem}"), description: describe(&read_head(&path)), source });
    }
  }
}

/// Сначала команды проекта, затем личные; не больше MAX_FILES файлов всего.
pub fn list_slash_commands(cwd: &Path, home: Option<&Path>) -> Vec<SlashCommand> {
  let mut out = Vec::new();
  let mut budget = MAX_FILES;
  let project = cwd.join(".claude/commands");
  let user = home.map(|h| h.join(".claude/commands"));
  walk(&project, "", 0, "project", &mut budget, &mut out);
  // cwd = домашний каталог: те же файлы не повторяем.
  if let Some(user) = user.filter(|u| fs::canonicalize(u).ok() != fs::canonicalize(&project).ok() || !project.exists()) {
    walk(&user, "", 0, "user", &mut budget, &mut out);
  }
  out
}

#[tauri::command(async)]
pub fn claude_slash_commands(cwd: String) -> Vec<SlashCommand> {
  list_slash_commands(Path::new(&cwd), dirs::home_dir().as_deref())
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  fn put(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
  }

  #[test]
  fn description_from_frontmatter() {
    assert_eq!(describe("---\nallowed-tools: Bash\ndescription: Сделать релиз\n---\nТело"), "Сделать релиз");
    assert_eq!(describe("---\ndescription: \"В кавычках\"\n---\n"), "В кавычках");
  }

  #[test]
  fn description_falls_back_to_first_line() {
    assert_eq!(describe("\n\n# Проверить тесты\nещё"), "Проверить тесты");
    assert_eq!(describe("---\nmodel: x\n---\n\nПервая строка тела"), "Первая строка тела");
    assert_eq!(describe(""), "");
  }

  #[test]
  fn description_is_clipped() {
    let d = describe(&"а".repeat(100));
    assert_eq!(d.chars().count(), 60);
    assert!(d.ends_with('…'));
  }

  #[test]
  fn lists_project_then_user_with_subdirs() {
    let proj = tempdir().unwrap();
    let home = tempdir().unwrap();
    put(proj.path(), ".claude/commands/release.md", "---\ndescription: Релиз\n---\n");
    put(proj.path(), ".claude/commands/git/sync.md", "Синхронизировать");
    put(proj.path(), ".claude/commands/notes.txt", "не команда");
    put(home.path(), ".claude/commands/fix.md", "Починить");
    let v = list_slash_commands(proj.path(), Some(home.path()));
    let got: Vec<(&str, &str, &str)> = v.iter().map(|c| (c.name.as_str(), c.description.as_str(), c.source)).collect();
    assert_eq!(
      got,
      vec![("git:sync", "Синхронизировать", "project"), ("release", "Релиз", "project"), ("fix", "Починить", "user")]
    );
  }

  #[test]
  fn missing_dirs_give_empty_list() {
    let proj = tempdir().unwrap();
    assert!(list_slash_commands(proj.path(), None).is_empty());
  }

  #[test]
  fn home_as_cwd_is_not_listed_twice() {
    let home = tempdir().unwrap();
    put(home.path(), ".claude/commands/a.md", "A");
    let v = list_slash_commands(home.path(), Some(home.path()));
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].source, "project");
  }

  #[test]
  fn limits_files_and_bytes() {
    let proj = tempdir().unwrap();
    for i in 0..250 {
      put(proj.path(), &format!(".claude/commands/c{i:03}.md"), "x");
    }
    let home = tempdir().unwrap();
    put(home.path(), ".claude/commands/late.md", "x");
    let v = list_slash_commands(proj.path(), Some(home.path()));
    assert_eq!(v.len(), MAX_FILES);
    // Описание за пределами первых 8 КБ не читается.
    let big = tempdir().unwrap();
    put(big.path(), ".claude/commands/big.md", &format!("{}\nпоздно", "\n".repeat(9000)));
    assert_eq!(list_slash_commands(big.path(), None)[0].description, "");
  }

  #[test]
  fn depth_is_bounded() {
    let proj = tempdir().unwrap();
    put(proj.path(), ".claude/commands/a/b/c/d/deep.md", "x");
    put(proj.path(), ".claude/commands/a/b/ok.md", "x");
    let v = list_slash_commands(proj.path(), None);
    let names: Vec<&str> = v.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["a:b:ok"]);
  }
}
