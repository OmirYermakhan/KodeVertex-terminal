# Быстрые входы: папка проекта и своя картинка — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** вход в полосе слева может открывать вкладку в заданной папке (команда необязательна) и показывать свою картинку с Мака.

**Architecture:** `Launcher` получает `cwd?` и `image?` (data-URL 64×64 PNG). Картинку уменьшает новая Rust-команда `launcher_icon` на коде миниатюр вложений. `openLauncher` открывает вкладку в `cwd` и не ставит в очередь пустую команду. Окно входа получает поле «Папка» и плитку «Своя картинка…», полоса показывает картинку вместо значка.

**Tech Stack:** Tauri 2 (Rust, crate `image`), React + zustand, vitest, `@tauri-apps/plugin-dialog` (`dialog:allow-open` уже есть).

**Spec:** `docs/superpowers/specs/2026-11-19-launcher-folder-icon-design.md`

## Global Constraints
- Сборка Rust: префикс `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` для cargo / `npm run tauri build`.
- Тексты интерфейса на русском; коммиты без упоминаний ИИ и без Co-Authored-By.
- Картинка: только `IMAGE_EXT` из `attach.rs` (png, jpg, jpeg, gif, webp), миниатюра 64×64, `data:image/png;base64,…`.
- После сборки заменить `/Applications/KodeVertex Terminal.app`.

## Review Focus
- Вход без команды, но с папкой → сохраняется и переживает перезапуск (normalize его не выбрасывает). Тест — задача 2.
- Повторный клик по открытому входу без команды → только переключение, ничего не печатается в оболочку. Тест — задача 2.
- Битый `image` в файле настроек (не data:image/png, слишком длинный) → отбрасывается, вход остаётся со значком. Тест — задача 2.
- Не картинка / нечитаемый файл в `launcher_icon` → понятная ошибка, окно не падает, прежний значок остаётся. Тесты — задачи 1 и 3.
- Нет ни команды, ни папки → «Сохранить» неактивна. Тест — задача 3.

---

### Task 1: Rust-команда `launcher_icon`

**Files:**
- Modify: `src-tauri/src/attach.rs` (рядом с `thumbnail`, тесты в его `mod tests`)
- Modify: `src-tauri/src/lib.rs:119-150` (регистрация в `generate_handler!`)

**Interfaces:**
- Produces: `#[tauri::command] pub async fn launcher_icon(path: String) -> Result<String, String>` — `data:image/png;base64,…` 64×64 (`resize_to_fill`), ошибка `"не картинка"` если `!is_image` или не декодируется; исходник больше `THUMB_SOURCE_MAX` — ошибка `"картинка слишком большая"`. Внутри — синхронная `pub fn icon_data_url(p: &Path, side: u32) -> Result<String, String>`, через `spawn_blocking`.

- [ ] **Step 1: тесты** `icon_data_url_makes_64px_png` (сгенерировать png 200×100 во временной папке, результат начинается с `data:image/png;base64,`, после декодирования 64×64) и `icon_data_url_rejects_non_image` (txt-файл → `Err`).
- [ ] **Step 2:** `DEVELOPER_DIR=… cargo test --manifest-path src-tauri/Cargo.toml icon_data_url` → FAIL (нет функции).
- [ ] **Step 3:** реализовать `icon_data_url` (общий код с `thumbnail` вынести, `thumbnail` = `icon_data_url(p, THUMB).ok()`), команду `launcher_icon`, зарегистрировать.
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5:** commit «Быстрые входы: миниатюра своей картинки».

### Task 2: Модель и запуск входа

**Files:**
- Modify: `src/launch/launchers.ts`, `src/launch/runner.ts`
- Test: `src/launch/runner.test.ts`

**Interfaces:**
- Produces: `interface Launcher { id; name; command: string /* может быть '' */; icon; color; cwd?: string; image?: string }`; `export const MAX_IMAGE = 64 * 1024`; `export function folderName(path: string): string` (`'/a/b/proj/'` → `'proj'`, `'/'` → `'/'`).
- `normalizeLaunchers`: вход валиден, если непустая команда **или** непустой абсолютный `cwd` (начинается с `/`); имя по умолчанию — команда, иначе `folderName(cwd)`; `image` сохраняется только если строка, начинается с `data:image/png;base64,` и длина ≤ `MAX_IMAGE`; `cwd` — только строка с `/` в начале.
- `openLauncher(l)`: новая вкладка — `s.newTab(l.cwd ?? cur?.cwd[cur.focused], l.id)`; `pending.set` только при непустой команде; у существующей вкладки при пустой команде — только activate/focus, `run` не вызывается.

