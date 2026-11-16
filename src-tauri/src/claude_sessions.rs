// Прошлые разговоры Claude Code каталога (`/resume` в режиме карточек): файлы
// `~/.claude/projects/<закодированный каталог>/<id сессии>.jsonl`, по строке JSON на событие.
// Список — новые первыми: первое сообщение пользователя как заголовок, время изменения, число
// сообщений. История — последние ходы разговора (сообщения пользователя и текст ответов).
// Чтение ограничено: файлов в списке, байт на файл, длины строки; служебные записи (мета,
// команды, уведомления, субагенты) пропускаются.
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Сколько самых свежих файлов разговоров разбирается для списка.
pub const MAX_LIST: usize = 50;
/// Сколько байт файла читается (для списка — с начала, для истории — с конца).
pub const MAX_SCAN: u64 = 64 * 1024 * 1024;
/// Строка длиннее не разбирается (большие результаты инструментов, картинки).
pub const MAX_LINE: usize = 4 * 1024 * 1024;
/// Заголовок в списке — первые символы первого сообщения.
pub const TITLE_CHARS: usize = 120;
/// История — последние ходы (сообщений пользователя) разговора.
pub const HISTORY_TURNS: usize = 20;
/// Одно сообщение истории обрезается до стольких символов.
pub const MESSAGE_CHARS: usize = 20_000;
/// Длинное закодированное имя каталога Claude Code обрезает и дописывает хеш.
const MAX_ENCODED: usize = 200;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SessionInfo {
  pub id: String,
  pub title: String,
  /// Время изменения файла, мс от эпохи.
  pub modified: u64,
  /// Сообщений (пользователя и ответов) в прочитанной части.
  pub messages: usize,
  /// Файл длиннее MAX_SCAN: messages — не все.
  pub partial: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct HistoryMessage {
  /// "user" | "assistant"
  pub role: &'static str,
  pub text: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SessionHistory {
  pub messages: Vec<HistoryMessage>,
  /// Сколько более ранних сообщений не загружено.
  pub skipped: usize,
  /// Стоимость разговора по данным CLI: `totalCostUSD` последней записи `cost-state` этого
  /// разговора в прочитанной части файла (её же CLI берёт за начало итога при `--resume`).
  /// None — записи нет: стоимость неизвестна.
  pub cost: Option<f64>,
}

/// Имя каталога проекта, как его строит Claude Code: всё, кроме латинских букв и цифр, — `-`
/// (по одному на единицу UTF-16, как `String.replace` в JS).
pub fn encode_cwd(cwd: &str) -> String {
  let mut s = String::with_capacity(cwd.len());
  for c in cwd.chars() {
    if c.is_ascii_alphanumeric() {
      s.push(c);
    } else {
      for _ in 0..c.len_utf16() {
        s.push('-');
      }
    }
  }
  s
}

/// `$CLAUDE_CONFIG_DIR/projects`, иначе `~/.claude/projects`.
fn projects_root() -> Option<PathBuf> {
  if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
    return Some(PathBuf::from(d).join("projects"));
  }
  dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Каталоги разговоров для cwd (как задан и без символических ссылок — claude видит второй).
/// Длинное имя: точного совпадения нет — ищется каталог с тем же началом и хешем после `-`.
pub fn project_dirs(root: &Path, cwd: &str) -> Vec<PathBuf> {
  let mut names = vec![encode_cwd(cwd)];
  if let Ok(real) = fs::canonicalize(cwd) {
    let e = encode_cwd(&real.to_string_lossy());
    if !names.contains(&e) {
      names.push(e);
    }
  }
  let mut out: Vec<PathBuf> = Vec::new();
  for name in names {
    let exact = root.join(&name);
    if exact.is_dir() {
      out.push(exact);
      continue;
    }
    if name.len() <= MAX_ENCODED {
      continue;
    }
    let prefix = format!("{}-", &name[..MAX_ENCODED]);
    if let Ok(rd) = fs::read_dir(root) {
      for e in rd.flatten() {
        if e.file_name().to_string_lossy().starts_with(&prefix) && e.path().is_dir() {
          out.push(e.path());
        }
      }
    }
  }
  out.dedup();
  out
}

/// id сессии — имя файла без `.jsonl`: только буквы, цифры и `-` (никаких путей).
pub fn valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Строки файла с позиции `from` (с середины строки — первая, неполная, пропускается), не больше
/// `max` байт; строки длиннее MAX_LINE не отдаются. f → false — хватит.
fn each_line(path: &Path, from: u64, max: u64, f: impl FnMut(&[u8]) -> bool) -> std::io::Result<()> {
  each_line_ex(path, from, max, true, f).map(|_| ())
}

/// Как `each_line`; `tail` — отдавать ли последнюю строку без `\n` (её, может быть, ещё дописывают).
/// Возвращает позицию сразу после последнего пройденного `\n`: с неё можно продолжить позже.
fn each_line_ex(path: &Path, from: u64, max: u64, tail: bool, mut f: impl FnMut(&[u8]) -> bool) -> std::io::Result<u64> {
  // Не обычный файл (FIFO на месте разговора) не читается: открытие без блокировки, тип — у дескриптора.
  let (mut file, _) = crate::attach::open_regular(path)?;
  // from посреди строки (перед ним не `\n`) — первая строка неполная.
  let mut skip_first = false;
  if from > 0 {
    file.seek(SeekFrom::Start(from - 1))?;
    let mut prev = [0u8; 1];
    file.read_exact(&mut prev)?;
    skip_first = prev[0] != b'\n';
  }
  let mut r = BufReader::with_capacity(64 * 1024, file);
  let mut read: u64 = 0;
  // Конец последней целой строки (после её `\n`) относительно from.
  let mut done: u64 = 0;
  let mut line: Vec<u8> = Vec::new();
  let mut too_long = false;
  loop {
    if read >= max {
      return Ok(from + done);
    }
    let buf = r.fill_buf()?;
    if buf.is_empty() {
      if tail && !line.is_empty() && !too_long && !skip_first {
        f(&line);
      }
      return Ok(from + done);
    }
    let take = buf.len().min((max - read) as usize);
    let chunk = &buf[..take];
    let (part, end) = match chunk.iter().position(|&b| b == b'\n') {
      Some(i) => (&chunk[..i], Some(i + 1)),
      None => (chunk, None),
    };
    if !too_long {
      if line.len() + part.len() > MAX_LINE {
        too_long = true;
        line = Vec::new();
      } else {
        line.extend_from_slice(part);
      }
    }
    let used = end.unwrap_or(take);
    r.consume(used);
    read += used as u64;
    if end.is_some() {
      done = read;
      let go = if too_long || skip_first { true } else { f(&line) };
      line.clear();
      too_long = false;
      skip_first = false;
      if !go {
        return Ok(from + done);
      }
    }
  }
}

/// Сообщение разговора из строки файла; None — служебное, мета, субагент, результат инструмента.
fn message_of(line: &[u8]) -> Option<HistoryMessage> {
  // Быстрый отсев без разбора JSON: в строке сообщения есть роль.
  let has = |pat: &[u8]| line.windows(pat.len()).any(|w| w == pat);
  if !has(b"\"user\"") && !has(b"\"assistant\"") {
    return None;
  }
  let v: Value = serde_json::from_slice(line).ok()?;
  let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
  if flag("isSidechain") || flag("isMeta") || flag("isCompactSummary") || flag("isVisibleInTranscriptOnly") {
    return None;
  }
  let msg = v.get("message")?;
  let content = msg.get("content")?;
  match v.get("type").and_then(Value::as_str)? {
    "user" => {
      // Уведомления задач и прочее не от человека.
      if let Some(kind) = v.get("origin").and_then(|o| o.get("kind")).and_then(Value::as_str)
        && kind != "human"
      {
        return None;
      }
      let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
          if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
            return None;
          }
          let texts: Vec<&str> = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect();
          if texts.is_empty() && blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("image")) {
            "[Изображение]".to_string()
          } else {
            texts.join("\n")
          }
        }
        _ => return None,
      };
      let text = text.trim();
      if text.is_empty() || is_service(text) {
        return None;
      }
      Some(HistoryMessage { role: "user", text: text.to_string() })
    }
    "assistant" => {
      if msg.get("model").and_then(Value::as_str) == Some("<synthetic>") {
        return None;
      }
      let blocks = content.as_array()?;
      let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n");
      let text = text.trim();
      if text.is_empty() {
        return None;
      }
      Some(HistoryMessage { role: "assistant", text: text.to_string() })
    }
    _ => None,
  }
}

