// Сохранённая сессия окон (вкладки, панели, каталоги, Claude-сессии, лента): JSON в папке данных
// приложения. Формат и версию знает фронтенд; здесь — атомарная запись, предел размера и `.bak`.
//
// Несколько окон: каждое присылает свою часть (`session_save`), Rust держит части в порядке
// открытия окон и пишет файл: верхний уровень — часть самого старого живого окна (старые сборки
// читают его как раньше), `windows: [...]` — части остальных.
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

/// Больше — не пишем (фронтенд урезает ленту до записи; это страховка).
pub const MAX_BYTES: usize = 24 * 1024 * 1024;
const FILE: &str = "session.json";
/// Поле файла с частями остальных окон.
const WINDOWS_KEY: &str = "windows";
/// Метка первого окна (из tauri.conf.json): только оно восстанавливает сессию из файла.
pub const MAIN_LABEL: &str = "main";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct PiecesState {
  /// Метки живых окон в порядке открытия.
  order: Vec<String>,
  /// Последняя присланная часть окна (текст JSON-объекта).
  pieces: HashMap<String, Arc<str>>,
  /// Окна из `windows[]` уже открыты (первый `session_load` окна main).
  restored: bool,
  /// Окно main подтвердило версию файла (`session_confirm` или своё `session_save`): до этого
  /// файл не пишется — файл более новой сборки не затрут окна `w-*` (⌘N, восстановленные).
  confirmed: bool,
}

/// Части сессии окон и порядок окон.
#[derive(Default)]
pub struct Pieces {
  state: Mutex<PiecesState>,
  /// Запись файла по одной: собираем и пишем под этим замком — последним всегда ложится
  /// самое свежее состояние.
  write: Mutex<()>,
}

impl Pieces {
  /// Окно открыто: в конец порядка (повтор — без изменений).
  pub fn register(&self, label: &str) {
    let mut st = lock(&self.state);
    if !st.order.iter().any(|l| l == label) {
      st.order.push(label.to_string());
    }
  }

  /// Окно закрыто при других живых: его часть больше не пишется.
  pub fn forget(&self, label: &str) {
    let mut st = lock(&self.state);
    st.order.retain(|l| l != label);
    st.pieces.remove(label);
  }

  /// Часть окна `label`. Окно не из порядка (уже закрытое: запоздалая запись при закрытии) —
  /// не принимается, иначе закрытое окно воскресло бы при следующем запуске. false — не принята.
  pub fn set(&self, label: &str, text: &str) -> bool {
    let mut st = lock(&self.state);
    if !st.order.iter().any(|l| l == label) {
      return false;
    }
    st.pieces.insert(label.to_string(), Arc::from(text));
    true
  }

  /// Последняя часть окна (перезагрузка страницы `w-*` восстанавливает по ней свои вкладки).
  pub fn piece(&self, label: &str) -> Option<Arc<str>> {
    lock(&self.state).pieces.get(label).cloned()
  }

  /// Версия файла подтверждена окном main: дальше файл пишется.
  pub fn confirm(&self) {
    lock(&self.state).confirmed = true;
  }

  fn confirmed(&self) -> bool {
    lock(&self.state).confirmed
  }

  /// Первый вызов — true (пора открывать окна из `windows[]`).
  fn begin_restore(&self) -> bool {
    !std::mem::replace(&mut lock(&self.state).restored, true)
  }

  /// Части в порядке окон (окна без части пропускаются).
  fn snapshot(&self) -> Vec<Arc<str>> {
    let st = lock(&self.state);
    st.order.iter().filter_map(|l| st.pieces.get(l).cloned()).collect()
  }

  /// Собрать файл из частей и записать атомарно. Частей нет или версия не подтверждена (`confirm`)
  /// — файл не трогается.
  pub fn write_to(&self, path: &Path) -> Result<(), String> {
    let _w = lock(&self.write);
    if !self.confirmed() {
      return Ok(());
    }
    let parts = self.snapshot();
    if parts.is_empty() {
      return Ok(());
    }
    let refs: Vec<&str> = parts.iter().map(|p| &**p).collect();
    save_to(path, &compose(&refs)?)
  }
}

