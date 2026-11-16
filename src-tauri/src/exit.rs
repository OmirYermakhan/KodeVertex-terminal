//! Выход из приложения с сохранением: ⌘Q (пункт меню) или закрытие последнего окна сначала
//! шлёт фронту `app://before-exit`, фронт дописывает сессию и вызывает `app_exit_ready` — тогда
//! выходим. Фронт не ответил за `READY_TIMEOUT` — выходим всё равно.
//!
//! Ограничение (macOS): «Завершить» из меню Dock, выход/перезагрузка системы и
//! `osascript 'quit app'` идут через `-[NSApplication terminate:]`, а tao не реализует
//! `applicationShouldTerminate:` — `RunEvent::ExitRequested` в этих случаях не приходит,
//! `app://before-exit` не шлётся, и процесс завершается без сохранения сессии фронтом
//! (`RunEvent::Exit` ещё успевает остановить claude и PTY). Подмену метода делегата
//! (swizzling) намеренно не делаем: хрупко и ломается при обновлении tao. Поэтому фронт
//! сохраняет сессию и по ходу работы, а не только перед выходом.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Событие фронту: пора сохранить состояние и ответить `app_exit_ready`.
pub const BEFORE_EXIT_EVENT: &str = "app://before-exit";
/// Сколько ждём ответа фронта.
pub const READY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct ExitFlow {
  /// Запрос на выход уже принят (событие фронту отправлено, ждём ответа).
  started: AtomicBool,
  /// Ответ получен или время вышло: следующий запрос выхода (от `app.exit`) не перехватывается.
  exiting: AtomicBool,
  ready: Mutex<bool>,
  cv: Condvar,
}

impl ExitFlow {
  /// Перехватывать ли запрос выхода: да, пока сами не начали выходить.
  pub fn intercept(&self) -> bool {
    !self.exiting.load(Ordering::SeqCst)
  }

  /// Фронт сохранил состояние.
  pub fn mark_ready(&self) {
    *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = true;
    self.cv.notify_all();
  }

  /// Ждёт `mark_ready` не дольше `timeout`; true — дождались.
  pub fn wait_ready(&self, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut r = self.ready.lock().unwrap_or_else(|e| e.into_inner());
    while !*r {
      let now = Instant::now();
      if now >= deadline {
        return false;
      }
      r = self.cv.wait_timeout(r, deadline - now).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
    }
    true
  }

  /// Первый вызов — true (начинаем ожидание фронта); повторные — false.
  fn start(&self) -> bool {
    !self.started.swap(true, Ordering::SeqCst)
  }
}

/// Начать выход: событие фронту, в фоне — ожидание ответа (или READY_TIMEOUT), затем `app.exit(0)`.
/// Повторный вызов (второй ⌘Q, пока ждём) ничего не делает.
pub fn begin<R: Runtime>(app: &AppHandle<R>) {
  let flow = app.state::<ExitFlow>();
  if !flow.start() {
    return;
  }
  if app.emit(BEFORE_EXIT_EVENT, ()).is_err() {
    // Фронту не отправить — ждать нечего.
    flow.mark_ready();
  }
  let handle = app.clone();
  let spawned = std::thread::Builder::new().name("exit-wait".into()).spawn(move || {
    let app = handle;
    let flow = app.state::<ExitFlow>();
    if !flow.wait_ready(READY_TIMEOUT) {
      log::warn!("фронт не ответил на {BEFORE_EXIT_EVENT} за {READY_TIMEOUT:?}: выходим без сохранения");
    }
    flow.exiting.store(true, Ordering::SeqCst);
    app.exit(0);
  });
  if spawned.is_err() {
    flow.exiting.store(true, Ordering::SeqCst);
    app.exit(0);
  }
}

/// Фронт дописал сессию: можно выходить.
#[tauri::command]
pub fn app_exit_ready(flow: State<'_, ExitFlow>) {
  flow.mark_ready();
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_are_stable() {
    assert_eq!(BEFORE_EXIT_EVENT, "app://before-exit");
  }

  #[test]
  fn ready_wakes_waiter_and_timeout_is_bounded() {
    let f = std::sync::Arc::new(ExitFlow::default());
    let t = Instant::now();
    assert!(!f.wait_ready(Duration::from_millis(100)));
    assert!(t.elapsed() >= Duration::from_millis(100));
    let g = f.clone();
    let h = std::thread::spawn(move || g.wait_ready(Duration::from_secs(5)));
    std::thread::sleep(Duration::from_millis(50));
    f.mark_ready();
    assert!(h.join().unwrap());
  }

  #[test]
  fn starts_once_and_stops_intercepting_after_exit() {
    let f = ExitFlow::default();
    assert!(f.intercept());
    assert!(f.start());
    assert!(!f.start());
    assert!(f.intercept());
    f.exiting.store(true, Ordering::SeqCst);
    assert!(!f.intercept());
  }
}
