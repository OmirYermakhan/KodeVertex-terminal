mod attach;
mod claude;
mod claude_trust;
mod claude_sessions;
mod claude_settings;
mod diag;
mod exit;
mod fonts;
mod fs_complete;
mod git;
mod history;
mod preview;
mod project;
mod pty;
mod session;
mod settings;
mod shell;
mod slash_commands;
mod traffic_lights;
mod windows;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Url, Wry};

/// Блокирующая работа команды (диск, git, оболочка) — в пуле блокирующих задач: не в главном
/// потоке и не в рабочих потоках tokio, которые нужны остальным командам.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

const SETTINGS_MENU_ID: &str = "settings";
const SETTINGS_EVENT: &str = "menu://settings";
/// Свой пункт «Завершить» вместо штатного: штатный (`terminate:`) выходит сразу, и фронт не
/// успевает сохранить сессию. Свой — сначала `app://before-exit` (см. `exit`).
const QUIT_MENU_ID: &str = "quit";
/// «Новое окно» (⌘N): пустое окно с одной новой вкладкой.
const NEW_WINDOW_MENU_ID: &str = "new-window";

/// Минимальное меню приложения. Пунктов с ⌘W / ⌘T / ⌘D здесь нет намеренно:
/// эти сочетания обрабатывает фронтенд.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
  let app_menu = Submenu::with_items(
    app,
    "KodeVertex Terminal",
    true,
    &[
      &PredefinedMenuItem::about(app, None, None)?,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, SETTINGS_MENU_ID, "Настройки…", true, Some("CmdOrCtrl+,"))?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::hide(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, QUIT_MENU_ID, "Завершить KodeVertex Terminal", true, Some("CmdOrCtrl+Q"))?,
    ],
  )?;
  let file_menu = Submenu::with_items(
    app,
    "Файл",
    true,
    &[&MenuItem::with_id(app, NEW_WINDOW_MENU_ID, "Новое окно", true, Some("CmdOrCtrl+N"))?],
  )?;
  let edit_menu = Submenu::with_items(
    app,
    "Правка",
    true,
    &[
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
    ],
  )?;
  Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])
}

/// Адрес — собственная страница приложения: `tauri://localhost` (macOS/Linux),
/// `http(s)://tauri.localhost` (Windows) или, в режиме разработки, источник `devUrl`.
fn is_app_url(url: &Url, dev: Option<&Url>) -> bool {
  let own = match url.scheme() {
    "tauri" => url.host_str() == Some("localhost"),
    "http" | "https" => url.host_str() == Some("tauri.localhost"),
    _ => false,
  };
  own || dev.is_some_and(|d| url.origin().is_tuple() && d.origin() == url.origin())
}

