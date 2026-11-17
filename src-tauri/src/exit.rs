//! Выход из приложения с сохранением: ⌘Q (пункт меню) или закрытие последнего окна сначала
//! шлёт всем окнам `app://before-exit`, каждое дописывает свою часть сессии и вызывает
//! `app_exit_ready` — когда ответили все окна, бывшие в начале выхода, выходим. Не ответили за
//! `READY_TIMEOUT` — выходим всё равно.
//!
//! Ограничение (macOS): «Завершить» из меню Dock, выход/перезагрузка системы и
//! `osascript 'quit app'` идут через `-[NSApplication terminate:]`, а tao не реализует
//! `applicationShouldTerminate:` — `RunEvent::ExitRequested` в этих случаях не приходит,
//! `app://before-exit` не шлётся, и процесс завершается без сохранения сессии фронтом
//! (`RunEvent::Exit` ещё успевает остановить claude и PTY). Подмену метода делегата
//! (swizzling) намеренно не делаем: хрупко и ломается при обновлении tao. Поэтому фронт
//! сохраняет сессию и по ходу работы, а не только перед выходом.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

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
  /// Окна, от которых ещё ждём `app_exit_ready` (метки окон на момент начала выхода).
  waiting: Mutex<Waiting>,
  cv: Condvar,
}

#[derive(Default)]
struct Waiting {
  labels: HashSet<String>,
  /// Ждать больше нечего (все ответили или фронту не отправить).
  done: bool,
}

impl ExitFlow {
  /// Перехватывать ли запрос выхода: да, пока сами не начали выходить.
  pub fn intercept(&self) -> bool {
    !self.exiting.load(Ordering::SeqCst)
  }

  /// Выход уже начат (событие окнам отправлено).
  pub fn started(&self) -> bool {
    self.started.load(Ordering::SeqCst)
  }

  fn waiting(&self) -> std::sync::MutexGuard<'_, Waiting> {
    self.waiting.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// Ждать ответа от этих окон.
  fn expect(&self, labels: impl IntoIterator<Item = String>) {
    let mut w = self.waiting();
    w.labels = labels.into_iter().collect();
    w.done = w.labels.is_empty();
    self.cv.notify_all();
  }

  /// Окно `label` сохранило состояние (или закрылось — ждать его нечего).
  pub fn mark_ready(&self, label: &str) {
    let mut w = self.waiting();
    w.labels.remove(label);
    if w.labels.is_empty() {
      w.done = true;
    }
    self.cv.notify_all();
  }

  /// Не ждать никого.
  fn mark_all_ready(&self) {
    let mut w = self.waiting();
    w.labels.clear();
    w.done = true;
    self.cv.notify_all();
  }

  /// Ждёт ответа всех окон не дольше `timeout`; true — дождались.
  pub fn wait_ready(&self, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut r = self.waiting();
    while !r.done {
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

/// Начать выход: событие всем окнам, в фоне — ожидание ответа (или READY_TIMEOUT), затем `app.exit(0)`.
/// Повторный вызов (второй ⌘Q, пока ждём) ничего не делает.
pub fn begin<R: Runtime>(app: &AppHandle<R>) {
  let flow = app.state::<ExitFlow>();
  if !flow.start() {
    return;
  }
  // Ответа ждём от каждого окна, открытого сейчас (закрытое по пути — вычёркивается в `Destroyed`).
  flow.expect(app.webview_windows().into_keys());
  if app.emit(BEFORE_EXIT_EVENT, ()).is_err() {
    // Фронту не отправить — ждать нечего.
    flow.mark_all_ready();
  }
  let handle = app.clone();
  let spawned = std::thread::Builder::new().name("exit-wait".into()).spawn(move || {
    let app = handle;
    let flow = app.state::<ExitFlow>();
    if !flow.wait_ready(READY_TIMEOUT) {
      let left: Vec<String> = flow.waiting().labels.iter().cloned().collect();
      log::warn!("окна {left:?} не ответили на {BEFORE_EXIT_EVENT} за {READY_TIMEOUT:?}: выходим без их сохранения");
    }
    flow.exiting.store(true, Ordering::SeqCst);
    app.exit(0);
  });
  if spawned.is_err() {
    flow.exiting.store(true, Ordering::SeqCst);
    app.exit(0);
  }
}

/// Окно дописало свою часть сессии: когда ответят все окна, выходим.
#[tauri::command]
pub fn app_exit_ready(window: WebviewWindow, flow: State<'_, ExitFlow>) {
  flow.mark_ready(window.label());
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
    f.mark_all_ready();
    assert!(h.join().unwrap());
  }

  /// Выход ждёт ответа каждого окна, бывшего в начале; повтор от одного окна не считается дважды.
  #[test]
  fn waits_for_every_window() {
    let f = std::sync::Arc::new(ExitFlow::default());
    f.expect(["main".to_string(), "w-1".to_string(), "w-2".to_string()]);
    f.mark_ready("main");
    f.mark_ready("main");
    assert!(!f.wait_ready(Duration::from_millis(50)));
    // Окно, открытое после начала выхода, не учитывается.
    f.mark_ready("w-new");
    assert!(!f.wait_ready(Duration::from_millis(50)));
    f.mark_ready("w-1");
    let g = f.clone();
    let h = std::thread::spawn(move || g.wait_ready(Duration::from_secs(5)));
    std::thread::sleep(Duration::from_millis(50));
    // Последнее закрылось, не ответив, — ждать больше некого.
    f.mark_ready("w-2");
    assert!(h.join().unwrap());
  }

  #[test]
  fn no_windows_means_ready() {
    let f = ExitFlow::default();
    f.expect(Vec::<String>::new());
    assert!(f.wait_ready(Duration::from_millis(10)));
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
