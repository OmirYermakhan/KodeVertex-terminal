//! Системный диалог выбора файлов/папки.
//!
//! Раньше шёл через tauri-plugin-dialog, но тот создаёт NSOpenPanel без защиты:
//! если macOS отказывает в панели (например, бандл переустановили поверх, пока
//! процесс работал, — сервис openAndSavePanel не сходится с подписью запущенного
//! кода), `+[NSOpenPanel openPanel]` возвращает NULL, objc2 паникует на главном
//! потоке, и приложение падает целиком. Здесь та же панель создаётся внутри
//! `catch_unwind`, а отказ становится обычной ошибкой для интерфейса.

use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::mpsc;

use rfd::AsyncFileDialog;
use serde::Deserialize;
use tauri::WebviewWindow;

#[derive(Deserialize)]
pub struct PickFilter {
  name: String,
  extensions: Vec<String>,
}

type Picked = Pin<Box<dyn Future<Output = Option<Vec<PathBuf>>> + Send>>;

pub const PANEL_FAILED: &str =
  "macOS не открыл окно выбора файлов. Обычно так бывает после переустановки приложения поверх запущенного — перезапустите KodeVertex Terminal.";

fn start(
  window: &WebviewWindow,
  directory: bool,
  multiple: bool,
  title: Option<String>,
  filters: Vec<PickFilter>,
) -> Picked {
  let mut d = AsyncFileDialog::new().set_parent(window);
  if let Some(t) = title {
    d = d.set_title(t);
  }
  for f in &filters {
    d = d.add_filter(&f.name, &f.extensions);
  }
  let paths = |v: Option<Vec<rfd::FileHandle>>| v.map(|l| l.into_iter().map(|h| h.path().to_path_buf()).collect());
  let one = |v: Option<rfd::FileHandle>| v.map(|h| vec![h.path().to_path_buf()]);
  match (directory, multiple) {
    (true, true) => {
      let f = d.pick_folders();
      Box::pin(async move { paths(f.await) })
    }
    (true, false) => {
      let f = d.pick_folder();
      Box::pin(async move { one(f.await) })
    }
    (false, true) => {
      let f = d.pick_files();
      Box::pin(async move { paths(f.await) })
    }
    (false, false) => {
      let f = d.pick_file();
      Box::pin(async move { one(f.await) })
    }
  }
}

/// Отмена — пустой список.
#[tauri::command]
pub async fn pick_paths(
  window: WebviewWindow,
  directory: bool,
  multiple: bool,
  title: Option<String>,
  filters: Option<Vec<PickFilter>>,
) -> Result<Vec<String>, String> {
  let (tx, rx) = mpsc::channel::<Option<Picked>>();
  let w = window.clone();
  let filters = filters.unwrap_or_default();
  window
    .run_on_main_thread(move || {
      let r = catch_unwind(AssertUnwindSafe(|| start(&w, directory, multiple, title, filters)));
      let _ = tx.send(r.ok());
    })
    .map_err(|e| e.to_string())?;
  let started = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
    .await
    .map_err(|e| e.to_string())?;
  let Some(fut) = started else {
    log::error!("NSOpenPanel не создан");
    return Err(PANEL_FAILED.into());
  };
  Ok(
    fut
      .await
      .unwrap_or_default()
      .into_iter()
      .map(|p| p.to_string_lossy().into_owned())
      .collect(),
  )
}
