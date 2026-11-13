//! Диагностика: ошибки интерфейса и паники Rust — в журнал приложения
//! (~/Library/Logs/com.kodevertex.terminal/), чтобы после «пустого окна» было что читать.

/// Длинные сообщения (стеки React) режем: журнал не должен разрастаться от одной ошибки.
const MAX_MESSAGE: usize = 16 * 1024;

fn clip(s: &str) -> &str {
  if s.len() <= MAX_MESSAGE {
    return s;
  }
  let mut end = MAX_MESSAGE;
  while !s.is_char_boundary(end) {
    end -= 1;
  }
  &s[..end]
}

/// Ошибка из webview (ловушка ошибок React, window.onerror, unhandledrejection).
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
  let m = clip(&message);
  match level.as_str() {
    "warn" => log::warn!(target: "frontend", "{m}"),
    "info" => log::info!(target: "frontend", "{m}"),
    _ => log::error!(target: "frontend", "{m}"),
  }
}

/// Паника в любом потоке — в журнал вместе со стеком; штатный обработчик тоже вызывается.
pub fn install_panic_hook() {
  let prev = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
    let bt = std::backtrace::Backtrace::force_capture();
    log::error!(target: "panic", "{info}\n{bt}");
    prev(info);
  }));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn clip_keeps_short_and_cuts_long_on_char_boundary() {
    assert_eq!(clip("abc"), "abc");
    let long = "я".repeat(MAX_MESSAGE); // 2 байта на символ
    let c = clip(&long);
    assert!(c.len() <= MAX_MESSAGE);
    assert!(c.chars().all(|ch| ch == 'я'));
  }
}
