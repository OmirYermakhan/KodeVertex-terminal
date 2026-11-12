//! История команд zsh для строки ввода: `$HISTFILE` / `$ZDOTDIR/.zsh_history` / `~/.zsh_history`.

use std::path::PathBuf;

/// Сколько последних команд отдаём фронтенду.
pub const HISTORY_LIMIT: usize = 5000;

/// Байт-признак «метафикации» zsh: следующий байт хранится как `byte ^ 32`.
const META: u8 = 0x83;

/// Снять метафикацию zsh (`0x83, b ^ 32` → `b`).
pub fn unmetafy(raw: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(raw.len());
  let mut i = 0;
  while i < raw.len() {
    if raw[i] == META && i + 1 < raw.len() {
      out.push(raw[i + 1] ^ 32);
      i += 2;
    } else {
      out.push(raw[i]);
      i += 1;
    }
  }
  out
}

/// Префикс расширенного формата `: <ts>:<dur>;` — длина, если строка с него начинается.
fn extended_prefix(line: &str) -> Option<usize> {
  let rest = line.strip_prefix(": ")?;
  let semi = rest.find(';')?;
  let (ts, dur) = rest[..semi].split_once(':')?;
  let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
  (digits(ts) && digits(dur)).then_some(2 + semi + 1)
}

/// Разбор файла истории: обычный и расширенный формат, многострочные записи
/// (строка, оканчивающаяся `\`, продолжается следующей). Последние `limit` команд, старые первыми.
pub fn parse_history(raw: &[u8], limit: usize) -> Vec<String> {
  let text = String::from_utf8_lossy(&unmetafy(raw)).into_owned();
  let mut out: Vec<String> = Vec::new();
  let mut cur: Option<String> = None;
  for line in text.split('\n') {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let piece = match cur {
      Some(_) => line,
      None => match extended_prefix(line) {
        Some(n) => &line[n..],
        None => line,
      },
    };
    let (body, more) = match piece.strip_suffix('\\') {
      Some(b) => (b, true),
      None => (piece, false),
    };
    let acc = match cur.take() {
      Some(mut s) => {
        s.push('\n');
        s.push_str(body);
        s
      }
      None => body.to_string(),
    };
    if more {
      cur = Some(acc);
    } else if !acc.trim().is_empty() {
      out.push(acc);
    }
  }
  if let Some(s) = cur {
    if !s.trim().is_empty() {
      out.push(s);
    }
  }
  if out.len() > limit {
    out.drain(..out.len() - limit);
  }
  out
}

fn history_path() -> Option<PathBuf> {
  if let Some(p) = std::env::var_os("HISTFILE").filter(|p| !p.is_empty()) {
    return Some(PathBuf::from(p));
  }
  if let Some(d) = std::env::var_os("ZDOTDIR").filter(|p| !p.is_empty()) {
    return Some(PathBuf::from(d).join(".zsh_history"));
  }
  dirs::home_dir().map(|h| h.join(".zsh_history"))
}

/// Последние команды истории zsh (старые первыми). Нет файла — пустой список.
#[tauri::command]
pub async fn shell_history() -> Vec<String> {
  let Some(path) = history_path() else { return Vec::new() };
  match std::fs::read(&path) {
    Ok(raw) => parse_history(&raw, HISTORY_LIMIT),
    Err(_) => Vec::new(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plain_format() {
    assert_eq!(parse_history(b"ls\ngit status\n\n", 10), vec!["ls", "git status"]);
  }

  #[test]
  fn extended_format() {
    let raw = b": 1700000000:0;ls -la\n: 1700000001:12;make build\n";
    assert_eq!(parse_history(raw, 10), vec!["ls -la", "make build"]);
  }

  #[test]
  fn extended_prefix_needs_digits() {
    // Обычная команда, похожая на префикс, не обрезается.
    assert_eq!(parse_history(b": abc:0;x\n", 10), vec![": abc:0;x"]);
  }

  #[test]
  fn multiline_entries() {
    let raw = b": 1:0;for i in 1 2; do\\\n  echo $i\\\ndone\nls\n";
    assert_eq!(parse_history(raw, 10), vec!["for i in 1 2; do\n  echo $i\ndone", "ls"]);
  }

  #[test]
  fn metafied_utf8() {
    // «cd Д»: Д = D0 94; 0x94 в zsh метафицируется как 83 B4.
    let raw = [b"cd \xD0".as_slice(), &[META, 0x94 ^ 32], b"\n"].concat();
    assert_eq!(parse_history(&raw, 10), vec!["cd Д"]);
  }

  #[test]
  fn keeps_last_limit() {
    let raw: String = (0..10).map(|i| format!("c{i}\n")).collect();
    assert_eq!(parse_history(raw.as_bytes(), 3), vec!["c7", "c8", "c9"]);
  }

  #[test]
  fn invalid_utf8_is_lossy_not_fatal() {
    assert_eq!(parse_history(b"a\xFFb\n", 10), vec!["a\u{FFFD}b"]);
  }

  #[test]
  fn unterminated_continuation_is_kept() {
    assert_eq!(parse_history(b"echo a\\", 10), vec!["echo a"]);
  }
}