- [ ] **Step 1: тесты в `runner.test.ts`:**
  - `'вход с папкой — вкладка открывается в ней'`: `openLauncher({...L, cwd: '/p/app'})` → `t.cwd[t.id] === '/p/app'`.
  - `'вход без команды — ничего не ждёт и не запускается повторно'`: `openLauncher({...L, command: '', cwd: '/p'})` → `takePending(t.id)` is `null`; затем зарегистрировать runner `{ run, busy: () => false }`, переключиться на другую вкладку, снова `openLauncher` → active = t.id, `run` не вызван.
  - `normalizeLaunchers`: `[{ id:'a', command:'', cwd:'/x/proj', icon:'box', color:'#000000' }]` → один вход с `name: 'proj'`; `[{ id:'b', command:'' }]` → `[]`; `image: 'data:text/html,…'` и `image` длиной `MAX_IMAGE+1` → поле отсутствует; `cwd: 'rel/path'` → поле отсутствует.
  - `folderName('/a/b/proj/') === 'proj'`.
- [ ] **Step 2:** `npx vitest run src/launch` → FAIL.
- [ ] **Step 3:** реализовать по Interfaces.
- [ ] **Step 4:** `npx vitest run src/launch src/settings` → PASS, `npx tsc --noEmit -p .` чисто.
- [ ] **Step 5:** commit «Быстрые входы: папка проекта, команда необязательна».

### Task 3: Окно входа и полоса

**Files:**
- Modify: `src/launch/LauncherDialog.tsx`, `src/project/Stripe.tsx` (`LauncherButton`), `src/global.css` (блок `.ld-*`, `.sb-l`)
- Create: `src/launch/LauncherDialog.test.tsx`

**Interfaces:**
- Consumes: `Launcher.cwd/image`, `folderName`, `MAX_IMAGE` (задача 2); `invoke('launcher_icon', { path })` (задача 1); `open` из `@tauri-apps/plugin-dialog`.
- Окно: поле «Папка» под «Команда»: путь (моноширинно, `~` вместо домашней папки не обязательно) + кнопка «Выбрать…» (`open({ directory: true, title: 'Папка проекта' })`) + «✕» сброса, если выбрана. Новый вход: начальная команда `''` (не `'ssh '`), плейсхолдер команды `'ssh deploy@203.0.113.10 — или пусто'`; `LAUNCHER_COMMAND_HINT` = `'Необязательно. Выполняется в новой вкладке при каждом входе: ssh, docker exec…'`. `canSave = (command.trim() !== '' || !!cwd) && !full`. Плейсхолдер названия: `suggestName(command) || (cwd ? folderName(cwd) : 'prod-api')`, то же — имя по умолчанию при сохранении.
- Ряд значков: первая плитка `aria-label="Своя картинка"` — без картинки показывает «＋🖼»-подобный значок, с картинкой — её саму (`<img>`), `aria-checked` = есть картинка. Клик: `open({ multiple: false, filters: [{ name: 'Картинка', extensions: ['png','jpg','jpeg','gif','webp'] }] })` → `invoke` → `setImage`; ошибка — подпись `st-hint` с текстом ошибки. Клик по готовому значку сбрасывает `image`.
- Полоса: `l.image` → `<img className="sb-img" src={l.image} alt="" />` (16×16, `border-radius: 3px`) вместо `<LauncherIcon>`; в `title` вместо команды — `l.command || l.cwd`.

- [ ] **Step 1: тесты в `LauncherDialog.test.tsx`** (mock `@tauri-apps/plugin-dialog` и `@tauri-apps/api/core` как в `src/ui/SettingsPanel.test.tsx`; `useSettings` с пустыми `launchers`):
  - `'без команды и папки — сохранить нельзя'`: кнопка «Сохранить и открыть» disabled.
  - `'папка без команды — вход сохраняется с именем папки'`: `open` → `'/Users/x/proj'`, клик «Выбрать…», клик «Сохранить и открыть» → в настройках вход `{ command: '', cwd: '/Users/x/proj', name: 'proj' }`.
  - `'своя картинка — сохраняется data-URL'`: `open` → `'/i.png'`, `invoke` → `'data:image/png;base64,AAA'`, клик «Своя картинка», ввести команду, сохранить → `image === 'data:image/png;base64,AAA'`.
  - `'картинка не прочиталась — показана ошибка, значок прежний'`: `invoke` reject `'не картинка'` → текст «не картинка» на экране, `image` не сохранён.
- [ ] **Step 2:** `npx vitest run src/launch/LauncherDialog.test.tsx` → FAIL.
- [ ] **Step 3:** реализовать окно, полосу, стили.
- [ ] **Step 4:** `npx vitest run` целиком и `npx tsc --noEmit -p .` → чисто.
- [ ] **Step 5:** сборка `DEVELOPER_DIR=… npm run tauri build -- --bundles app`, заменить приложение в `/Applications`.
- [ ] **Step 6:** commit «Быстрые входы: выбор папки и своей картинки в окне входа».
