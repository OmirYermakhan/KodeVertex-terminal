use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};

const SETTINGS_MENU_ID: &str = "settings";
const SETTINGS_EVENT: &str = "menu://settings";

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
      &PredefinedMenuItem::quit(app, None)?,
    ],
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
  Menu::with_items(app, &[&app_menu, &edit_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .menu(build_menu)
    .on_menu_event(|app, event| {
      if event.id().as_ref() == SETTINGS_MENU_ID {
        let _ = app.emit(SETTINGS_EVENT, ());
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn settings_event_name_is_stable() {
    assert_eq!(SETTINGS_EVENT, "menu://settings");
  }
}
