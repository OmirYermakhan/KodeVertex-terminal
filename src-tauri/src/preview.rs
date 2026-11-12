//! Мини-просмотр вложений (макет 06-attachments, сцены Б, В, Д, Е): ограниченное чтение текста,
//! первые записи папки, уменьшенная картинка, страница PDF и «открыть / в редакторе / в Finder».
//! Webview большие файлы не читает: сюда приходит путь, обратно — несколько строк или миниатюра.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::Serialize;

use crate::fs_complete;

/// Окно текста целиком — не больше (строки обрезаются, лишние не берутся).
pub const TEXT_MAX: usize = 64 * 1024;
/// Строк в окне просмотра.
pub const WINDOW: usize = 7;
/// Строк до нужной (`Form.tsx:42` — окно 38…44).
const BEFORE: u32 = 4;
/// Символов в строке окна — не больше.
const LINE_CHARS: usize = 200;
/// Начало файла для определения двоичного.
const SNIFF: usize = 8 * 1024;
/// Дальше этого строки не считаем (число строк неизвестно, окно — из начала).
pub const SCAN_MAX: u64 = 8 * 1024 * 1024;
/// Чтение порциями: память не зависит от размера файла.
const CHUNK: usize = 64 * 1024;
/// Записей папки в просмотре.
pub const DIR_ENTRIES: usize = 5;
/// Дочерних записей у подпапки считаем не больше.
const CHILD_MAX: usize = 999;
/// Картинку больше не декодируем ради просмотра.
const IMAGE_SOURCE_MAX: u64 = 60 * 1024 * 1024;
/// Длинная сторона миниатюры — не больше (полный размер — тоже уменьшенная копия).
const IMAGE_SIDE_MAX: u32 = 2400;
/// PDF больше не открываем для просмотра.
const PDF_SOURCE_MAX: u64 = 200 * 1024 * 1024;
const PDF_WIDTH_MAX: u32 = 1600;

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TextPreview {
  /// start — номер первой строки окна (с 1); total — строк в файле (None — файл длиннее SCAN_MAX).
  Text { start: u32, lines: Vec<String>, total: Option<u32>, size: u64 },
  Binary { size: u64 },
  Error { message: String },
}

fn io_message(e: &std::io::Error) -> String {
  match e.kind() {
    std::io::ErrorKind::NotFound => "Файл не найден".to_string(),
    std::io::ErrorKind::PermissionDenied => "Нет доступа".to_string(),
    _ => e.to_string(),
  }
}

/// Двоичный: NUL или неверный UTF-8 (обрезанный на границе порции символ — не ошибка).
pub fn looks_binary(head: &[u8]) -> bool {
  if head.contains(&0) {
    return true;
  }
  match std::str::from_utf8(head) {
    Ok(_) => false,
    Err(e) => e.error_len().is_some(),
  }
}

fn push_line(out: &mut Vec<String>, bytes: &mut Vec<u8>, budget: &mut usize) {
  let raw = String::from_utf8_lossy(bytes).into_owned();
  bytes.clear();
  let mut line = String::new();
  for c in raw.trim_end_matches('\r').chars().take(LINE_CHARS) {
    if line.len() + c.len_utf8() > *budget {
      break;
    }
    line.push(c);
  }
  *budget -= line.len();
  out.push(line);
}

/// Окно текста: WINDOW строк вокруг line (или с начала), всего не больше TEXT_MAX; файл читается
/// порциями до scan_max байт, чтобы посчитать строки. Строка дальше scan_max — окно с начала.
pub fn read_text(path: &Path, line: Option<u32>, scan_max: u64) -> TextPreview {
  let meta = match fs::metadata(path) {
    Ok(m) => m,
    Err(e) => return TextPreview::Error { message: io_message(&e) },
  };
  if meta.is_dir() {
    return TextPreview::Error { message: "Это папка".to_string() };
  }
  // FIFO, устройство: чтение может не закончиться.
  if !meta.is_file() {
    return TextPreview::Error { message: "Особый файл".to_string() };
  }
  let size = meta.len();
  let mut f = match fs::File::open(path) {
    Ok(f) => f,
    Err(e) => return TextPreview::Error { message: io_message(&e) },
  };
  let mut head = Vec::with_capacity(SNIFF);
  if let Err(e) = (&mut f).take(SNIFF as u64).read_to_end(&mut head) {
    return TextPreview::Error { message: io_message(&e) };
  }
  if looks_binary(&head) {
    return TextPreview::Binary { size };
  }
  let from = line.map_or(1, |l| l.saturating_sub(BEFORE).max(1));
  let r = scan(head, f, from, scan_max);
  if r.lines.is_empty() && from > 1 && !r.complete {
    // Нужная строка дальше, чем читаем: показываем начало.
    return match fs::File::open(path) {
      Ok(f) => {
        let r = scan(Vec::new(), f, 1, scan_max);
        TextPreview::Text { start: 1, lines: r.lines, total: None, size }
      }
      Err(e) => TextPreview::Error { message: io_message(&e) },
    };
  }
  if r.lines.is_empty() && from > 1 && r.count > 0 {
    // Строка за концом файла: показываем его конец.
    let tail = r.count.saturating_sub(WINDOW as u32 - 1).max(1);
    return match fs::File::open(path) {
      Ok(f) => {
        let t = scan(Vec::new(), f, tail, scan_max);
        TextPreview::Text { start: tail, lines: t.lines, total: Some(r.count), size }
      }
      Err(e) => TextPreview::Error { message: io_message(&e) },
    };
  }
  let start = if r.lines.is_empty() { 1 } else { from };
  TextPreview::Text { start, lines: r.lines, total: r.complete.then_some(r.count), size }
}

