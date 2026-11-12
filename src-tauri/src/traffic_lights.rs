//! Кнопки окна macOS (закрыть / свернуть / развернуть) внутри полосы вкладок.
//!
//! Конфиг `trafficLightPosition` в tao задаёт только высоту контейнера
//! (высота кнопки + y), а вертикальное место кнопки внутри него остаётся
//! системным — по центру 38-пиксельной полосы так не попасть. Кроме того,
//! AppKit возвращает кнопки на штатное место при изменении размера окна.
//! Поэтому положение задаётся здесь и переустанавливается на событиях окна.

/// Высота полосы вкладок (`.bar` в src/global.css).
pub const BAR_HEIGHT: f64 = 38.0;
/// Отступ первой кнопки от левого края окна (макет 04-main-window).
pub const LEFT_INSET: f64 = 14.0;

/// Рамка кнопки в координатах окна от левого верхнего угла.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ButtonRect {
  pub x: f64,
  pub top: f64,
}

/// Кнопки по центру полосы высотой `bar_height`: первая — в `left`,
/// следующие — через системный шаг `spacing` (между левыми краями).
pub fn button_rects(bar_height: f64, left: f64, button_height: f64, spacing: f64) -> [ButtonRect; 3] {
  let top = ((bar_height - button_height) / 2.0).max(0.0);
  [0.0, 1.0, 2.0].map(|i| ButtonRect { x: left + i * spacing, top })
}

#[cfg(target_os = "macos")]
pub fn apply(ns_window: tauri::Result<*mut std::ffi::c_void>) {
  use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask};
  use objc2_foundation::{NSPoint, NSRect, NSSize};

  let Ok(ptr) = ns_window else { return };
  if ptr.is_null() {
    return;
  }
  // SAFETY: tauri отдаёт живой NSWindow; вызывается на главном потоке.
  let window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
  // В полноэкранном режиме полосой заголовка управляет система.
  if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
    return;
  }
  let buttons = [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
    .map(|b| window.standardWindowButton(b));
  let [Some(close), Some(mini), Some(zoom)] = buttons else { return };
  let Some(titlebar) = (unsafe { close.superview() }) else { return };
  let Some(container) = (unsafe { titlebar.superview() }) else { return };

  let window_height = window.frame().size.height;
  // Контейнер кнопок — во всю высоту полосы, прижат к верху окна.
  let mut frame = NSView::frame(&container);
  frame.size.height = BAR_HEIGHT;
  frame.origin.y = window_height - BAR_HEIGHT;
  container.setFrame(frame);

  let size = close.frame().size;
  // Системный шаг между кнопками (зависит от версии macOS).
  let spacing = mini.frame().origin.x - close.frame().origin.x;
  let spacing = if spacing > size.width { spacing } else { size.width + 6.0 };
  let rects = button_rects(BAR_HEIGHT, LEFT_INSET, size.height, spacing);
  for (button, r) in [close, mini, zoom].iter().zip(rects) {
    let Some(parent) = (unsafe { button.superview() }) else { continue };
    // Из координат окна (низ-лево) в координаты родителя (учтёт flipped).
    let in_window = NSRect::new(
      NSPoint::new(r.x, window_height - r.top - size.height),
      NSSize::new(size.width, size.height),
    );
    let local = parent.convertRect_fromView(in_window, None);
    button.setFrameOrigin(local.origin);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn buttons_are_centered_in_bar() {
    let r = button_rects(38.0, 14.0, 14.0, 23.0);
    for b in r {
      assert_eq!(b.top + 14.0 / 2.0, 19.0);
    }
    assert_eq!(r.map(|b| b.x), [14.0, 37.0, 60.0]);
  }

  #[test]
  fn keeps_native_spacing_and_left_inset() {
    let r = button_rects(38.0, 14.0, 16.0, 20.0);
    assert_eq!(r[0], ButtonRect { x: 14.0, top: 11.0 });
    assert_eq!(r[2].x, 54.0);
  }

  #[test]
  fn never_above_window_top() {
    assert_eq!(button_rects(10.0, 14.0, 14.0, 23.0)[0].top, 0.0);
  }
}
