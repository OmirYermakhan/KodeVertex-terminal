//! Вложения сообщений Claude: сведения о путях (тип, размер, миниатюра), картинка из буфера обмена,
//! сборка блоков image/document (base64, уменьшение картинок) для stream-json, чистка старых скринов.
//! Webview большие файлы не читает: всё тяжёлое — здесь.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

/// Длинная сторона картинки больше — уменьшаем до неё.
pub const LONG_SIDE: u32 = 2000;
/// Картинка (после уменьшения) — не больше.
pub const IMAGE_MAX: u64 = 5 * 1024 * 1024;
pub const PDF_MAX: u64 = 32 * 1024 * 1024;
/// Миниатюра значка: 15px при 2× — 30px.
const THUMB: u32 = 30;
/// Больше — миниатюру не строим (декодирование огромного файла ради 30px не стоит того).
const THUMB_SOURCE_MAX: u64 = 40 * 1024 * 1024;
pub const IMAGE_EXT: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
/// Скрины из буфера старше — удаляются при запуске.
pub const KEEP: Duration = Duration::from_secs(30 * 24 * 60 * 60);
pub const DIR: &str = "attachments";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
  pub path: String,
  pub name: String,
  pub exists: bool,
  pub is_dir: bool,
  pub size: u64,
  /// Размер картинки, который уйдёт Claude (после уменьшения).
  pub prepared_size: Option<u64>,
  pub width: Option<u32>,
  pub height: Option<u32>,
  /// data:image/png;base64,… — миниатюра для значка.
  pub thumb: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SendFile {
  pub kind: String,
  pub path: String,
}

fn ext(path: &Path) -> String {
  path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn is_image(path: &Path) -> bool {
  IMAGE_EXT.contains(&ext(path).as_str())
}

/// Сведения о пути для значка. Ошибки чтения картинки — не ошибка: просто без размеров и миниатюры.
pub fn inspect(path: &str) -> PathInfo {
  let p = Path::new(path);
  let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
  let meta = fs::metadata(p).ok();
  let mut info = PathInfo {
    path: path.to_string(),
    name,
    exists: meta.is_some(),
    is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
    size: meta.as_ref().map_or(0, |m| m.len()),
    prepared_size: None,
    width: None,
    height: None,
    thumb: None,
  };
  if !info.exists || info.is_dir || !is_image(p) {
    return info;
  }
  if let Ok((w, h)) = ImageReader::open(p).and_then(|r| r.with_guessed_format()).map_err(|_| ()).and_then(|r| r.into_dimensions().map_err(|_| ())) {
    info.width = Some(w);
    info.height = Some(h);
    let needs = w.max(h) > LONG_SIDE || info.size > IMAGE_MAX;
    info.prepared_size = if needs { prepare_image(p).ok().map(|(b, _)| b.len() as u64) } else { Some(info.size) };
  }
  if info.size <= THUMB_SOURCE_MAX {
    info.thumb = thumbnail(p);
  }
  info
}

fn thumbnail(p: &Path) -> Option<String> {
  let img = ImageReader::open(p).ok()?.with_guessed_format().ok()?.decode().ok()?;
  let t = img.resize_to_fill(THUMB, THUMB, FilterType::Triangle);
  let mut out = Cursor::new(Vec::new());
  t.write_to(&mut out, ImageFormat::Png).ok()?;
  Some(format!("data:image/png;base64,{}", B64.encode(out.into_inner())))
}

fn media_type(f: ImageFormat) -> Option<&'static str> {
  match f {
    ImageFormat::Png => Some("image/png"),
    ImageFormat::Jpeg => Some("image/jpeg"),
    ImageFormat::Gif => Some("image/gif"),
    ImageFormat::WebP => Some("image/webp"),
    _ => None,
  }
}

fn encode(img: &DynamicImage, jpeg: bool) -> Result<Vec<u8>, String> {
  let mut out = Cursor::new(Vec::new());
  if jpeg {
    let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
    rgb.write_with_encoder(JpegEncoder::new_with_quality(&mut out, 85)).map_err(|e| e.to_string())?;
  } else {
    img.write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
  }
  Ok(out.into_inner())
}