struct Scan {
  lines: Vec<String>,
  /// Строк в файле (последняя без \n тоже строка).
  count: u32,
  /// Файл дочитан до конца.
  complete: bool,
}

fn scan(first: Vec<u8>, mut f: fs::File, from: u32, scan_max: u64) -> Scan {
  let to = from + WINDOW as u32;
  let mut lines = Vec::new();
  let mut cur = Vec::new();
  let mut budget = TEXT_MAX;
  let mut n: u32 = 1;
  let mut read: u64 = 0;
  let mut pending = first;
  let mut buf = vec![0u8; CHUNK];
  let mut any = false;
  let mut last = 0u8;
  let mut complete = false;
  loop {
    let chunk: &[u8] = if !pending.is_empty() {
      &pending
    } else {
      if read >= scan_max {
        break;
      }
      let want = CHUNK.min((scan_max - read) as usize);
      match f.read(&mut buf[..want]) {
        Ok(0) | Err(_) => {
          complete = true;
          break;
        }
        Ok(k) => &buf[..k],
      }
    };
    read += chunk.len() as u64;
    for &b in chunk {
      any = true;
      last = b;
      let inside = n >= from && n < to;
      if b == b'\n' {
        if inside {
          push_line(&mut lines, &mut cur, &mut budget);
        }
        n += 1;
      } else if inside && cur.len() < LINE_CHARS * 4 {
        cur.push(b);
      }
    }
    pending.clear();
  }
  // Последняя строка без перевода строки (или оборванная порогом).
  if !cur.is_empty() && n >= from && n < to {
    push_line(&mut lines, &mut cur, &mut budget);
  }
  let count = match (complete, any) {
    (false, _) => n,
    (true, false) => 0,
    (true, true) => if last == b'\n' { n - 1 } else { n },
  };
  Scan { lines, count, complete }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
  pub name: String,
  pub is_dir: bool,
  /// Размер файла.
  pub size: Option<u64>,
  /// Записей в подпапке (не больше CHILD_MAX).
  pub count: Option<usize>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DirPreview {
  Dir { entries: Vec<DirEntry>, total: usize },
  Error { message: String },
}

/// Первые limit записей папки (сначала папки, по имени; скрытые не показываем) и сколько всего.
pub fn list_preview(path: &Path, limit: usize) -> DirPreview {
  let all = match fs_complete::list_dir(path, false, false) {
    Ok(v) => v,
    Err(message) => return DirPreview::Error { message },
  };
  let total = all.len();
  let entries = all
    .into_iter()
    .take(limit)
    .map(|e| {
      let p = path.join(&e.name);
      if e.is_dir {
        let count = fs::read_dir(&p).ok().map(|rd| rd.take(CHILD_MAX).flatten().filter(|c| !c.file_name().to_string_lossy().starts_with('.')).count());
        DirEntry { name: e.name, is_dir: true, size: None, count }
      } else {
        DirEntry { name: e.name, is_dir: false, size: fs::metadata(&p).ok().map(|m| m.len()), count: None }
      }
    })
    .collect();
  DirPreview::Dir { entries, total }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreview {
  pub width: u32,
  pub height: u32,
  pub size: u64,
  /// data:image/…;base64 — уменьшенная копия (длинная сторона не больше запрошенной).
  pub src: String,
}

fn encode_preview(img: &DynamicImage) -> Result<String, String> {
  let mut out = Cursor::new(Vec::new());
  if img.color().has_alpha() {
    img.write_to(&mut out, ImageFormat::Png).map_err(|e| e.to_string())?;
    return Ok(format!("data:image/png;base64,{}", B64.encode(out.into_inner())));
  }
  DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(JpegEncoder::new_with_quality(&mut out, 85)).map_err(|e| e.to_string())?;
  Ok(format!("data:image/jpeg;base64,{}", B64.encode(out.into_inner())))
}

/// Картинка для просмотра: исходные размеры и копия с длинной стороной не больше max.
pub fn image_preview(path: &Path, max: u32) -> Result<ImagePreview, String> {
  let size = fs::metadata(path).map_err(|e| io_message(&e))?.len();
  if size > IMAGE_SOURCE_MAX {
    return Err("Картинка слишком большая для просмотра".to_string());
  }
  let img = ImageReader::open(path)
    .map_err(|e| io_message(&e))?
    .with_guessed_format()
    .map_err(|e| e.to_string())?
    .decode()
    .map_err(|_| "Не удалось прочитать картинку".to_string())?;
  let (width, height) = (img.width(), img.height());
  let max = max.clamp(16, IMAGE_SIDE_MAX);
  let small = if width.max(height) > max { img.resize(max, max, FilterType::Triangle) } else { img };
  Ok(ImagePreview { width, height, size, src: encode_preview(&small)? })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfPreview {
  pub pages: u32,
  /// Показанная страница (с 1).
  pub page: u32,
  pub size: u64,
  pub src: String,
}

/// Страница PDF картинкой шириной width (CoreGraphics; страница вне диапазона — ближайшая).
pub fn pdf_preview(path: &Path, page: u32, width: u32) -> Result<PdfPreview, String> {
  let size = fs::metadata(path).map_err(|e| io_message(&e))?.len();
  if size > PDF_SOURCE_MAX {
    return Err("PDF слишком большой для просмотра".to_string());
  }
  let (pages, page, img) = render_pdf(path, page, width.clamp(16, PDF_WIDTH_MAX))?;
  Ok(PdfPreview { pages, page, size, src: encode_preview(&DynamicImage::ImageRgb8(img))? })
}

#[cfg(target_os = "macos")]
fn render_pdf(path: &Path, page: u32, width: u32) -> Result<(u32, u32, image::RgbImage), String> {
  cg::render(path, page, width)
}

#[cfg(not(target_os = "macos"))]
fn render_pdf(_path: &Path, _page: u32, _width: u32) -> Result<(u32, u32, image::RgbImage), String> {
  Err("Просмотр PDF недоступен".to_string())
}

/// Отрисовка страницы PDF средствами macOS (CoreGraphics) — без сторонних библиотек.
#[cfg(target_os = "macos")]
mod cg {
  use std::ffi::c_void;
  use std::os::unix::ffi::OsStrExt;
  use std::path::Path;

  type Ref = *const c_void;

  #[repr(C)]
  #[derive(Clone, Copy)]
  struct Point {
    x: f64,
    y: f64,
  }
  #[repr(C)]
  #[derive(Clone, Copy)]
  struct Size {
    w: f64,
    h: f64,
  }
  #[repr(C)]
  #[derive(Clone, Copy)]
  struct Rect {
    origin: Point,
    size: Size,
  }
  #[repr(C)]
  #[derive(Clone, Copy)]
  struct Affine {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    tx: f64,
    ty: f64,
  }

  const CROP_BOX: i32 = 1;
  /// kCGImageAlphaPremultipliedLast, порядок байт по умолчанию: R, G, B, A.
  const RGBA: u32 = 1;

  #[link(name = "CoreFoundation", kind = "framework")]
  unsafe extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(alloc: Ref, buf: *const u8, len: isize, is_dir: u8) -> Ref;
    fn CFRelease(cf: Ref);
  }

  #[link(name = "CoreGraphics", kind = "framework")]
  unsafe extern "C" {
    fn CGPDFDocumentCreateWithURL(url: Ref) -> Ref;
    fn CGPDFDocumentGetNumberOfPages(doc: Ref) -> usize;
    fn CGPDFDocumentGetPage(doc: Ref, n: usize) -> Ref;
    fn CGPDFDocumentRelease(doc: Ref);
    fn CGPDFPageGetBoxRect(page: Ref, b: i32) -> Rect;
    fn CGPDFPageGetRotationAngle(page: Ref) -> i32;
    fn CGPDFPageGetDrawingTransform(page: Ref, b: i32, rect: Rect, rotate: i32, preserve: bool) -> Affine;
    fn CGColorSpaceCreateDeviceRGB() -> Ref;
    fn CGColorSpaceRelease(cs: Ref);
    fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bpc: usize, bpr: usize, cs: Ref, info: u32) -> Ref;
    fn CGContextRelease(c: Ref);
    fn CGContextSetRGBFillColor(c: Ref, r: f64, g: f64, b: f64, a: f64);
    fn CGContextFillRect(c: Ref, r: Rect);
    fn CGContextScaleCTM(c: Ref, sx: f64, sy: f64);
    fn CGContextConcatCTM(c: Ref, t: Affine);
    fn CGContextDrawPDFPage(c: Ref, page: Ref);
  }

  pub fn render(path: &Path, page: u32, width: u32) -> Result<(u32, u32, image::RgbImage), String> {
    let bytes = path.as_os_str().as_bytes();
    // SAFETY: все объекты CF/CG создаются и освобождаются здесь же; страница принадлежит документу.
    unsafe {
      let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, 0);
      if url.is_null() {
        return Err("Не удалось открыть PDF".to_string());
      }
      let doc = CGPDFDocumentCreateWithURL(url);
      CFRelease(url);
      if doc.is_null() {
        return Err("Не удалось прочитать PDF".to_string());
      }
      let pages = CGPDFDocumentGetNumberOfPages(doc) as u32;
      if pages == 0 {
        CGPDFDocumentRelease(doc);
        return Err("В PDF нет страниц".to_string());
      }
      let n = page.clamp(1, pages);
      let pg = CGPDFDocumentGetPage(doc, n as usize);
      if pg.is_null() {
        CGPDFDocumentRelease(doc);
        return Err("Не удалось прочитать страницу PDF".to_string());
      }
      let bx = CGPDFPageGetBoxRect(pg, CROP_BOX);
      let turned = CGPDFPageGetRotationAngle(pg).rem_euclid(180) == 90;
      let (pw, ph) = if turned { (bx.size.h, bx.size.w) } else { (bx.size.w, bx.size.h) };
      if !(pw > 0.0 && ph > 0.0) {
        CGPDFDocumentRelease(doc);
        return Err("Пустая страница PDF".to_string());
      }
      let scale = width as f64 / pw;
      let w = width as usize;
      let h = ((ph * scale).round() as usize).clamp(1, w * 4);
      let mut buf = vec![0u8; w * h * 4];
      let cs = CGColorSpaceCreateDeviceRGB();
      let ctx = CGBitmapContextCreate(buf.as_mut_ptr() as *mut c_void, w, h, 8, w * 4, cs, RGBA);
      CGColorSpaceRelease(cs);
      if ctx.is_null() {
        CGPDFDocumentRelease(doc);
        return Err("Не удалось отрисовать PDF".to_string());
      }
      CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
      CGContextFillRect(ctx, Rect { origin: Point { x: 0.0, y: 0.0 }, size: Size { w: w as f64, h: h as f64 } });
      CGContextScaleCTM(ctx, scale, scale);
      let t = CGPDFPageGetDrawingTransform(pg, CROP_BOX, Rect { origin: Point { x: 0.0, y: 0.0 }, size: Size { w: pw, h: ph } }, 0, true);
      CGContextConcatCTM(ctx, t);
      CGContextDrawPDFPage(ctx, pg);
      CGContextRelease(ctx);
      CGPDFDocumentRelease(doc);
      let rgb: Vec<u8> = buf.as_chunks::<4>().0.iter().flat_map(|p| [p[0], p[1], p[2]]).collect();
      let img = image::RgbImage::from_raw(w as u32, h as u32, rgb).ok_or("Не удалось отрисовать PDF")?;
      Ok((pages, n, img))
    }
  }
}

