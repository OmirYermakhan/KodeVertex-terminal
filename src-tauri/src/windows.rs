//! Несколько окон: открытие нового окна (пустого, с перенесённой вкладкой или восстановленного
//! из сессии), передача вкладки в другое окно, поиск окна под курсором.
//!
//! Payload нового окна (`WindowInit` фронта) хранится под его меткой, пока окно не заберёт его
//! `window_take_init`. Порядок открытия окон — в `session::Pieces` (там же части сессии).

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Событие окну-приёмнику: прими вкладку (payload — `{kind:'transfer', tab}`).
pub const RECEIVE_EVENT: &str = "tab://receive";
/// Размер нового окна, если взять его не у кого (как у `main` в tauri.conf.json).
const DEFAULT_SIZE: (f64, f64) = (1280.0, 800.0);
const MIN_SIZE: (f64, f64) = (640.0, 400.0);
/// Смещение левого верхнего угла окна от курсора: полоса вкладок оказывается под курсором.
const GRAB_OFFSET: (f64, f64) = (120.0, 18.0);
const TITLE: &str = "KodeVertex Terminal";

/// Payload новых окон до `window_take_init`.
#[derive(Default)]
pub struct WindowInits(Mutex<HashMap<String, Value>>);

impl WindowInits {
  fn put(&self, label: &str, payload: Value) {
    self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(label.to_string(), payload);
  }

  pub fn take(&self, label: &str) -> Option<Value> {
    self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(label)
  }
}

/// Логический прямоугольник окна (x, y, ширина, высота) из физических позиции и размера.
pub fn logical_rect(pos: (i32, i32), size: (u32, u32), scale: f64) -> (f64, f64, f64, f64) {
  let s = if scale > 0.0 { scale } else { 1.0 };
  (pos.0 as f64 / s, pos.1 as f64 / s, size.0 as f64 / s, size.1 as f64 / s)
}

/// Точка внутри прямоугольника (левая и верхняя граница включительно).
pub fn contains(rect: (f64, f64, f64, f64), x: f64, y: f64) -> bool {
  let (rx, ry, w, h) = rect;
  x >= rx && x < rx + w && y >= ry && y < ry + h
}

/// Левый верхний угол нового окна для курсора (x, y).
pub fn grab_origin(x: f64, y: f64) -> (f64, f64) {
  (x - GRAB_OFFSET.0, y - GRAB_OFFSET.1)
}

/// Логический внутренний размер окна.
fn logical_size<R: Runtime>(w: &WebviewWindow<R>) -> Option<(f64, f64)> {
  let size = w.inner_size().ok()?;
  let scale = w.scale_factor().ok()?;
  Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// Открыть окно `w-<uuid>` с параметрами `main` (tauri.conf.json). `size` — логический размер
/// (None — 1280×800), `origin` — логический левый верхний угол (None — по центру).
/// `payload` ждёт `window_take_init` нового окна. Вызывать не из главного потока синхронно:
/// build ждёт главный поток (асинхронная команда или отдельная задача).
pub fn open<R: Runtime>(
  app: &AppHandle<R>,
  payload: Option<Value>,
  size: Option<(f64, f64)>,
  origin: Option<(f64, f64)>,
) -> Result<String, String> {
  let label = format!("w-{}", uuid::Uuid::new_v4().simple());
  if let Some(p) = payload {
    app.state::<WindowInits>().put(&label, p);
  }
  // Порядок окон для файла сессии: новое — последним.
  app.state::<crate::session::Pieces>().register(&label);
  let (w, h) = size.unwrap_or(DEFAULT_SIZE);
  let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
    .title(TITLE)
    .inner_size(w.max(MIN_SIZE.0), h.max(MIN_SIZE.1))
    .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
    .resizable(true)
    .fullscreen(false)
    .focused(true);
  #[cfg(target_os = "macos")]
  {
    b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
  }
  b = match origin {
    Some((x, y)) => b.position(x, y),
    None => b.center(),
  };
  let win = match b.build() {
    Ok(w) => w,
    Err(e) => {
      app.state::<WindowInits>().take(&label);
      app.state::<crate::session::Pieces>().forget(&label);
      return Err(e.to_string());
    }
  };
  // Кнопки окна — как у главного (свой отступ под полосу вкладок); AppKit — в главном потоке.
  #[cfg(target_os = "macos")]
  {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || crate::traffic_lights::apply(w.ns_window()));
  }
  let _ = win.set_focus();
  Ok(label)
}

