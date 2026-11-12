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
pub const PDF_MAX: u64 = 20 * 1024 * 1024;
/// Картинку больше не читаем вовсе (ни для отправки, ни для размеров).
pub const IMAGE_SOURCE_MAX: u64 = 60 * 1024 * 1024;
/// Все картинки и PDF одного сообщения в base64 — не больше (лимит запроса API с запасом).
pub const MESSAGE_MAX: u64 = 28 * 1024 * 1024;
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
  if !info.exists || info.is_dir || !is_image(p) || info.size > IMAGE_SOURCE_MAX {
    return info;
  }
  if let Ok((w, h)) = ImageReader::open(p).and_then(|r| r.with_guessed_format()).map_err(|_| ()).and_then(|r| r.into_dimensions().map_err(|_| ())) {
    info.width = Some(w);
    info.height = Some(h);
    info.prepared_size = Some(estimate_prepared(w, h, info.size));
  }
  if info.size <= THUMB_SOURCE_MAX {
    info.thumb = thumbnail(p);
  }
  info
}

/// Оценка размера картинки после подготовки (без уменьшения и кодирования — их делает отправка).
/// Длинная сторона > LONG_SIDE: вес уменьшается с площадью. Больше IMAGE_MAX: PNG уйдёт JPEG-ом —
/// не больше ~1 байта на пиксель.
pub fn estimate_prepared(w: u32, h: u32, size: u64) -> u64 {
  let long = w.max(h).max(1);
  let k = if long > LONG_SIDE { LONG_SIDE as f64 / long as f64 } else { 1.0 };
  let (nw, nh) = ((w as f64 * k).round() as u64, (h as f64 * k).round() as u64);
  let scaled = (size as f64 * k * k).round() as u64;
  if scaled <= IMAGE_MAX { scaled } else { scaled.min(nw * nh) }
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
  let len = fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?.len();
  if len > IMAGE_SOURCE_MAX {
    return Err(format!("{}: слишком большой файл", p.display()));
  }
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
    return Err(format!("{}: PDF больше 20 МБ", p.display()));
  }
  let bytes = fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
  if !bytes.starts_with(b"%PDF") {
    return Err(format!("{}: не PDF", p.display()));
  }
  Ok(json!({ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": B64.encode(bytes) } }))
}

/// `@путь` для текста сообщения; путь с пробелами — в кавычках (как atMention на стороне TS).
fn at_mention(path: &str) -> String {
  if path.chars().any(|c| c.is_whitespace() || c == '"') { format!("@\"{}\"", path.replace('"', "\\\"")) } else { format!("@{path}") }
}

/// Содержимое сообщения: текст (с [Изображение N]/[Документ N] на местах значков), затем
/// картинки и документы в том же порядке. Файл, который не прочитать (пропал, повреждён),
/// сообщение не роняет: его метка в тексте заменяется на `@путь`, а причина — во втором значении.
pub fn build_content(text: &str, files: &[SendFile]) -> Result<(Vec<Value>, Vec<String>), String> {
  let mut text = text.to_string();
  let mut blocks = Vec::new();
  let mut skipped = Vec::new();
  let (mut images, mut docs) = (0, 0);
  let mut total: u64 = 0;
  for f in files {
    let p = Path::new(&f.path);
    let (label, block) = match f.kind.as_str() {
      "image" => {
        images += 1;
        (format!("[Изображение {images}]"), image_block(p))
      }
      "pdf" => {
        docs += 1;
        (format!("[Документ {docs}]"), document_block(p))
      }
      k => return Err(format!("неизвестный тип вложения: {k}")),
    };
    if let Ok(b) = &block {
      total += b["source"]["data"].as_str().map_or(0, |d| d.len() as u64);
      // Всё сообщение не уйдёт: отказ до записи в stdin.
      if total > MESSAGE_MAX {
        return Err("сообщение слишком большое: вложения больше 28 МБ".to_string());
      }
    }
    match block {
      Ok(b) => blocks.push(b),
      Err(e) => {
        text = text.replacen(&label, &at_mention(&f.path), 1);
        skipped.push(e);
      }
    }
  }
  // Номера оставшихся меток должны совпадать с порядком блоков: пропавший файл сдвигает их.
  let text = if skipped.is_empty() { text } else { renumber(&text) };
  let mut content = vec![json!({ "type": "text", "text": text })];
  content.extend(blocks);
  Ok((content, skipped))
}

/// Перенумеровать [Изображение N] и [Документ N] подряд (после замены пропавших на `@путь`).
fn renumber(text: &str) -> String {
  let mut out = String::with_capacity(text.len());
  let mut rest = text;
  let (mut images, mut docs) = (0, 0);
  while let Some(i) = rest.find('[') {
    out.push_str(&rest[..i]);
    let tail = &rest[i..];
    let hit = ["[Изображение ", "[Документ "].iter().find_map(|pre| {
      let num = tail.strip_prefix(pre)?;
      let end = num.find(']')?;
      num[..end].parse::<u32>().ok().map(|_| (*pre, pre.len() + end + 1))
    });
    match hit {
      Some((pre, len)) => {
        let n = if pre.starts_with("[И") { images += 1; images } else { docs += 1; docs };
        out.push_str(&format!("{pre}{n}]"));
        rest = &tail[len..];
      }
      None => {
        out.push('[');
        rest = &tail[1..];
      }
    }
  }
  out.push_str(rest);
  out
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
    let (c, skipped) = build_content("вот [Изображение 1] и [Документ 1]", &files).unwrap();
    assert!(skipped.is_empty());
    assert_eq!(c.len(), 3);
    assert_eq!(c[0], json!({ "type": "text", "text": "вот [Изображение 1] и [Документ 1]" }));
    assert_eq!(c[1]["type"], "image");
    assert_eq!(c[1]["source"]["media_type"], "image/png");
    assert_eq!(B64.decode(c[1]["source"]["data"].as_str().unwrap()).unwrap(), fs::read(&img).unwrap());
    assert_eq!(c[2]["source"]["media_type"], "application/pdf");
    assert_eq!(B64.decode(c[2]["source"]["data"].as_str().unwrap()).unwrap(), b"%PDF-1.4 test");
  }

  #[test]
  fn missing_file_becomes_path_and_rest_is_sent() {
    let d = tempfile::tempdir().unwrap();
    let ok = png(d.path(), "ok.png", 2, 2);
    let gone = d.path().join("нет файла.png");
    let files = vec![
      SendFile { kind: "image".into(), path: gone.to_string_lossy().into() },
      SendFile { kind: "image".into(), path: ok.to_string_lossy().into() },
    ];
    let (c, skipped) = build_content("a [Изображение 1] b [Изображение 2]", &files).unwrap();
    assert_eq!(skipped.len(), 1);
    assert_eq!(c.len(), 2);
    assert_eq!(c[0]["text"], format!("a @\"{}\" b [Изображение 1]", gone.display()));
    assert_eq!(c[1]["type"], "image");
    assert_eq!(renumber("[Изображение 3] [x] [Документ 2] [Изображение 9]"), "[Изображение 1] [x] [Документ 1] [Изображение 2]");
  }

  #[test]
  fn estimate_and_source_cap() {
    // Маленькая — как есть; вдвое больше по длинной стороне — вчетверо легче; тяжёлая — JPEG.
    assert_eq!(estimate_prepared(100, 50, 1000), 1000);
    assert_eq!(estimate_prepared(4000, 2000, 8_000_000), 2_000_000);
    assert_eq!(estimate_prepared(4000, 2000, 80_000_000), 2000 * 1000);
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("huge.png");
    fs::File::create(&big).unwrap().set_len(IMAGE_SOURCE_MAX + 1).unwrap();
    let e = prepare_image(&big).unwrap_err();
    assert!(e.contains("слишком большой файл"), "{e}");
    let i = inspect(&big.to_string_lossy());
    assert!(i.width.is_none() && i.thumb.is_none() && i.prepared_size.is_none());
  }

  #[test]
  fn message_total_is_capped() {
    let d = tempfile::tempdir().unwrap();
    // Три PDF по 9 МБ: в base64 по 12 МБ — третий выходит за 28 МБ, сообщение не собирается.
    let mut files = Vec::new();
    for i in 0..3 {
      let p = d.path().join(format!("{i}.pdf"));
      let mut bytes = b"%PDF-1.4 ".to_vec();
      bytes.resize(9 * 1024 * 1024, b'a');
      fs::write(&p, bytes).unwrap();
      files.push(SendFile { kind: "pdf".into(), path: p.to_string_lossy().into() });
    }
    let e = build_content("[Документ 1] [Документ 2] [Документ 3]", &files).unwrap_err();
    assert!(e.contains("слишком большое"), "{e}");
    assert!(build_content("[Документ 1] [Документ 2]", &files[..2]).is_ok());
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