/// Редакторы, которые живут в терминале: без него их запускать бесполезно.
const TERMINAL_EDITORS: [&str; 12] = ["vi", "vim", "nvim", "nano", "pico", "emacs", "micro", "hx", "helix", "kak", "joe", "ed"];

/// Слова строки как в sh: пробелы делят, '…' и "…" (с \-экранами) склеивают, \ экранирует символ.
/// Ничего не подставляется и не исполняется. Незакрытая кавычка — до конца строки.
pub fn shell_words(s: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut cur = String::new();
  let mut has = false;
  let mut it = s.chars();
  while let Some(c) = it.next() {
    match c {
      '\'' => {
        has = true;
        for d in it.by_ref() {
          if d == '\'' {
            break;
          }
          cur.push(d);
        }
      }
      '"' => {
        has = true;
        while let Some(d) = it.next() {
          match d {
            '"' => break,
            '\\' => {
              if let Some(e) = it.next() {
                cur.push(e);
              }
            }
            _ => cur.push(d),
          }
        }
      }
      '\\' => {
        has = true;
        if let Some(e) = it.next() {
          cur.push(e);
        }
      }
      c if c.is_whitespace() => {
        if has {
          out.push(std::mem::take(&mut cur));
          has = false;
        }
      }
      c => {
        has = true;
        cur.push(c);
      }
    }
  }
  if has {
    out.push(cur);
  }
  out
}