/// Проверка части окна: JSON-объект от фронта не больше `MAX_BYTES`. Полный разбор до 24 МБ на
/// каждую запись не нужен — смотрим лишь на `{` … `}`.
fn check_piece(text: &str) -> Result<&str, String> {
  if text.len() > MAX_BYTES {
    return Err(format!("сессия больше {} МБ", MAX_BYTES / 1024 / 1024));
  }
  let t = text.trim();
  if !t.starts_with('{') || !t.ends_with('}') {
    return Err("сессия — не объект".into());
  }
  Ok(t)
}

/// Файл сессии из частей окон (в порядке открытия): первая — верхний уровень, остальные — в
/// `windows: [...]` (дописывается перед закрывающей `}` первой части, без разбора JSON).
/// Части — объекты от фронта без собственного поля `windows`.
pub fn compose(parts: &[&str]) -> Result<String, String> {
  let (first, rest) = parts.split_first().ok_or("нет частей сессии")?;
  let first = check_piece(first)?;
  if rest.is_empty() {
    return Ok(first.to_string());
  }
  let rest: Vec<&str> = rest.iter().map(|p| check_piece(p)).collect::<Result<_, _>>()?;
  // Без закрывающей `}`; пустой объект — без запятой.
  let body = first[..first.len() - 1].trim_end();
  let sep = if body == "{" { "" } else { "," };
  let total = body.len() + rest.iter().map(|p| p.len() + 1).sum::<usize>() + WINDOWS_KEY.len() + 8;
  if total > MAX_BYTES {
    return Err(format!("сессия больше {} МБ", MAX_BYTES / 1024 / 1024));
  }
  let mut out = String::with_capacity(total);
  out.push_str(body);
  out.push_str(sep);
  out.push('"');
  out.push_str(WINDOWS_KEY);
  out.push_str("\":[");
  out.push_str(&rest.join(","));
  out.push_str("]}");
  Ok(out)
}

/// Разобрать файл на верхний уровень (без `windows`) и части остальных окон (только объекты).
pub fn split(mut top: Value) -> (Value, Vec<Value>) {
  let others = match top.as_object_mut().and_then(|o| o.remove(WINDOWS_KEY)) {
    Some(Value::Array(a)) => a.into_iter().filter(Value::is_object).collect(),
    _ => Vec::new(),
  };
  (top, others)
}

fn session_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
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

/// Атомарная запись (уникальный временный файл, sync_all, rename). Текст — JSON-объект от фронта:
/// полный разбор до 24 МБ на каждую запись не нужен, проверяем лишь, что это объект (`{`).
/// Битый файл всё равно не потеряет сессию: при чтении он уходит в `.bak`.
pub fn save_to(path: &Path, text: &str) -> Result<(), String> {
  if text.len() > MAX_BYTES {
    return Err(format!("сессия больше {} МБ", MAX_BYTES / 1024 / 1024));
  }
  if text.trim_start().as_bytes().first() != Some(&b'{') {
    return Err("сессия — не объект".into());
  }
  crate::settings::atomic_write(path, text.as_bytes())
}

/// Сессия окна `main`: верхний уровень файла (без `windows`). При первом вызове открывает по
/// окну на каждый элемент `windows` с payload `{kind:'restore', session}` (окна заберут его
/// `window_take_init`). Остальным окнам — `None`. Чтение и разбор (до 24 МБ) — в пуле
/// блокирующих задач, не в главном потоке.
#[tauri::command]
pub async fn session_load(app: AppHandle, window: WebviewWindow) -> Option<Value> {
  if window.label() != MAIN_LABEL {
    return None;
  }
  let path = session_path(&app)?;
  let file = crate::blocking(move || load_from(&path)).await.ok().flatten()?;
  let (top, others) = split(file);
  let pieces = app.state::<Pieces>();
  if pieces.begin_restore() {
    // Части восстановленных окон — сразу в набор: выход до их первого сохранения их не потеряет.
    pieces.set(MAIN_LABEL, &top.to_string());
    let size = crate::windows::focused_size(&app);
    for session in others {
      let text = session.to_string();
      match crate::windows::open(&app, Some(serde_json::json!({ "kind": "restore", "session": session })), size, None) {
        Ok(label) => {
          pieces.set(&label, &text);
        }
        Err(e) => log::warn!("не удалось восстановить окно: {e}"),
      }
    }
  }
  Some(top)
}