/// Страж навигации окон (плагин — для всех webview, в том числе новых окон `w-*`): уйти со
/// страницы приложения нельзя (пункт «Открыть ссылку» контекстного меню WKWebView, перетащенная
/// ссылка и т. п.). Иначе `PageLoadEvent::Started` убил бы терминалы и claude окна, а в окне с
/// доступом к командам оказалась бы чужая страница.
/// http(s) открываем в браузере, остальное (file:, data:, about:) просто отменяем.
fn nav_guard() -> tauri::plugin::TauriPlugin<Wry> {
  tauri::plugin::Builder::<Wry>::new("nav-guard")
    .on_navigation(|webview, url| {
      let dev = if tauri::is_dev() { webview.app_handle().config().build.dev_url.clone() } else { None };
      if is_app_url(url, dev.as_ref()) {
        return true;
      }
      if matches!(url.scheme(), "http" | "https") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
      }
      log::warn!("навигация окна {} отменена: {url}", webview.label());
      false
    })
    .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(nav_guard())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      settings::settings_load,
      settings::settings_save,
      session::session_load,
      session::session_save,
      fonts::fonts_list,
      fs_complete::fs_list,
      fs_complete::fs_preview,
      git::git_info,
      history::shell_history,
      pty::pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      claude::claude_start,
      claude::claude_send,
      claude::claude_interrupt,
      claude::claude_stop,
      claude::claude_control,
      claude::claude_respond,
      claude_trust::claude_trust_check,
      claude_trust::claude_trust_add,
      claude_settings::claude_save_defaults,
      claude_sessions::claude_sessions,
      claude_sessions::claude_session_history,
      attach::attach_inspect,
      attach::attach_clipboard_image,
      preview::preview_text,
      preview::preview_dir,
      preview::preview_image,
      preview::preview_pdf,
      preview::preview_open,
      project::project_root,
      project::project_list,
      project::project_read,
      project::git_status,
      project::git_log,
      project::git_commit_files,
      project::git_diff,
      slash_commands::claude_slash_commands,
      diag::frontend_log,
      pty::pty_pause,
      pty::pty_resume,
      pty::pty_detach,
      pty::pty_attach,
      claude::claude_detach,
      claude::claude_attach,
      windows::window_open,
      windows::window_take_init,
      windows::window_send_tab,
      windows::window_at,
      windows::window_count,
      exit::app_exit_ready
    ])
    .manage(pty::PtyManager::default())
    .manage(claude::ClaudeManager::default())
    .manage(exit::ExitFlow::default())
    .manage(session::Pieces::default())
    .manage(windows::WindowInits::default())
    .on_page_load(|webview, payload| {
      // Перезагрузка страницы окна: прежние терминалы и процессы claude этого окна новой странице
      // не принадлежат — без этого они остались бы сиротами до выхода. Чужие окна не трогаем.
      if payload.event() == PageLoadEvent::Started {
        close_owned(webview.app_handle(), webview.label());
      }
    })
    .menu(build_menu)
    .on_menu_event(|app, event| match event.id().as_ref() {
      SETTINGS_MENU_ID => {
        let _ = app.emit(SETTINGS_EVENT, ());
      }
      QUIT_MENU_ID => exit::begin(app),
      NEW_WINDOW_MENU_ID => {
        // Создание окна ждёт главный поток — не из его обработчика.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
          if let Err(e) = windows::open(&app, None, windows::focused_size(&app), None) {
            log::warn!("не удалось открыть окно: {e}");
          }
        });
      }
      _ => {}
    })
    .setup(|app| {
      // Скрины из буфера (attachments/) старше 30 дней — в фоне, запуск не ждёт.
      if let Ok(dir) = attach::dir(app.handle()) {
        std::thread::spawn(move || attach::cleanup(&dir, attach::KEEP, std::time::SystemTime::now()));
      }
      // Журнал и в release-сборке: иначе после сбоя у установленного приложения нечего читать.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .max_file_size(5 * 1024 * 1024)
          .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
          .build(),
      )?;
      diag::install_panic_hook();
      // Первое окно — первым в порядке окон файла сессии.
      app.state::<session::Pieces>().register(session::MAIN_LABEL);
      #[cfg(target_os = "macos")]
      if let Some(w) = app.get_webview_window("main") {
        traffic_lights::apply(w.ns_window());
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      // Окно закрыто: его процессы, payload и (если остались другие окна) часть сессии — долой.
      if let tauri::WindowEvent::Destroyed = event {
        let app = window.app_handle();
        let label = window.label();
        close_owned(app, label);
        app.state::<windows::WindowInits>().take(label);
        // Выход ждал ответа этого окна — ждать нечего.
        app.state::<exit::ExitFlow>().mark_ready(label);
        session::on_destroyed(app, label);
      }
      // Закрытие последнего окна = выход: сначала даём фронту сохранить сессию.
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        if app.webview_windows().len() <= 1 && app.state::<exit::ExitFlow>().intercept() {
          api.prevent_close();
          exit::begin(app);
        }
      }
      // AppKit возвращает кнопки окна на штатное место при этих событиях.
      #[cfg(target_os = "macos")]
      if matches!(
        event,
        tauri::WindowEvent::Resized(_)
          | tauri::WindowEvent::Focused(_)
          | tauri::WindowEvent::ThemeChanged(_)
          | tauri::WindowEvent::ScaleFactorChanged { .. }
      ) {
        traffic_lights::apply(window.ns_window());
        // Ещё раз после того, как AppKit доделает раскладку заголовка.
        let w = window.clone();
        let _ = window.run_on_main_thread(move || traffic_lights::apply(w.ns_window()));
      }
      #[cfg(not(target_os = "macos"))]
      let _ = (window, event);
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| match event {
      // Первый запрос выхода перехватываем: фронт сохраняет сессию (`app://before-exit` →
      // `app_exit_ready`), затем `exit::begin` вызывает `app.exit(0)` — этот запрос уже не держим.
      RunEvent::ExitRequested { api, .. } => {
        if app.state::<exit::ExitFlow>().intercept() {
          api.prevent_exit();
          exit::begin(app);
        }
      }
      // Процессы claude (и их инструменты) не должны доигрывать ход без окна.
      RunEvent::Exit => {
        app.state::<claude::ClaudeManager>().stop_all();
        app.state::<pty::PtyManager>().kill_all();
      }
      _ => {}
    });
}

/// Закрыть терминалы и процессы claude окна `label` (перезагрузка страницы, закрытие окна).
fn close_owned(app: &AppHandle, label: &str) {
  app.state::<pty::PtyManager>().kill_owner(label);
  let claude = app.state::<claude::ClaudeManager>().inner().clone();
  let label = label.to_string();
  // stop_owner ждёт процессы до секунды — не в потоке webview.
  std::thread::spawn(move || claude.stop_owner(&label));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_app_origin_is_navigable() {
    let u = |s: &str| Url::parse(s).unwrap();
    assert!(is_app_url(&u("tauri://localhost/"), None));
    assert!(is_app_url(&u("tauri://localhost/index.html#x"), None));
    assert!(is_app_url(&u("http://tauri.localhost/"), None));
    assert!(is_app_url(&u("https://tauri.localhost/a"), None));
    assert!(!is_app_url(&u("https://evil.example/"), None));
    assert!(!is_app_url(&u("tauri://evil/"), None));
    assert!(!is_app_url(&u("http://localhost:5173/"), None));
    assert!(!is_app_url(&u("file:///etc/passwd"), None));
    assert!(!is_app_url(&u("about:blank"), None));
    assert!(!is_app_url(&u("data:text/html,x"), None));
    // devUrl — только его источник (схема, хост, порт).
    let dev = u("http://localhost:5173");
    assert!(is_app_url(&u("http://localhost:5173/src/main.tsx"), Some(&dev)));
    assert!(!is_app_url(&u("http://localhost:5174/"), Some(&dev)));
    assert!(!is_app_url(&u("https://localhost:5173/"), Some(&dev)));
    assert!(!is_app_url(&u("about:blank"), Some(&u("about:blank"))));
  }

  #[test]
  fn settings_event_name_is_stable() {
    assert_eq!(SETTINGS_EVENT, "menu://settings");
  }
}