/// `totalCostUSD` записи `cost-state` разговора id; None — строка не такая запись.
fn cost_of(line: &[u8], id: &str) -> Option<f64> {
  if !line.windows(12).any(|w| w == b"\"cost-state\"") {
    return None;
  }
  let v: Value = serde_json::from_slice(line).ok()?;
  if v.get("type").and_then(Value::as_str) != Some("cost-state") || v.get("sessionId").and_then(Value::as_str) != Some(id) {
    return None;
  }
  v.get("totalCostUSD").and_then(Value::as_f64).filter(|c| c.is_finite() && *c >= 0.0)
}

/// Служебный текст в роли пользователя: slash-команды, их вывод, напоминания, уведомления.
fn is_service(text: &str) -> bool {
  const TAGS: [&str; 12] = [
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "system-reminder",
    "task-notification",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
    "user-prompt-submit-hook",
  ];
  let Some(rest) = text.strip_prefix('<') else { return false };
  TAGS.iter().any(|t| rest.strip_prefix(t).is_some_and(|r| r.starts_with('>')))
}

/// Подряд идущие куски ответа (текст между вызовами инструментов) — одним сообщением.
/// Сообщение длиннее MESSAGE_CHARS всё равно обрезается: дальше не дописываем (память).
fn push_message(out: &mut VecDeque<HistoryMessage>, m: HistoryMessage) {
  if m.role == "assistant"
    && let Some(last) = out.back_mut()
    && last.role == "assistant"
  {
    // Байт больше 4·N — символов точно больше N: обрезка даст то же самое.
    if last.text.len() <= MESSAGE_CHARS * 4 {
      last.text.push_str("\n\n");
      last.text.push_str(&m.text);
    }
    return;
  }
  out.push_back(m);
}