/// Чем открыть файл «в редакторе»: $VISUAL (если это не терминальный редактор и программа нашлась),
/// иначе `code`. resolve — путь к программе по имени (PATH login-оболочки), code — путь к `code`.
pub fn pick_editor(visual: &str, resolve: impl Fn(&str) -> Option<String>, code: &str) -> Option<(PathBuf, Vec<String>)> {
  let words = shell_words(visual);
  if let Some((prog, rest)) = words.split_first() {
    let name = Path::new(prog).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // `--wait` держит процесс до закрытия файла: нам ждать нечего.
    let args: Vec<String> = rest.iter().filter(|w| *w != "--wait" && *w != "-w").cloned().collect();
    if !TERMINAL_EDITORS.contains(&name.as_str()) {
      let found = if prog.contains('/') { Path::new(prog).is_file().then(|| prog.clone()) } else { resolve(prog) };
      if let Some(p) = found {
        return Some((PathBuf::from(p), args));
      }
    }
  }
  (!code.is_empty()).then(|| (PathBuf::from(code), Vec::new()))
}

/// Аргументы редактора для файла и строки: VS Code-подобные — `-g путь:строка`, Sublime/Zed — `путь:строка`.
pub fn editor_args(prog: &Path, mut args: Vec<String>, path: &str, line: Option<u32>) -> Vec<String> {
  let name = prog.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  match (line, name.as_str()) {
    (Some(l), "code" | "code-insiders" | "codium" | "cursor" | "windsurf") => args.extend(["-g".to_string(), format!("{path}:{l}")]),
    (Some(l), "subl" | "zed" | "mate") => args.push(format!("{path}:{l}")),
    _ => args.push(path.to_string()),
  }
  args
}