/// Часть сессии окна-вызывателя; файл собирается из частей всех окон (см. `compose`). Пока окно
/// main не подтвердило версию файла, часть запоминается, но файл не пишется.
#[tauri::command]
pub async fn session_save(app: AppHandle, window: WebviewWindow, text: String) -> Result<(), String> {
  let path = session_path(&app).ok_or("не найдена папка данных приложения")?;
  check_piece(&text)?;
  let pieces = app.state::<Pieces>();
  if !pieces.set(window.label(), &text) {
    return Err(format!("окно {} уже закрыто", window.label()));
  }
  // main пишет сессию, только если файл его версии (или его нет): версия подтверждена.
  if window.label() == MAIN_LABEL {
    pieces.confirm();
  }
  crate::blocking(move || app.state::<Pieces>().write_to(&path)).await?
}

/// Окно main прочитало файл сессии, и он его версии (или файла нет): файл можно писать — в том
/// числе частями других окон. Файл более новой сборки main не подтверждает, и окна `w-*` его не
/// затрут. Другие окна подтвердить не могут.
#[tauri::command]
pub fn session_confirm(window: WebviewWindow, pieces: tauri::State<'_, Pieces>) {
  if window.label() == MAIN_LABEL {
    pieces.confirm();
  }
}

/// Payload `window_take_init` для окна без своего payload (страница перезагружена): его последняя
/// часть сессии — `{kind:'restore', session}`. Нет части или она не JSON — None (одна новая вкладка).
pub fn restore_init(piece: Option<&str>) -> Option<Value> {
  let session: Value = serde_json::from_str(piece?).ok().filter(Value::is_object)?;
  Some(serde_json::json!({ "kind": "restore", "session": session }))
}