fn clip(s: &str, max: usize) -> String {
  match s.char_indices().nth(max) {
    Some((i, _)) => format!("{}…", s[..i].trim_end()),
    None => s.to_string(),
  }
}

/// Заголовок: первое сообщение одной строкой.
fn title_of(text: &str) -> String {
  clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), TITLE_CHARS)
}

/// Разобранная часть файла для списка: где остановились и что насчитали. Файл разговора
/// только дописывается — при росте читаем лишь новый хвост, а не весь файл заново.
#[derive(Clone, Debug, Default)]
struct Summary {
  /// Позиция после последней целой разобранной строки.
  offset: u64,
  /// Первое сообщение пользователя.
  title: Option<String>,
  count: usize,
  last_assistant: bool,
}

impl Summary {
  /// Дочитывает файл с `offset` (не дальше MAX_SCAN от начала). Неполная последняя строка
  /// (её ещё пишут) не учитывается — её прочитаем целиком в следующий раз.
  fn advance(&mut self, path: &Path) -> std::io::Result<()> {
    if self.offset >= MAX_SCAN {
      return Ok(());
    }
    let s = &mut *self;
    let end = each_line_ex(path, s.offset, MAX_SCAN - s.offset, false, |line| {
      if let Some(m) = message_of(line) {
        let assistant = m.role == "assistant";
        if !assistant && s.title.is_none() {
          s.title = Some(title_of(&m.text));
        }
        // Куски одного ответа — одно сообщение (как в истории).
        if !(assistant && s.last_assistant) {
          s.count += 1;
        }
        s.last_assistant = assistant;
      }
      true
    })?;
    self.offset = end;
    Ok(())
  }