/// Окно с меню ⌘N или восстановление сессии: размер — как у окна в фокусе (если есть).
pub fn focused_size<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
  app.webview_windows().values().find(|w| w.is_focused().unwrap_or(false)).and_then(logical_size)
}

/// Новое окно. `payload` — `WindowInit` фронта (`{kind:'transfer', tab}` и т. п.; None — пустое
/// окно с одной новой вкладкой). `x, y` — экранные логические координаты курсора: полоса вкладок
/// нового окна окажется под ним. Возвращает метку окна. Асинхронная: создание окна из
/// синхронной команды может заблокировать главный поток.
#[tauri::command]
pub async fn window_open(
  app: AppHandle,
  window: WebviewWindow,
  payload: Option<Value>,
  x: Option<f64>,
  y: Option<f64>,
) -> Result<String, String> {
  let origin = x.zip(y).map(|(x, y)| grab_origin(x, y));
  open(&app, payload, logical_size(&window), origin)
}

/// Payload своего окна (один раз): что показать при запуске.
#[tauri::command]
pub fn window_take_init(window: WebviewWindow, inits: tauri::State<'_, WindowInits>) -> Option<Value> {
  inits.take(window.label())
}

/// Передать вкладку окну `target` (событие `tab://receive`) и дать ему фокус.
#[tauri::command]
pub fn window_send_tab(app: AppHandle, target: String, payload: Value) -> Result<(), String> {
  let w = app.get_webview_window(&target).ok_or_else(|| format!("нет окна {target}"))?;
  app.emit_to(target.as_str(), RECEIVE_EVENT, payload).map_err(|e| e.to_string())?;
  let _ = w.set_focus();
  Ok(())
}

/// Метка другого (не вызывающего) видимого окна приложения, чей внешний прямоугольник содержит
/// экранную логическую точку (x, y). Окна в порядке z неизвестны: при перекрытии — окно в фокусе,
/// иначе первое найденное.
#[tauri::command]
pub fn window_at(app: AppHandle, window: WebviewWindow, x: f64, y: f64) -> Option<String> {
  let mut hits: Vec<(bool, String)> = app
    .webview_windows()
    .into_iter()
    .filter(|(label, w)| {
      label != window.label() && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
    })
    .filter_map(|(label, w)| {
      let pos = w.outer_position().ok()?;
      let size = w.outer_size().ok()?;
      let scale = w.scale_factor().ok()?;
      contains(logical_rect((pos.x, pos.y), (size.width, size.height), scale), x, y)
        .then(|| (w.is_focused().unwrap_or(false), label))
    })
    .collect();
  hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
  hits.into_iter().next().map(|(_, l)| l)
}

/// Сколько окон открыто.
#[tauri::command]
pub fn window_count(app: AppHandle) -> usize {
  app.webview_windows().len()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_are_stable() {
    assert_eq!(RECEIVE_EVENT, "tab://receive");
  }

  #[test]
  fn rect_is_converted_by_scale() {
    assert_eq!(logical_rect((200, 100), (2560, 1600), 2.0), (100.0, 50.0, 1280.0, 800.0));
    assert_eq!(logical_rect((-300, 0), (600, 400), 1.0), (-300.0, 0.0, 600.0, 400.0));
    // Неверный масштаб не делит на ноль.
    assert_eq!(logical_rect((10, 10), (20, 20), 0.0), (10.0, 10.0, 20.0, 20.0));
  }

  #[test]
  fn contains_is_half_open() {
    let r = (100.0, 50.0, 200.0, 100.0);
    assert!(contains(r, 100.0, 50.0));
    assert!(contains(r, 299.9, 149.9));
    assert!(!contains(r, 300.0, 100.0));
    assert!(!contains(r, 150.0, 150.0));
    assert!(!contains(r, 99.0, 60.0));
    // Второй монитор слева — отрицательные координаты.
    assert!(contains((-1440.0, 0.0, 1440.0, 900.0), -10.0, 10.0));
  }

  #[test]
  fn tab_strip_lands_under_cursor() {
    assert_eq!(grab_origin(500.0, 300.0), (380.0, 282.0));
  }
}