static EDITOR: OnceLock<(String, String)> = OnceLock::new();

fn login_shell() -> String {
  std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
}

/// Последние n строк вывода login-оболочки (rc-файлы могут печатать лишнее выше).
fn shell_tail(args: &[&str], n: usize) -> Vec<String> {
  let out = run_with_timeout(Command::new(login_shell()).args(args), Duration::from_secs(5)).unwrap_or_default();
  let text = String::from_utf8_lossy(&out);
  let lines: Vec<&str> = text.lines().collect();
  if lines.len() < n {
    return vec![String::new(); n];
  }
  lines[lines.len() - n..].iter().map(|l| l.trim().to_string()).collect()
}

/// $VISUAL и путь к `code` — из login-оболочки (из Dock их не видно). Кэш на сеанс.
fn editor_env() -> &'static (String, String) {
  EDITOR.get_or_init(|| {
    let t = shell_tail(&["-lic", r#"printf '\n%s\n%s\n' "$VISUAL" "$(command -v code 2>/dev/null)""#], 2);
    let code = if t[1].starts_with('/') { t[1].clone() } else { String::new() };
    (t[0].clone(), code)
  })
}

/// Программа по имени из PATH login-оболочки; имя — позиционным аргументом, без подстановки в скрипт.
fn resolve_in_shell(name: &str) -> Option<String> {
  let t = shell_tail(&["-lic", r#"command -v -- "$1""#, "_", name], 1);
  t[0].starts_with('/').then(|| t[0].clone())
}

fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<Vec<u8>> {
  use std::os::unix::process::CommandExt;
  let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0).spawn().ok()?;
  let mut stdout = child.stdout.take()?;
  let reader = std::thread::spawn(move || {
    let mut buf = Vec::new();
    let _ = stdout.read_to_end(&mut buf);
    buf
  });
  let deadline = Instant::now() + timeout;
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
      _ => {
        // SAFETY: сигнал группе процессов только что запущенной оболочки.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        let _ = child.wait();
        return None;
      }
    }
  }
  reader.join().ok()
}