/// Байты картинки для Claude и её media type. Длинная сторона > LONG_SIDE — уменьшение (PNG
/// остаётся PNG, если влезает в лимит, иначе JPEG); маленькая и лёгкая — как есть.
pub fn prepare_image(p: &Path) -> Result<(Vec<u8>, &'static str), String> {
  let bytes = fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
  let format = image::guess_format(&bytes).map_err(|_| format!("{}: не картинка", p.display()))?;
  let media = media_type(format).ok_or_else(|| format!("{}: формат картинки не поддерживается", p.display()))?;
  let (w, h) = ImageReader::with_format(Cursor::new(&bytes), format).into_dimensions().map_err(|e| e.to_string())?;
  if w.max(h) <= LONG_SIDE && bytes.len() as u64 <= IMAGE_MAX {
    return Ok((bytes, media));
  }
  let img = image::load_from_memory_with_format(&bytes, format).map_err(|e| e.to_string())?;
  let img = if w.max(h) > LONG_SIDE { img.resize(LONG_SIDE, LONG_SIDE, FilterType::Lanczos3) } else { img };
  let jpeg_src = format == ImageFormat::Jpeg;
  let first = encode(&img, jpeg_src)?;
  if first.len() as u64 <= IMAGE_MAX || jpeg_src {
    return Ok((first, if jpeg_src { "image/jpeg" } else { "image/png" }));
  }
  Ok((encode(&img, true)?, "image/jpeg"))
}

pub fn image_block(p: &Path) -> Result<Value, String> {
  let (bytes, media) = prepare_image(p)?;
  if bytes.len() as u64 > IMAGE_MAX {
    return Err(format!("{}: картинка больше 5 МБ даже после уменьшения", p.display()));
  }
  Ok(json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": B64.encode(bytes) } }))
}

pub fn document_block(p: &Path) -> Result<Value, String> {
  let len = fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?.len();
  if len > PDF_MAX {
    return Err(format!("{}: PDF больше 32 МБ", p.display()));
  }
  let bytes = fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
  if !bytes.starts_with(b"%PDF") {
    return Err(format!("{}: не PDF", p.display()));
  }
  Ok(json!({ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": B64.encode(bytes) } }))
}

/// Содержимое сообщения: текст (с [Изображение N]/[Документ N] на местах значков), затем
/// картинки и документы в том же порядке.
pub fn build_content(text: &str, files: &[SendFile]) -> Result<Vec<Value>, String> {
  let mut content = vec![json!({ "type": "text", "text": text })];
  for f in files {
    let p = Path::new(&f.path);
    content.push(match f.kind.as_str() {
      "image" => image_block(p)?,
      "pdf" => document_block(p)?,
      k => return Err(format!("неизвестный тип вложения: {k}")),
    });
  }
  Ok(content)
}

/// PNG из RGBA-пикселей → `<dir>/<uuid>.png`.
pub fn save_png(dir: &Path, width: u32, height: u32, rgba: Vec<u8>) -> Result<PathBuf, String> {
  let img = image::RgbaImage::from_raw(width, height, rgba).ok_or("картинка из буфера повреждена")?;
  fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let path = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
  img.save_with_format(&path, ImageFormat::Png).map_err(|e| e.to_string())?;
  Ok(path)
}

/// Удаляет файлы каталога старше `keep` (по времени изменения). Возвращает число удалённых.
pub fn cleanup(dir: &Path, keep: Duration, now: SystemTime) -> usize {
  let Ok(rd) = fs::read_dir(dir) else { return 0 };
  let mut n = 0;
  for e in rd.flatten() {
    let Ok(meta) = e.metadata() else { continue };
    if !meta.is_file() {
      continue;
    }
    let old = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age > keep);
    if old && fs::remove_file(e.path()).is_ok() {
      n += 1;
    }
  }
  n
}

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(DIR))
}

#[tauri::command]
pub async fn attach_inspect(paths: Vec<String>) -> Result<Vec<PathInfo>, String> {
  tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| inspect(p)).collect()).await.map_err(|e| e.to_string())
}