  fn result(&self, len: u64) -> Option<(String, usize, bool)> {
    self.title.clone().map(|t| (t, self.count, len > MAX_SCAN))
  }
}

fn millis(t: SystemTime) -> u64 {
  t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

type Cached = (SystemTime, u64, Summary);
/// Разбор файла не повторяется, пока он не изменился (время и размер); дописанный — дочитывается.
fn cache() -> &'static Mutex<HashMap<PathBuf, Cached>> {
  static C: OnceLock<Mutex<HashMap<PathBuf, Cached>>> = OnceLock::new();
  C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn summarize_cached(path: &Path, modified: SystemTime, len: u64) -> Option<(String, usize, bool)> {
  let prev = cache().lock().ok().and_then(|c| c.get(path).cloned());
  let mut s = match prev {
    Some((m, l, s)) if m == modified && l == len => return s.result(len),
    // Вырос — дочитываем хвост; укоротился (переписан) — с начала.
    Some((_, l, s)) if len >= l && s.offset <= len => s,
    _ => Summary::default(),
  };
  s.advance(path).ok()?;
  let r = s.result(len);
  if let Ok(mut c) = cache().lock() {
    c.insert(path.to_path_buf(), (modified, len, s));
  }
  r
}

/// Разговоры каталога cwd в корне root, новые первыми (не больше MAX_LIST файлов).
pub fn list_sessions(root: &Path, cwd: &str) -> Vec<SessionInfo> {
  let mut files: Vec<(String, PathBuf, SystemTime, u64)> = Vec::new();
  for dir in project_dirs(root, cwd) {
    let Ok(rd) = fs::read_dir(&dir) else { continue };
    for e in rd.flatten() {
      let p = e.path();
      if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
        continue;
      }
      let Some(id) = p.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
      if !valid_id(&id) || files.iter().any(|f| f.0 == id) {
        continue;
      }
      let Ok(md) = e.metadata() else { continue };
      if !md.is_file() {
        continue;
      }
      files.push((id, p, md.modified().unwrap_or(UNIX_EPOCH), md.len()));
    }
  }
  files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
  files.truncate(MAX_LIST);
  files
    .into_iter()
    .filter_map(|(id, p, m, len)| {
      let (title, messages, partial) = summarize_cached(&p, m, len)?;
      Some(SessionInfo { id, title, modified: millis(m), messages, partial })
    })
    .collect()
}

/// История разговора id: последние HISTORY_TURNS ходов из последних MAX_SCAN байт файла.
pub fn read_history(root: &Path, cwd: &str, id: &str) -> Result<SessionHistory, String> {
  if !valid_id(id) {
    return Err("неверный id разговора".into());
  }
  let path = project_dirs(root, cwd)
    .into_iter()
    .map(|d| d.join(format!("{id}.jsonl")))
    // Символическая ссылка вместо файла не читается (как и в списке).
    .find(|p| fs::symlink_metadata(p).is_ok_and(|m| m.is_file()))
    .ok_or("разговор не найден")?;
  let len = fs::metadata(&path).map_err(|e| e.to_string())?.len();
  let from = len.saturating_sub(MAX_SCAN);
  // В памяти — только последние HISTORY_TURNS ходов: более ранние сообщения вытесняются по ходу чтения.
  let mut kept: VecDeque<HistoryMessage> = VecDeque::new();
  let mut users = 0usize;
  let mut skipped = 0usize;
  let mut cost: Option<f64> = None;
  each_line(&path, from, MAX_SCAN, |line| {
    if let Some(m) = message_of(line) {
      if m.role == "user" {
        users += 1;
      }
      push_message(&mut kept, m);
      while users > HISTORY_TURNS {
        if let Some(old) = kept.pop_front() {
          skipped += 1;
          if old.role == "user" {
            users -= 1;
          }
        }
      }
    } else if let Some(c) = cost_of(line, id) {
      cost = Some(c);
    }
    true
  })
  .map_err(|e| e.to_string())?;
  // Начало — с HISTORY_TURNS-го с конца сообщения пользователя (ответы перед ним не нужны).
  if users == HISTORY_TURNS {
    while kept.front().is_some_and(|m| m.role != "user") {
      kept.pop_front();
      skipped += 1;
    }
  }
  let messages = kept.into_iter().map(|m| HistoryMessage { role: m.role, text: clip(&m.text, MESSAGE_CHARS) }).collect();
  Ok(SessionHistory { messages, skipped, cost })
}