/// Окно `label` уничтожено. Другие окна живы и приложение не выходит — его часть забывается,
/// файл переписывается. Последнее окно (или выход): части не трогаем — их ждёт следующий запуск.
pub fn on_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
  let others = app.webview_windows().keys().any(|l| l != label);
  if !others || app.state::<crate::exit::ExitFlow>().started() {
    return;
  }
  app.state::<Pieces>().forget(label);
  let Some(path) = session_path(app) else { return };
  let app = app.clone();
  std::thread::spawn(move || {
    if let Err(e) = app.state::<Pieces>().write_to(&path) {
      log::warn!("не удалось переписать сессию после закрытия окна: {e}");
    }
  });
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
    // Временных файлов рядом не остаётся.
    let names: Vec<_> = std::fs::read_dir(p.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from(FILE)]);
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
    assert!(save_to(&p, "").is_err());
    assert!(save_to(&p, "  \n").is_err());
    let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_BYTES));
    assert!(save_to(&p, &big).is_err());
    assert!(!p.exists());
  }

  #[test]
  fn compose_single_piece_is_as_is() {
    assert_eq!(compose(&[r#"{"version":1,"tabs":[]}"#]).unwrap(), r#"{"version":1,"tabs":[]}"#);
    assert!(compose(&[]).is_err());
  }

  #[test]
  fn compose_puts_other_windows_under_windows_key() {
    let a = r#"{"version":1,"tabs":["a"]}"#;
    let b = " {\"version\":1,\"tabs\":[\"b\"]}\n";
    let c = r#"{"version":1,"tabs":["c"]}"#;
    let out = compose(&[a, b, c]).unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
      v,
      json!({"version":1,"tabs":["a"],"windows":[{"version":1,"tabs":["b"]},{"version":1,"tabs":["c"]}]})
    );
    // Пустой объект первым — без лишней запятой.
    let v: Value = serde_json::from_str(&compose(&["{ }", a]).unwrap()).unwrap();
    assert_eq!(v, json!({"windows":[{"version":1,"tabs":["a"]}]}));
    // Битая часть — ошибка, файл не пишется.
    assert!(compose(&[a, "[1]"]).is_err());
    assert!(compose(&["nope", a]).is_err());
  }

  #[test]
  fn split_is_inverse_of_compose() {
    let out = compose(&[r#"{"version":1,"x":1}"#, r#"{"version":1,"x":2}"#]).unwrap();
    let (top, others) = split(serde_json::from_str(&out).unwrap());
    assert_eq!(top, json!({"version":1,"x":1}));
    assert_eq!(others, vec![json!({"version":1,"x":2})]);
    // Старый файл (одно окно) и мусор в `windows`.
    let (top, others) = split(json!({"version":1,"windows":[1,"x",{"a":1}]}));
    assert_eq!(top, json!({"version":1}));
    assert_eq!(others, vec![json!({"a":1})]);
    assert_eq!(split(json!({"version":1})).1, Vec::<Value>::new());
  }

  #[test]
  fn pieces_follow_window_order_and_forget() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(FILE);
    let s = Pieces::default();
    s.confirm();
    s.register("main");
    s.register("w-1");
    s.register("w-2");
    // Окна без части пропускаются; файл без частей не пишется.
    s.write_to(&p).unwrap();
    assert!(!p.exists());
    s.set("w-2", r#"{"n":2}"#);
    s.set("w-1", r#"{"n":1}"#);
    s.set("main", r#"{"n":0}"#);
    s.write_to(&p).unwrap();
    assert_eq!(load_from(&p).unwrap(), json!({"n":0,"windows":[{"n":1},{"n":2}]}));
    // Повторное сохранение заменяет часть, порядок прежний.
    s.set("w-1", r#"{"n":11}"#);
    s.write_to(&p).unwrap();
    assert_eq!(load_from(&p).unwrap(), json!({"n":0,"windows":[{"n":11},{"n":2}]}));
    // Закрыли main: самое старое живое окно — w-1, оно на верхнем уровне.
    s.forget("main");
    s.write_to(&p).unwrap();
    assert_eq!(load_from(&p).unwrap(), json!({"n":11,"windows":[{"n":2}]}));
    // Окно без register (уже закрытое) — не принимается.
    assert!(!s.set("w-9", r#"{"n":9}"#));
    assert!(!s.set("main", r#"{"n":0}"#), "закрытое main не воскресает");
    s.write_to(&p).unwrap();
    assert_eq!(load_from(&p).unwrap(), json!({"n":11,"windows":[{"n":2}]}));
  }

  /// До подтверждения версии окном main файл не пишется (файл более новой сборки цел).
  #[test]
  fn file_is_written_only_after_confirm() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(FILE);
    std::fs::write(&p, r#"{"version":99}"#).unwrap();
    let s = Pieces::default();
    s.register("main");
    s.register("w-1");
    assert!(s.set("w-1", r#"{"n":1}"#));
    s.write_to(&p).unwrap();
    assert_eq!(load_from(&p).unwrap(), json!({"version":99}));
    s.confirm();
    s.write_to(&p).unwrap();
    assert_eq!(load_from(&p).unwrap(), json!({"n":1}));
  }

  #[test]
  fn reload_restores_last_piece() {
    let s = Pieces::default();
    s.register("w-1");
    assert_eq!(restore_init(s.piece("w-1").as_deref()), None);
    s.set("w-1", r#"{"version":1,"tabs":[]}"#);
    assert_eq!(
      restore_init(s.piece("w-1").as_deref()),
      Some(json!({"kind":"restore","session":{"version":1,"tabs":[]}}))
    );
    assert_eq!(restore_init(Some("nope")), None);
    assert_eq!(restore_init(Some("[1]")), None);
  }

  #[test]
  fn restore_happens_once() {
    let s = Pieces::default();
    assert!(s.begin_restore());
    assert!(!s.begin_restore());
  }
}