/// Как открыть: default — программой по умолчанию, editor — в редакторе, reveal — показать в Finder.
pub fn open_command(how: &str, path: &str, line: Option<u32>, editor: Option<(PathBuf, Vec<String>)>) -> Result<(PathBuf, Vec<String>), String> {
  match how {
    "default" => Ok((PathBuf::from("/usr/bin/open"), vec![path.to_string()])),
    "reveal" => Ok((PathBuf::from("/usr/bin/open"), vec!["-R".to_string(), path.to_string()])),
    "editor" => Ok(match editor {
      Some((prog, args)) => {
        let args = editor_args(&prog, args, path, line);
        (prog, args)
      }
      // Редактор не найден — текстовый редактор системы.
      None => (PathBuf::from("/usr/bin/open"), vec!["-t".to_string(), path.to_string()]),
    }),
    _ => Err(format!("неизвестное действие: {how}")),
  }
}

#[tauri::command(async)]
pub fn preview_text(path: String, line: Option<u32>) -> TextPreview {
  read_text(Path::new(&path), line, SCAN_MAX)
}

#[tauri::command(async)]
pub fn preview_dir(path: String) -> DirPreview {
  list_preview(Path::new(&path), DIR_ENTRIES)
}

#[tauri::command(async)]
pub fn preview_image(path: String, max: u32) -> Result<ImagePreview, String> {
  image_preview(Path::new(&path), max)
}

#[tauri::command(async)]
pub fn preview_pdf(path: String, page: u32, width: u32) -> Result<PdfPreview, String> {
  pdf_preview(Path::new(&path), page, width)
}