#[tauri::command]
pub async fn claude_sessions(cwd: String) -> Result<Vec<SessionInfo>, String> {
  let root = projects_root().ok_or("не найден домашний каталог")?;
  tauri::async_runtime::spawn_blocking(move || list_sessions(&root, &cwd)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_session_history(cwd: String, id: String) -> Result<SessionHistory, String> {
  let root = projects_root().ok_or("не найден домашний каталог")?;
  tauri::async_runtime::spawn_blocking(move || read_history(&root, &cwd, &id)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use std::fs::File;
  use std::io::Write;

  fn user(text: &str) -> String {
    json!({"type":"user","isSidechain":false,"message":{"role":"user","content":text},"uuid":"u"}).to_string()
  }
  fn assistant(text: &str) -> String {
    json!({"type":"assistant","isSidechain":false,"message":{"role":"assistant","model":"m","content":[{"type":"text","text":text}]}}).to_string()
  }
  fn tool_use() -> String {
    json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Bash","input":{}}]}}).to_string()
  }
  fn tool_result() -> String {
    json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}).to_string()
  }

  fn write(dir: &Path, id: &str, lines: &[String]) -> PathBuf {
    let p = dir.join(format!("{id}.jsonl"));
    let mut f = File::create(&p).unwrap();
    for l in lines {
      writeln!(f, "{l}").unwrap();
    }
    p
  }

  fn set_mtime(p: &Path, secs: u64) {
    let f = File::options().write(true).open(p).unwrap();
    f.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs)).unwrap();
  }

  /// Корень projects и каталог проекта для cwd `/work/my proj`.
  fn setup() -> (tempfile::TempDir, PathBuf, &'static str) {
    let t = tempfile::tempdir().unwrap();
    let cwd = "/work/my proj";
    let dir = t.path().join(encode_cwd(cwd));
    fs::create_dir_all(&dir).unwrap();
    (t, dir, cwd)
  }

  #[test]
  fn encodes_cwd_like_claude_code() {
    assert_eq!(encode_cwd("/Users/x/projects/kv-term"), "-Users-x-projects-kv-term");
    assert_eq!(encode_cwd("/a/.hidden dir_1"), "-a--hidden-dir-1");
    // Не-ASCII — по `-` на единицу UTF-16.
    assert_eq!(encode_cwd("/дом"), "----");
    assert_eq!(encode_cwd("/😀"), "---");
  }

  #[test]
  fn lists_newest_first_with_title_and_count() {
    let (t, dir, cwd) = setup();
    let a = write(&dir, "aaa-1", &[user("первый   вопрос\nвторая строка"), tool_use(), tool_result(), assistant("ответ"), assistant("ещё"), user("второй"), assistant("ок")]);
    let b = write(&dir, "bbb-2", &[user("новый разговор")]);
    set_mtime(&a, 1000);
    set_mtime(&b, 2000);
    let l = list_sessions(t.path(), cwd);
    assert_eq!(l.len(), 2);
    assert_eq!(l[0].id, "bbb-2");
    assert_eq!(l[0].modified, 2_000_000);
    assert_eq!(l[1].title, "первый вопрос вторая строка");
    // user, ответ (два куска — одно), user, ответ.
    assert_eq!(l[1].messages, 4);
    assert!(!l[1].partial);
  }

  #[test]
  fn skips_meta_commands_sidechain_and_notifications() {
    let (t, dir, cwd) = setup();
    write(
      &dir,
      "s1",
      &[
        json!({"type":"summary","summary":"x"}).to_string(),
        json!({"type":"user","isMeta":true,"message":{"role":"user","content":"мета"}}).to_string(),
        user("<command-name>/model</command-name>"),
        user("<local-command-stdout>вывод</local-command-stdout>"),
        json!({"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>x</task-notification>"}}).to_string(),
        json!({"type":"user","isSidechain":true,"message":{"role":"user","content":"субагент"}}).to_string(),
        json!({"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"субагент"}]}}).to_string(),
        json!({"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"нет ответа"}]}}).to_string(),
        "не json".to_string(),
        json!({"type":"user","origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":"настоящий"}]}}).to_string(),
      ],
    );
    // Только служебное — в список не попадает.
    write(&dir, "s2", &[user("<command-name>/clear</command-name>"), assistant("x")]);
    let l = list_sessions(t.path(), cwd);
    assert_eq!(l.len(), 1);
    assert_eq!(l[0].title, "настоящий");
    assert_eq!(l[0].messages, 1);
    let h = read_history(t.path(), cwd, "s1").unwrap();
    assert_eq!(h.messages, vec![HistoryMessage { role: "user", text: "настоящий".into() }]);
  }

  #[test]
  fn image_only_message_and_long_title() {
    let (t, dir, cwd) = setup();
    let long = "я".repeat(300);
    write(&dir, "img", &[json!({"type":"user","message":{"role":"user","content":[{"type":"image","source":{}}]}}).to_string()]);
    write(&dir, "long", &[user(&long)]);
    let l = list_sessions(t.path(), cwd);
    let img = l.iter().find(|s| s.id == "img").unwrap();
    assert_eq!(img.title, "[Изображение]");
    let lt = &l.iter().find(|s| s.id == "long").unwrap().title;
    assert_eq!(lt.chars().count(), TITLE_CHARS + 1);
    assert!(lt.ends_with('…'));
  }

  #[test]
  fn list_is_capped_and_ignores_other_files() {
    let (t, dir, cwd) = setup();
    for i in 0..(MAX_LIST + 5) {
      let p = write(&dir, &format!("s{i:03}"), &[user(&format!("q{i}"))]);
      set_mtime(&p, 1000 + i as u64);
    }
    fs::write(dir.join("notes.txt"), "x").unwrap();
    fs::create_dir_all(dir.join("s000").join("subagents")).unwrap();
    write(&dir.join("s000").join("subagents"), "agent-1", &[user("субагент")]);
    let l = list_sessions(t.path(), cwd);
    assert_eq!(l.len(), MAX_LIST);
    assert_eq!(l[0].id, format!("s{:03}", MAX_LIST + 4));
    // Другой каталог — пусто, ошибки нет.
    assert!(list_sessions(t.path(), "/elsewhere").is_empty());
  }

  #[test]
  fn history_merges_answer_parts_and_keeps_last_turns() {
    let (t, dir, cwd) = setup();
    let mut lines = Vec::new();
    for i in 0..(HISTORY_TURNS + 3) {
      lines.push(user(&format!("вопрос {i}")));
      lines.push(assistant(&format!("часть {i}")));
      lines.push(tool_use());
      lines.push(tool_result());
      lines.push(assistant(&format!("итог {i}")));
    }
    write(&dir, "h", &lines);
    let h = read_history(t.path(), cwd, "h").unwrap();
    assert_eq!(h.skipped, 6);
    assert_eq!(h.messages.len(), HISTORY_TURNS * 2);
    assert_eq!(h.messages[0], HistoryMessage { role: "user", text: "вопрос 3".into() });
    assert_eq!(h.messages[1].text, "часть 3\n\nитог 3");
    assert_eq!(h.messages.last().unwrap().role, "assistant");
  }

  #[test]
  fn history_cost_is_last_cost_state_of_this_session() {
    let (t, dir, cwd) = setup();
    let cost = |sid: &str, c: f64| json!({"type":"cost-state","sessionId":sid,"totalCostUSD":c}).to_string();
    write(&dir, "c", &[user("вопрос"), cost("c", 0.1), assistant("ответ"), cost("c", 0.25), cost("other", 9.0)]);
    assert_eq!(read_history(t.path(), cwd, "c").unwrap().cost, Some(0.25));
    // Записи нет (или она чужого разговора) — стоимость неизвестна.
    write(&dir, "n", &[user("вопрос"), assistant("ответ"), cost("other", 1.0)]);
    assert_eq!(read_history(t.path(), cwd, "n").unwrap().cost, None);
  }

  #[test]
  fn history_rejects_bad_ids_and_missing_files() {
    let (t, _dir, cwd) = setup();
    assert!(read_history(t.path(), cwd, "../x").is_err());
    assert!(read_history(t.path(), cwd, "").is_err());
    assert!(read_history(t.path(), cwd, "nope").is_err());
  }

  #[test]
  fn long_lines_are_skipped_and_reads_are_bounded() {
    let (t, dir, cwd) = setup();
    let huge = user(&"x".repeat(MAX_LINE + 10));
    write(&dir, "big", &[huge, user("после"), assistant("ок")]);
    let l = list_sessions(t.path(), cwd);
    assert_eq!(l[0].title, "после");
    assert_eq!(l[0].messages, 2);
    // Ограничение по байтам: читается не дальше max, хвост с середины — без первой неполной строки.
    let p = write(&dir, "b2", &[user("один"), user("два"), user("три")]);
    let mut got = Vec::new();
    each_line(&p, 0, 5, |l| {
      got.push(l.to_vec());
      true
    })
    .unwrap();
    assert!(got.is_empty());
    let len = fs::metadata(&p).unwrap().len();
    let mut tail = Vec::new();
    each_line(&p, len - (user("три").len() as u64 + 3), 1 << 20, |l| {
      tail.push(message_of(l).map(|m| m.text));
      true
    })
    .unwrap();
    assert_eq!(tail, vec![Some("три".to_string())]);
    // from ровно на начале строки — она целая и не пропускается.
    let mut exact = Vec::new();
    each_line(&p, len - (user("три").len() as u64 + 1), 1 << 20, |l| {
      exact.push(message_of(l).map(|m| m.text));
      true
    })
    .unwrap();
    assert_eq!(exact, vec![Some("три".to_string())]);
    let mut two = Vec::new();
    each_line(&p, len - (user("три").len() as u64 + user("два").len() as u64 + 2), 1 << 20, |l| {
      two.push(message_of(l).map(|m| m.text));
      true
    })
    .unwrap();
    assert_eq!(two, vec![Some("два".to_string()), Some("три".to_string())]);
  }

  #[test]
  fn history_rejects_symlinked_file() {
    let (t, dir, cwd) = setup();
    let other = t.path().join("elsewhere.jsonl");
    fs::write(&other, format!("{}\n", user("чужой файл"))).unwrap();
    std::os::unix::fs::symlink(&other, dir.join("link.jsonl")).unwrap();
    assert!(list_sessions(t.path(), cwd).is_empty());
    assert!(read_history(t.path(), cwd, "link").is_err());
  }

  #[test]
  fn finds_dir_through_symlinked_cwd_and_long_names() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().join("projects");
    let real = t.path().join("real");
    fs::create_dir_all(&real).unwrap();
    let link = t.path().join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let real_c = fs::canonicalize(&real).unwrap();
    let dir = root.join(encode_cwd(&real_c.to_string_lossy()));
    fs::create_dir_all(&dir).unwrap();
    write(&dir, "x", &[user("через ссылку")]);
    let l = list_sessions(&root, &link.to_string_lossy());
    assert_eq!(l.len(), 1);
    // Длинный каталог: имя обрезано до 200 знаков + хеш.
    let long_cwd = format!("/{}", "d".repeat(250));
    let enc = encode_cwd(&long_cwd);
    let ldir = root.join(format!("{}-abc123", &enc[..MAX_ENCODED]));
    fs::create_dir_all(&ldir).unwrap();
    write(&ldir, "y", &[user("длинный")]);
    assert_eq!(list_sessions(&root, &long_cwd)[0].title, "длинный");
  }

  #[test]
  fn cache_refreshes_when_file_changes() {
    let (t, dir, cwd) = setup();
    let p = write(&dir, "c", &[user("раз")]);
    set_mtime(&p, 1000);
    assert_eq!(list_sessions(t.path(), cwd)[0].messages, 1);
    write(&dir, "c", &[user("раз"), assistant("два")]);
    set_mtime(&p, 2000);
    assert_eq!(list_sessions(t.path(), cwd)[0].messages, 2);
  }

  #[test]
  fn valid_ids() {
    assert!(valid_id("00000000-0000-4000-8000-000000000001"));
    assert!(!valid_id("a/b"));
    assert!(!valid_id("a.b"));
  }

  /// Дописанный файл дочитывается с прошлого места: строки до него повторно не разбираются.
  #[test]
  fn summary_is_incremental_and_skips_unfinished_line() {
    let (t, dir, cwd) = setup();
    let p = write(&dir, "inc", &[user("первый"), assistant("ответ")]);
    set_mtime(&p, 1000);
    let l = list_sessions(t.path(), cwd);
    assert_eq!((l[0].title.as_str(), l[0].messages), ("первый", 2));
    let off = cache().lock().unwrap().get(&p).unwrap().2.offset;
    assert_eq!(off, fs::metadata(&p).unwrap().len());
    // Портим уже разобранную часть (той же длины): при дочитывании она не перечитывается.
    let mut bytes = fs::read(&p).unwrap();
    bytes[..5].copy_from_slice(b"xxxxx");
    fs::write(&p, &bytes).unwrap();
    let mut f = File::options().append(true).open(&p).unwrap();
    writeln!(f, "{}", user("второй")).unwrap();
    // Строка без `\n` (её ещё пишут) не считается.
    write!(f, "{}", user("недописан")).unwrap();
    drop(f);
    set_mtime(&p, 2000);
    let l = list_sessions(t.path(), cwd);
    assert_eq!((l[0].title.as_str(), l[0].messages), ("первый", 3));
    let mut f = File::options().append(true).open(&p).unwrap();
    writeln!(f).unwrap();
    drop(f);
    set_mtime(&p, 3000);
    assert_eq!(list_sessions(t.path(), cwd)[0].messages, 4);
  }

  #[test]
  fn history_keeps_only_last_turns_in_order() {
    let (t, dir, cwd) = setup();
    let mut lines = vec![assistant("пролог")];
    for i in 0..(HISTORY_TURNS + 5) {
      lines.push(user(&format!("вопрос {i}")));
      lines.push(assistant(&format!("часть {i}")));
      lines.push(assistant(&format!("ещё {i}")));
    }
    write(&dir, "h", &lines);
    let h = read_history(t.path(), cwd, "h").unwrap();
    assert_eq!(h.messages.len(), HISTORY_TURNS * 2);
    assert_eq!(h.messages[0].text, "вопрос 5");
    assert_eq!(h.messages[1].text, "часть 5\n\nещё 5");
    // Пролог + 5 ранних ходов по 2 сообщения.
    assert_eq!(h.skipped, 1 + 5 * 2);
    // Ровно HISTORY_TURNS ходов: ответ до первого вопроса пропускается; меньше — показывается.
    let mut lines = vec![assistant("пролог")];
    for i in 0..HISTORY_TURNS {
      lines.push(user(&format!("в{i}")));
    }
    write(&dir, "e", &lines);
    let h = read_history(t.path(), cwd, "e").unwrap();
    assert_eq!((h.messages.len(), h.skipped, h.messages[0].text.as_str()), (HISTORY_TURNS, 1, "в0"));
    write(&dir, "s", &lines[..3]);
    let h = read_history(t.path(), cwd, "s").unwrap();
    assert_eq!((h.messages.len(), h.skipped, h.messages[0].text.as_str()), (3, 0, "пролог"));
  }
}