/// ⌘V с картинкой: буфер → PNG в attachments/. Картинки нет — None.
#[tauri::command]
pub async fn attach_clipboard_image(app: AppHandle) -> Result<Option<PathInfo>, String> {
  let dir = dir(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let Ok(img) = cb.get_image() else { return Ok(None) };
    let (w, h) = (img.width as u32, img.height as u32);
    let path = save_png(&dir, w, h, img.bytes.into_owned())?;
    Ok(Some(inspect(&path.to_string_lossy())))
  })
  .await
  .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
    let p = dir.join(name);
    let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x * y) % 256) as u8, 255]));
    img.save_with_format(&p, ImageFormat::Png).unwrap();
    p
  }

  #[test]
  fn inspect_file_dir_missing() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("a.txt");
    fs::write(&f, "hello").unwrap();
    let i = inspect(&f.to_string_lossy());
    assert!(i.exists && !i.is_dir);
    assert_eq!((i.size, i.name.as_str()), (5, "a.txt"));
    assert!(i.thumb.is_none() && i.width.is_none());
    let dd = inspect(&d.path().to_string_lossy());
    assert!(dd.is_dir);
    let m = inspect(&d.path().join("nope.png").to_string_lossy());
    assert!(!m.exists);
  }

  #[test]
  fn inspect_image_has_size_and_thumb() {
    let d = tempfile::tempdir().unwrap();
    let p = png(d.path(), "shot.png", 64, 32);
    let i = inspect(&p.to_string_lossy());
    assert_eq!((i.width, i.height), (Some(64), Some(32)));
    assert_eq!(i.prepared_size, Some(i.size));
    assert!(i.thumb.unwrap().starts_with("data:image/png;base64,"));
  }

  #[test]
  fn big_image_is_downscaled_to_long_side() {
    let d = tempfile::tempdir().unwrap();
    let p = png(d.path(), "big.png", 3000, 1500);
    let (bytes, media) = prepare_image(&p).unwrap();
    let img = image::load_from_memory(&bytes).unwrap();
    assert_eq!((img.width(), img.height()), (2000, 1000));
    assert!(media == "image/png" || media == "image/jpeg");
    assert!(bytes.len() as u64 <= IMAGE_MAX);
    // Маленькая — байты как есть.
    let s = png(d.path(), "small.png", 10, 10);
    assert_eq!(prepare_image(&s).unwrap().0, fs::read(&s).unwrap());
    let i = inspect(&p.to_string_lossy());
    assert!(i.prepared_size.unwrap() < i.size);
  }

  #[test]
  fn not_an_image_or_pdf_is_error() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("fake.png");
    fs::write(&f, "not png").unwrap();
    assert!(prepare_image(&f).is_err());
    let pdf = d.path().join("fake.pdf");
    fs::write(&pdf, "nope").unwrap();
    assert!(document_block(&pdf).is_err());
  }

  #[test]
  fn content_blocks_in_order_with_base64() {
    let d = tempfile::tempdir().unwrap();
    let img = png(d.path(), "s.png", 4, 4);
    let pdf = d.path().join("spec.pdf");
    fs::write(&pdf, b"%PDF-1.4 test").unwrap();
    let files = vec![
      SendFile { kind: "image".into(), path: img.to_string_lossy().into() },
      SendFile { kind: "pdf".into(), path: pdf.to_string_lossy().into() },
    ];
    let c = build_content("вот [Изображение 1] и [Документ 1]", &files).unwrap();
    assert_eq!(c.len(), 3);
    assert_eq!(c[0], json!({ "type": "text", "text": "вот [Изображение 1] и [Документ 1]" }));
    assert_eq!(c[1]["type"], "image");
    assert_eq!(c[1]["source"]["media_type"], "image/png");
    assert_eq!(B64.decode(c[1]["source"]["data"].as_str().unwrap()).unwrap(), fs::read(&img).unwrap());
    assert_eq!(c[2]["source"]["media_type"], "application/pdf");
    assert_eq!(B64.decode(c[2]["source"]["data"].as_str().unwrap()).unwrap(), b"%PDF-1.4 test");
    let missing = vec![SendFile { kind: "image".into(), path: d.path().join("x.png").to_string_lossy().into() }];
    assert!(build_content("x", &missing).is_err());
  }

  #[test]
  fn clipboard_png_is_saved_in_dir() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join(DIR);
    let p = save_png(&dir, 2, 1, vec![255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
    assert_eq!(p.parent().unwrap(), dir);
    assert_eq!(p.extension().unwrap(), "png");
    let img = image::open(&p).unwrap();
    assert_eq!((img.width(), img.height()), (2, 1));
    assert!(save_png(&dir, 5, 5, vec![0; 3]).is_err());
  }

  #[test]
  fn cleanup_removes_only_old_files() {
    let d = tempfile::tempdir().unwrap();
    let fresh = d.path().join("fresh.png");
    let old = d.path().join("old.png");
    fs::write(&fresh, "a").unwrap();
    fs::write(&old, "b").unwrap();
    // «Сейчас» — через 31 день после записи старого: но свежий тоже записан только что,
    // поэтому сдвигаем время изменения старого назад.
    let past = SystemTime::now() - Duration::from_secs(31 * 24 * 3600);
    fs::File::options().write(true).open(&old).unwrap().set_modified(past).unwrap();
    assert_eq!(cleanup(d.path(), KEEP, SystemTime::now()), 1);
    assert!(fresh.exists() && !old.exists());
    assert_eq!(cleanup(&d.path().join("нет"), KEEP, SystemTime::now()), 0);
  }
}