#[tauri::command(async)]
pub fn preview_open(path: String, how: String, line: Option<u32>) -> Result<(), String> {
  if !Path::new(&path).exists() {
    return Err("Файл не найден".to_string());
  }
  let editor = if how == "editor" {
    let (v, c) = editor_env();
    pick_editor(v, resolve_in_shell, c)
  } else {
    None
  };
  let (prog, args) = open_command(&how, &path, line, editor)?;
  let mut child = Command::new(prog)
    .args(args)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| e.to_string())?;
  // Дождаться в фоне: иначе процесс остаётся зомби до выхода из приложения.
  std::thread::spawn(move || {
    let _ = child.wait();
  });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn text(p: &TextPreview) -> (u32, Vec<String>, Option<u32>) {
    match p {
      TextPreview::Text { start, lines, total, .. } => (*start, lines.clone(), *total),
      other => panic!("{other:?}"),
    }
  }

  fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
  }

  #[test]
  fn head_window_and_line_count() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("a.ts");
    fs::write(&f, numbered(182)).unwrap();
    let (start, lines, total) = text(&read_text(&f, None, SCAN_MAX));
    assert_eq!(start, 1);
    assert_eq!(lines, (1..=7).map(|i| format!("line {i}")).collect::<Vec<_>>());
    assert_eq!(total, Some(182));
    // Без последнего \n строк столько же.
    fs::write(&f, "a\nb").unwrap();
    assert_eq!(text(&read_text(&f, None, SCAN_MAX)), (1, vec!["a".into(), "b".into()], Some(2)));
    fs::write(&f, "").unwrap();
    assert_eq!(text(&read_text(&f, None, SCAN_MAX)), (1, vec![], Some(0)));
  }

  #[test]
  fn window_around_line() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("Form.tsx");
    fs::write(&f, numbered(50)).unwrap();
    let (start, lines, _) = text(&read_text(&f, Some(42), SCAN_MAX));
    assert_eq!(start, 38);
    assert_eq!(lines.first().unwrap(), "line 38");
    assert_eq!(lines.len(), 7);
    // У начала файла окно не уходит в минус; за концом — сколько есть.
    assert_eq!(text(&read_text(&f, Some(2), SCAN_MAX)).0, 1);
    let (s, l, _) = text(&read_text(&f, Some(50), SCAN_MAX));
    assert_eq!((s, l.len()), (46, 5));
    // Строка за концом файла — его конец.
    let (s, l, t) = text(&read_text(&f, Some(500), SCAN_MAX));
    assert_eq!((s, l.len(), l[6].as_str(), t), (44, 7, "line 50", Some(50)));
  }

  #[test]
  fn line_beyond_scan_cap_falls_back_to_head_without_total() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("big.log");
    fs::write(&f, numbered(20_000)).unwrap();
    let (start, lines, total) = text(&read_text(&f, Some(19_000), 1024));
    assert_eq!((start, total), (1, None));
    assert_eq!(lines[0], "line 1");
    // Строка внутри порога — окно у неё, но строки не досчитаны.
    let (start, lines, total) = text(&read_text(&f, Some(10), 1024));
    assert_eq!((start, lines[0].as_str(), total), (6, "line 6", None));
  }

  #[test]
  fn long_lines_and_window_are_capped() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("min.js");
    let long = "x".repeat(1024 * 1024);
    fs::write(&f, format!("{long}\nshort\n")).unwrap();
    let (_, lines, total) = text(&read_text(&f, None, SCAN_MAX));
    assert_eq!(lines[0].chars().count(), LINE_CHARS);
    assert_eq!(lines[1], "short");
    assert_eq!(total, Some(2));
    let sum: usize = lines.iter().map(|l| l.len()).sum();
    assert!(sum <= TEXT_MAX);
    // Файл длиннее порога: строк не знаем, оборванная строка — в окне.
    let (_, lines, total) = text(&read_text(&f, None, 64 * 1024));
    assert_eq!((lines.len(), total), (1, None));
  }

  #[test]
  fn binary_detection() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("x.bin");
    fs::write(&f, [1u8, 2, 0, 3]).unwrap();
    assert_eq!(read_text(&f, None, SCAN_MAX), TextPreview::Binary { size: 4 });
    fs::write(&f, [0xffu8, 0xfe, b'a']).unwrap();
    assert!(matches!(read_text(&f, None, SCAN_MAX), TextPreview::Binary { .. }));
    // Русский текст, обрезанный на середине буквы, — не двоичный.
    let s = "привет".as_bytes();
    assert!(!looks_binary(&s[..s.len() - 1]));
    assert!(matches!(read_text(&d.path().join("нет"), None, SCAN_MAX), TextPreview::Error { .. }));
    assert!(matches!(read_text(d.path(), None, SCAN_MAX), TextPreview::Error { .. }));
  }

  #[test]
  fn crlf_is_trimmed() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("w.txt");
    fs::write(&f, "a\r\nb\r\n").unwrap();
    assert_eq!(text(&read_text(&f, None, SCAN_MAX)).1, vec!["a", "b"]);
  }

  #[test]
  fn folder_first_entries_and_total() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir(d.path().join("themes")).unwrap();
    for n in ["a.css", "b.css", "c.css"] {
      fs::write(d.path().join("themes").join(n), "").unwrap();
    }
    fs::write(d.path().join("themes/.hidden"), "").unwrap();
    for (n, len) in [("form.css", 2048), ("cart.css", 10), ("tokens.css", 1), ("x.css", 1), ("y.css", 1), ("z.css", 1)] {
      fs::write(d.path().join(n), vec![b'a'; len]).unwrap();
    }
    fs::write(d.path().join(".DS_Store"), "").unwrap();
    match list_preview(d.path(), DIR_ENTRIES) {
      DirPreview::Dir { entries, total } => {
        assert_eq!(total, 7);
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[0], DirEntry { name: "themes".into(), is_dir: true, size: None, count: Some(3) });
        assert_eq!(entries[1].name, "cart.css");
        assert_eq!(entries[2], DirEntry { name: "form.css".into(), is_dir: false, size: Some(2048), count: None });
      }
      other => panic!("{other:?}"),
    }
    assert!(matches!(list_preview(&d.path().join("нет"), 5), DirPreview::Error { .. }));
  }

  #[test]
  fn image_preview_is_downscaled_copy() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("shot.png");
    image::RgbaImage::from_pixel(1440, 900, image::Rgba([10, 20, 30, 255])).save(&p).unwrap();
    let i = image_preview(&p, 600).unwrap();
    assert_eq!((i.width, i.height), (1440, 900));
    assert_eq!(i.size, fs::metadata(&p).unwrap().len());
    let b64 = i.src.split_once(',').unwrap().1;
    let small = image::load_from_memory(&B64.decode(b64).unwrap()).unwrap();
    assert_eq!((small.width(), small.height()), (600, 375));
    // Без альфы — JPEG, с альфой — PNG.
    let q = d.path().join("rgb.png");
    image::RgbImage::from_pixel(10, 10, image::Rgb([1, 2, 3])).save(&q).unwrap();
    assert!(image_preview(&q, 600).unwrap().src.starts_with("data:image/jpeg;base64,"));
    assert!(i.src.starts_with("data:image/png;base64,"));
    let bad = d.path().join("bad.png");
    fs::write(&bad, "nope").unwrap();
    assert!(image_preview(&bad, 600).is_err());
  }

  /// Простой PDF: страницы шириной 200×100 pt, на первой — чёрный прямоугольник сверху.
  fn pdf(path: &Path, pages: usize) {
    let mut objs: Vec<String> = Vec::new();
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 3 + i * 2)).collect();
    objs.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    objs.push(format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages));
    for i in 0..pages {
      objs.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents {} 0 R >>", 4 + i * 2));
      let content = if i == 0 { "0 g 0 50 200 50 re f" } else { "" };
      objs.push(format!("<< /Length {} >>\nstream\n{}\nendstream", content.len(), content));
    }
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (i, o) in objs.iter().enumerate() {
      offsets.push(out.len());
      out.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, o));
    }
    let xref = out.len();
    out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1));
    for off in offsets {
      out.push_str(&format!("{off:010} 00000 n \n"));
    }
    out.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n", objs.len() + 1, xref));
    fs::write(path, out).unwrap();
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn pdf_page_render_and_count() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("spec.pdf");
    pdf(&p, 3);
    let (pages, page, img) = render_pdf(&p, 1, 400).unwrap();
    assert_eq!((pages, page, img.width(), img.height()), (3, 1, 400, 200));
    // Прямоугольник — в верхней половине страницы (картинка не перевёрнута), низ — белый.
    assert!(img.get_pixel(200, 20)[0] < 50);
    assert!(img.get_pixel(200, 180)[0] > 200);
    // Вторая страница пустая; номер за пределами — последняя.
    let (_, page, img) = render_pdf(&p, 9, 100).unwrap();
    assert_eq!(page, 3);
    assert!(img.get_pixel(50, 10)[0] > 200);
    let v = pdf_preview(&p, 2, 300).unwrap();
    assert_eq!((v.pages, v.page), (3, 2));
    assert!(v.src.starts_with("data:image/jpeg;base64,"));
    let bad = d.path().join("bad.pdf");
    fs::write(&bad, "nope").unwrap();
    assert!(pdf_preview(&bad, 1, 300).is_err());
  }

  #[test]
  fn shell_words_like_sh() {
    assert_eq!(shell_words("subl -w"), vec!["subl", "-w"]);
    assert_eq!(shell_words(r#""/Applications/My Editor.app/bin/ed" --wait -n"#), vec!["/Applications/My Editor.app/bin/ed", "--wait", "-n"]);
    assert_eq!(shell_words(r#"'a b' c\ d "e\"f" $(rm -rf x)"#), vec!["a b", "c d", "e\"f", "$(rm", "-rf", "x)"]);
    assert!(shell_words("   ").is_empty());
    assert_eq!(shell_words("''"), vec![""]);
  }

  #[test]
  fn editor_choice() {
    let none = |_: &str| None::<String>;
    let found = |n: &str| Some(format!("/opt/bin/{n}"));
    // GUI-редактор из $VISUAL (без --wait/-w), строка — по правилам редактора.
    let (p, a) = pick_editor("code --wait", found, "").unwrap();
    assert_eq!(p, PathBuf::from("/opt/bin/code"));
    assert_eq!(editor_args(&p, a, "/w/Form.tsx", Some(42)), vec!["-g", "/w/Form.tsx:42"]);
    let (p, a) = pick_editor("subl -w -n", found, "/usr/local/bin/code").unwrap();
    assert_eq!(p, PathBuf::from("/opt/bin/subl"));
    assert_eq!(editor_args(&p, a, "/w/a.rs", Some(3)), vec!["-n", "/w/a.rs:3"]);
    // Абсолютный путь с пробелами в кавычках — без поиска в PATH.
    let d = tempfile::tempdir().unwrap();
    let ed = d.path().join("My Editor");
    fs::write(&ed, "").unwrap();
    let (p, a) = pick_editor(&format!("\"{}\" --wait", ed.display()), none, "").unwrap();
    assert_eq!((p, a), (ed.clone(), Vec::<String>::new()));
    // Терминальный редактор и ненайденный — `code`.
    let (p, _) = pick_editor("nvim", found, "/usr/local/bin/code").unwrap();
    assert_eq!(p, PathBuf::from("/usr/local/bin/code"));
    let (p, _) = pick_editor("nope", none, "/usr/local/bin/code").unwrap();
    assert_eq!(p, PathBuf::from("/usr/local/bin/code"));
    assert!(pick_editor("", found, "").is_none());
    assert!(pick_editor("vim", found, "").is_none());
    // Не найден — `open -t`.
    assert_eq!(open_command("editor", "/w/a", None, None).unwrap(), (PathBuf::from("/usr/bin/open"), vec!["-t".into(), "/w/a".into()]));
    assert_eq!(open_command("reveal", "/w/d", None, None).unwrap().1, vec!["-R", "/w/d"]);
    assert_eq!(open_command("default", "/w/a", None, None).unwrap().1, vec!["/w/a"]);
    assert!(open_command("rm", "/w/a", None, None).is_err());
  }
}
