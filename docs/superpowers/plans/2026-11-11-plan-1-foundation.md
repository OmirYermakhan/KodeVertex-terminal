# KodeVertex Terminal — План 1: фундамент

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Рабочее приложение-терминал для macOS: окно с вкладками в заголовке, zsh в xterm,
разделение экрана, 5 тем, настраиваемые шрифты, статус-бар (проект, ветка, папка, время)
и публичный репозиторий на GitHub.

**Architecture:** Tauri 2. Rust-ядро держит PTY-процессы, читает git-информацию, хранит настройки
и отдаёт список системных шрифтов. Интерфейс на React + TypeScript: дерево панелей в каждой
вкладке, каждая панель — xterm.js, подключённый к PTY через Tauri Channel (сырые байты).
Логика (темы, настройки, дерево панелей, клавиши) живёт в чистых TS-модулях с юнит-тестами.

**Tech Stack:** Tauri 2, Rust (portable-pty, serde, toml, fontdb), React 18, TypeScript, Vite,
zustand, @xterm/xterm 5 + addons (fit, webgl, unicode11, web-links), @fontsource/*, Vitest,
@testing-library/react.

**Spec:** `docs/superpowers/specs/2026-11-11-kodevertex-terminal-design.md` (разделы 3, 4.3–4.6, 5, 9 п.1).
Следующие планы: 2 — блоки OSC 133 и строка ввода как в Warp, а также ⌘F, ⌃R, ⌘P, ⌘⇧C, ⌘↑↓;
3 — интеграция Claude; 4 — CI и релизы `.dmg`.

## Global Constraints

- Платформа сейчас macOS (Apple Silicon). Код не должен использовать macOS-only API в TS; в Rust такие API только за `#[cfg(target_os = "macos")]`.
- Идентификатор приложения `com.kodevertex.terminal`, имя `KodeVertex Terminal`, репозиторий `KodeVertex-terminal`, лицензия MIT.
- Тема по умолчанию — `as` (Android Studio): bg `#1e1f22`, panel `#2b2d30`, text `#bcbec4`, accent `#3574f0`.
- Шрифты по умолчанию: текст `Inter`, код `JetBrains Mono`. Размер текста 16, кода 14, интервал 1.7. Шрифты встроены в приложение (`@fontsource`), с кириллицей.
- Конфиг: `~/.config/kodevertex-terminal/settings.toml`.
- Нельзя менять `~/.zshrc` пользователя. Интеграция подключается через собственный `ZDOTDIR`, который подгружает пользовательские файлы.
- Коммиты на русском или английском, **без упоминаний ИИ и строк Co-Authored-By** (требование владельца).
- Интерфейс на русском.

## Review Focus

1. **Кириллица и эмодзи в выводе** (`echo "Привет 👋"`, `ls` с русскими именами) отображаются без «�», даже если байты символа пришли в разных чтениях PTY. Тест: Task 4 `utf8_passthrough`.
2. **Пользовательский zsh остаётся прежним**: алиасы и PATH из `~/.zshrc` работают (например, `claude` может быть алиасом), включая случай, когда у пользователя уже задан свой `ZDOTDIR`. Тест: Task 4 `user_zshrc_is_sourced`.
3. **Shell завершился** (`exit`, `⌃D`): панель закрывается, последняя панель закрывает вкладку, последняя вкладка открывает новую. Процесс-сирота не остаётся. Тесты: Task 4 `exit_event_and_no_zombie`, Task 6 `closing_last_pane_closes_tab`.
4. **Изменение размера** (окно, разделение, смена шрифта) передаётся в PTY, иначе vim и htop рисуются криво. Тест: Task 4 `resize_reaches_child`.
5. **Битый или устаревший `settings.toml`** (неизвестная тема, размер 400, мусор вместо TOML): приложение стартует с исправленными значениями и не падает. Тесты: Task 2 `normalizeSettings` cases, Task 3 `load_corrupt_returns_null`.

---

## File Structure

```
package.json · vite.config.ts · vitest.config.ts · tsconfig.json · index.html
src/
  main.tsx                 точка входа, импорт шрифтов и global.css
  App.tsx                  раскладка окна: TabBar / PaneView / StatusBar / SettingsPanel
  global.css               базовые стили на CSS-переменных темы
  theme/themes.ts          5 тем: токены + ANSI-палитра
  theme/applyTheme.ts      запись токенов и шрифтов в CSS-переменные :root
  settings/settings.ts     тип Settings, DEFAULTS, normalizeSettings, шаги размеров
  settings/store.ts        zustand-стор настроек + загрузка/сохранение через Rust
  layout/paneTree.ts       чистые операции над деревом панелей
  layout/tabsStore.ts      zustand-стор вкладок и фокуса
  keys/keymap.ts           таблица горячих клавиш и matchKey
  terminal/ptyClient.ts    обёртки над командами pty_*
  terminal/osc.ts          parseOsc7
  terminal/TerminalPane.tsx xterm + PTY + тема/шрифт + resize
  ui/TabBar.tsx · ui/PaneView.tsx · ui/StatusBar.tsx · ui/SettingsPanel.tsx
  status/useGitInfo.ts     опрос git_info по cwd
src-tauri/
  Cargo.toml · tauri.conf.json · capabilities/default.json
  src/main.rs · src/lib.rs  регистрация команд и меню
  src/pty.rs               PtyManager
  src/shell.rs             подготовка ZDOTDIR-интеграции
  src/git.rs               git_info
  src/settings.rs          settings_load / settings_save
  src/fonts.rs             fonts_list
  shell/zsh/.zshenv .zprofile .zshrc .zlogin   файлы интеграции (ресурсы бандла)
README.md · LICENSE
```

---

### Task 1: Каркас приложения

**Files:**
- Create: весь каркас Vite + React + TS в корне, `src-tauri/` через `tauri init`, `src/main.tsx`, `src/App.tsx`, `src/global.css`, `vitest.config.ts`
- Test: `src/App.test.tsx`, `src-tauri/src/lib.rs` (модуль `tests`)

**Interfaces:**
- Produces: npm-скрипты `dev`, `build`, `tauri`, `test` (`vitest run`), `typecheck` (`tsc --noEmit`); Rust-функция `pub fn run()` в `lib.rs`; пустой `App` с тремя зонами `data-testid="tabbar" | "panes" | "statusbar"`.

- [ ] **Step 1: Поставить Rust.** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source ~/.cargo/env && rustc -V`. Ожидается `rustc 1.x`.
- [ ] **Step 2: Каркас фронтенда.** `npm create vite@latest kv-tmp -- --template react-ts`, перенести содержимое `kv-tmp/` в корень (не трогая `docs/`, `.gitignore`), удалить `kv-tmp`. Затем `npm i` и `npm i -D @tauri-apps/cli@^2 vitest jsdom @testing-library/react @testing-library/jest-dom` и `npm i @tauri-apps/api@^2 zustand @xterm/xterm @xterm/addon-fit @xterm/addon-webgl @xterm/addon-unicode11 @xterm/addon-web-links @fontsource/inter @fontsource/jetbrains-mono @fontsource/geist-sans @fontsource/geist-mono @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono @fontsource/pt-serif @fontsource/fira-code`.
- [ ] **Step 3: Каркас Tauri.** `npx tauri init --ci --app-name "KodeVertex Terminal" --window-title "KodeVertex Terminal" --frontend-dist ../dist --dev-url http://localhost:5173 --before-dev-command "npm run dev" --before-build-command "npm run build"`. В `tauri.conf.json`: `identifier: "com.kodevertex.terminal"`, окно 1280×800, `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `minWidth: 640`, `minHeight: 400`.
- [ ] **Step 4: Свое меню.** В `lib.rs` заменить стандартное меню приложения на минимальное: «KodeVertex Terminal» (About, «Настройки…» `⌘,` → emit `menu://settings`, Hide, Quit `⌘Q`) и «Правка» (Undo, Redo, Cut, Copy, Paste, Select All, все стандартные `PredefinedMenuItem`). В меню **не должно быть** пунктов с `⌘W`, `⌘T`, `⌘D`: эти клавиши обрабатывает фронтенд.
- [ ] **Step 5: Написать падающий тест** `src/App.test.tsx`: `render(<App/>)` → в документе есть элементы с `data-testid` `tabbar`, `panes`, `statusbar`. Проверить, что тест падает (`npm test`).
- [ ] **Step 6: Реализовать** минимальный `App` (три зоны в колонку: tabbar 38px, panes flex:1, statusbar 28px). `TabBar` получает `padding-left: 80px` под кнопки окна macOS и `data-tauri-drag-region`. В `main.tsx` подключить `@fontsource/inter/400.css`, `500.css`, `600.css`, `@fontsource/jetbrains-mono/400.css`, `500.css` и аналогичные веса остальных пакетов из Step 2.
- [ ] **Step 7: Проверить.** `npm test` → PASS; `cd src-tauri && cargo test` → PASS (пустой набор); `npm run tauri dev` → открывается тёмное окно с кнопками macOS поверх полосы вкладок, окно можно таскать за полосу.
- [ ] **Step 8: Commit.** `git add -A && git commit -m "Каркас приложения на Tauri 2 + React"`

---

### Task 2: Темы и модель настроек

**Files:**
- Create: `src/theme/themes.ts`, `src/theme/applyTheme.ts`, `src/settings/settings.ts`
- Test: `src/theme/themes.test.ts`, `src/settings/settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ThemeId = 'kv' | 'warm' | 'cold' | 'light' | 'as'
  interface ThemeTokens { bg; panel; panel2; rule; text; strong; muted; you; acc; accText; onAcc;
    info; add; del; warn; mag; sumBg; sumRule; kw; str; fn; num; com: string }
  interface Theme { id: ThemeId; name: string; dark: boolean; tokens: ThemeTokens }
  const THEMES: Record<ThemeId, Theme>
  function ansiFromTokens(t: ThemeTokens): import('@xterm/xterm').ITheme
  function applyTheme(theme: Theme, s: Settings, root?: HTMLElement): void
  interface Settings { theme: ThemeId; textFont: string; codeFont: string; textSize: number;
    codeSize: number; lineHeight: 1.5|1.6|1.7|1.8; ligatures: boolean }
  const DEFAULTS: Settings
  function normalizeSettings(raw: unknown): Settings
  function stepSize(current: number, delta: 1 | -1, kind: 'text'|'code'): number
  function terminalLineHeight(s: Settings): number
  ```

- [ ] **Step 1: Написать падающие тесты.**
  - `themes.test.ts`: все 5 тем имеют все токены, и каждый токен совпадает с `/^#[0-9a-f]{6}$/i`; `THEMES.as.tokens` = `{bg:'#1e1f22', panel:'#2b2d30', text:'#bcbec4', acc:'#3574f0'}` (частичное сравнение); `THEMES.light.dark === false`, остальные `true`; `ansiFromTokens(t)` → `red=t.del, green=t.add, yellow=t.warn, blue=t.info, magenta=t.mag, cyan=t.num, white=t.text, black=t.panel, brightBlack=t.muted, brightWhite=t.strong`, bright-red…bright-cyan равны обычным, `background=t.bg`, `foreground=t.text`, `cursor=t.accText`, `selectionBackground` = `t.acc` + альфа `'55'`.
  - `settings.test.ts`: `normalizeSettings(undefined)` и `normalizeSettings('мусор')` равны `DEFAULTS`; `DEFAULTS` = `{theme:'as', textFont:'Inter', codeFont:'JetBrains Mono', textSize:16, codeSize:14, lineHeight:1.7, ligatures:true}`; `{theme:'nope'}` → `'as'`; `{textSize:400}` → `28`, `{textSize:3}` → `11`; `{codeSize:400}` → `24`, `{codeSize:3}` → `10`; `{lineHeight:1.65}` → ближайшее допустимое `1.7`; `{textFont:''}` → `'Inter'`; неизвестные ключи отбрасываются; `stepSize(28,1,'text')` → `28`, `stepSize(16,-1,'text')` → `15`; `terminalLineHeight({...DEFAULTS, lineHeight:1.7})` ≈ `1.36` (формула `lineHeight*0.8`, округление до 0.01).
- [ ] **Step 2: Запустить** `npm test` → FAIL (модули не найдены).
- [ ] **Step 3: Реализовать `themes.ts`.** Токены всех тем копируются из CSS-переменных `.t-kv/.t-warm/.t-cold/.t-light/.t-as` в `docs/design-mockups/03-themes.html`. Недостающие там значения: `warn` — kv `#f2c46b`, warm `#d7a86e`, cold `#f2c46b`, light `#b5641a`, as `#e0b05a`; `mag` — kv `#c9a0ff`, warm `#c9a0c9`, cold `#b9a2f0`, light `#8a3ffc`, as `#c77dff`. Названия: «KodeVertex», «Тёплый графит», «Сине-серый», «Светлая бумага», «Android Studio».
- [ ] **Step 4: Реализовать `settings.ts`** (диапазоны: text 11–28, code 10–24) и `applyTheme.ts`: записывает каждый токен в `--<token>` на `root` (по умолчанию `document.documentElement`), а также `--font-text`, `--font-code`, `--size-text`, `--size-code`, `--lh-text`, `--liga` (`normal` / `none`) и `color-scheme` (`dark` / `light`).
- [ ] **Step 5: Запустить** `npm test` → PASS.
- [ ] **Step 6: Commit.** `git add src/theme src/settings && git commit -m "Темы и модель настроек"`

---

### Task 3: Хранение настроек и список шрифтов (Rust)

**Files:**
- Create: `src-tauri/src/settings.rs`, `src-tauri/src/fonts.rs`, `src/settings/store.ts`
- Modify: `src-tauri/src/lib.rs` (регистрация команд), `src-tauri/Cargo.toml` (`toml`, `serde_json`, `fontdb`, `dirs`)
- Test: модули `tests` в обоих `.rs`, `src/settings/store.test.ts`

**Interfaces:**
- Consumes: `Settings`, `normalizeSettings`, `DEFAULTS` (Task 2).
- Produces:
  - Rust: `fn load_from(path: &Path) -> Option<serde_json::Value>`, `fn save_to(path: &Path, v: &serde_json::Value) -> Result<(), String>`. Команды `#[tauri::command] settings_load() -> Option<Value>`, `settings_save(value: Value) -> Result<(), String>`, `fonts_list() -> Vec<FontFamily>`, где `#[derive(Serialize)] struct FontFamily { name: String, monospace: bool }`.
  - TS: `useSettings` (zustand) с полями `settings: Settings`, `loaded: boolean` и действиями `load(): Promise<void>`, `update(patch: Partial<Settings>): void` (нормализует, применяет `applyTheme`, сохраняет с задержкой 300 мс).

- [ ] **Step 1: Падающие тесты Rust.** `save_then_load_roundtrip` (temp-папка, JSON `{"theme":"kv","textSize":18}` ↔ TOML ↔ тот же JSON); `load_missing_returns_none`; `load_corrupt_returns_null` (в файле `=== not toml`, результат `None` без паники); `save_creates_parent_dirs`; `fonts_list_has_known_families` (список не пуст, отсортирован по имени без дублей, и для любой семьи с «Mono» в имени `monospace == true`, если fontdb так её помечает — проверять только непустоту и сортировку).
- [ ] **Step 2: Запустить** `cargo test` → FAIL.
- [ ] **Step 3: Реализовать.** Путь конфига: `dirs::home_dir()/.config/kodevertex-terminal/settings.toml`. Запись атомарная: сначала во временный файл рядом, затем `rename`. `fonts_list` собирает семьи через `fontdb::Database::load_system_fonts()`, `monospace` берётся из `face.monospaced`.
- [ ] **Step 4: Падающий тест TS** `store.test.ts` с замоканным `@tauri-apps/api/core` `invoke`: `load()` при `settings_load → {textSize: 99}` даёт `settings.textSize === 28` и `loaded === true`; `update({theme:'kv'})` дважды за 100 мс вызывает `settings_save` **один** раз после 300 мс (fake timers) с итоговым объектом.
- [ ] **Step 5: Реализовать `store.ts`, запустить** `npm test && cargo test` → PASS.
- [ ] **Step 6: Commit.** `"Хранение настроек в ~/.config и список системных шрифтов"`

---

### Task 4: PTY и интеграция zsh (Rust)

**Files:**
- Create: `src-tauri/src/pty.rs`, `src-tauri/src/shell.rs`, `src-tauri/shell/zsh/.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`
- Modify: `lib.rs`, `Cargo.toml` (`portable-pty`, `uuid`), `tauri.conf.json` (`bundle.resources: ["shell/**/*"]`)
- Test: модуль `tests` в `pty.rs`

**Interfaces:**
- Produces (Rust):
  ```rust
  pub struct SpawnOpts { pub cwd: Option<PathBuf>, pub cols: u16, pub rows: u16, pub zdotdir: PathBuf, pub env: Vec<(String,String)> }
  pub struct PtyManager { /* Mutex<HashMap<String, Session>> */ }
  impl PtyManager {
    pub fn spawn(&self, opts: SpawnOpts, on_data: impl Fn(Vec<u8>) + Send + 'static, on_exit: impl Fn(Option<u32>) + Send + 'static) -> Result<String, String>; // id
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String>;
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String>;
    pub fn kill(&self, id: &str) -> Result<(), String>;
  }
  ```
  Tauri-команды: `pty_spawn(cwd: Option<String>, cols: u16, rows: u16, on_data: Channel<InvokeResponseBody>, on_exit: Channel<Option<u32>>) -> Result<String,String>` (данные отправляются как `InvokeResponseBody::Raw`), `pty_write(id, data: String)`, `pty_resize(id, cols, rows)`, `pty_kill(id)`. Менеджер лежит в `app.manage(...)`.
- Shell: процесс — `$SHELL -l` (fallback `/bin/zsh`), env `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=KodeVertex`, `KV_ORIG_ZDOTDIR=<прежний ZDOTDIR или пусто>`, `ZDOTDIR=<путь к shell/zsh из ресурсов>`.

- [ ] **Step 1: Файлы интеграции zsh.** Каждый из `.zshenv/.zprofile/.zshrc/.zlogin` делает одно и то же: временно выставляет `ZDOTDIR="${KV_ORIG_ZDOTDIR:-$HOME}"`, подключает одноимённый пользовательский файл (`[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"`), затем возвращает наш `ZDOTDIR`. В `.zlogin` (последний файл для login-shell) окончательно восстанавливается `ZDOTDIR` пользователя (или он сбрасывается). Только `.zshrc` дополнительно добавляет `precmd`-хук, печатающий OSC 7: `printf '\e]7;file://%s%s\a' "$HOST" "${PWD// /%20}"` (в плане 2 сюда же добавится OSC 133).
- [ ] **Step 2: Падающие тесты** (запуск реального zsh в PTY, временный `HOME`, сбор вывода с таймаутом 5 с):
  - `utf8_passthrough`: записать `echo "Привет 👋"\n`, итоговые собранные байты как UTF-8 содержат `Привет 👋`;
  - `user_zshrc_is_sourced`: во временном `HOME/.zshrc` задать `alias kvtest='echo KV_OK'`, выполнить `kvtest\n` → в выводе `KV_OK`; то же при `KV_ORIG_ZDOTDIR=<tmp>/zd` с `.zshrc` внутри `zd`;
  - `emits_osc7`: в выводе есть `\x1b]7;file://`;
  - `resize_reaches_child`: `resize(id, 100, 30)`, затем `stty size\n` → в выводе `30 100`;
  - `exit_event_and_no_zombie`: записать `exit\n` → `on_exit` вызван в течение 3 с, после чего `write` возвращает `Err`; отдельно `kill(id)` у живой сессии → `on_exit` вызван, PID дочернего процесса больше не существует (`kill(pid, 0)` даёт ESRCH).
- [ ] **Step 3: Запустить** `cargo test pty` → FAIL.
- [ ] **Step 4: Реализовать `pty.rs` и `shell.rs`** (`fn integration_dir(app) -> PathBuf` берёт путь ресурса `shell/zsh`; в тестах путь передаётся напрямую через `SpawnOpts.zdotdir`). Чтение — отдельный поток на сессию, буфер 16 КБ, байты отдаются **как есть** без декодирования. Ожидание выхода — отдельный поток с `child.wait()`, после него сессия удаляется. `kill` убивает процесс и закрывает master.
- [ ] **Step 5: Запустить** `cargo test` → PASS.
- [ ] **Step 6: Commit.** `"PTY-сессии и интеграция zsh через ZDOTDIR"`

---

### Task 5: Панель терминала (xterm)

**Files:**
- Create: `src/terminal/ptyClient.ts`, `src/terminal/osc.ts`, `src/terminal/TerminalPane.tsx`
- Test: `src/terminal/osc.test.ts`, `src/terminal/ptyClient.test.ts`

**Interfaces:**
- Consumes: команды `pty_*` (Task 4), `THEMES`, `ansiFromTokens`, `terminalLineHeight`, `useSettings` (Tasks 2–3).
- Produces:
  ```ts
  function parseOsc7(data: string): string | null          // "file://host/Users/a%20b" -> "/Users/a b"
  interface PtyHandle { id: string; write(s: string): void; resize(c: number, r: number): void; kill(): void }
  function spawnPty(o: { cwd?: string; cols: number; rows: number;
    onData: (b: Uint8Array) => void; onExit: (code: number | null) => void }): Promise<PtyHandle>
  function TerminalPane(p: { paneId: string; focused: boolean; initialCwd?: string;
    onCwd: (cwd: string) => void; onExit: () => void; onFocus: () => void }): JSX.Element
  ```

- [ ] **Step 1: Падающие тесты.** `parseOsc7`: `"file://mac/Users/me/a%20b"` → `"/Users/me/a b"`; `"file:///tmp"` → `"/tmp"`; `"file://h/%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82"` → `"/Привет"`; `"http://x/y"` → `null`; `""` → `null`. `ptyClient`: с замоканными `invoke` и `Channel` проверить, что `spawnPty` передаёт `cols/rows/cwd`, `ArrayBuffer` из канала приходит в `onData` как `Uint8Array`, а `write('ls\n')` вызывает `pty_write` с `{id, data:'ls\n'}`.
- [ ] **Step 2: Запустить** → FAIL. **Step 3: Реализовать** `osc.ts` и `ptyClient.ts`. **Step 4: Запустить** → PASS.
- [ ] **Step 5: Реализовать `TerminalPane`.** xterm с `fontFamily: "'<codeFont>', 'JetBrains Mono', monospace"`, `fontSize: codeSize`, `lineHeight: terminalLineHeight(s)`, `theme: ansiFromTokens(...)`, `allowProposedApi: true`, `macOptionIsMeta: true`, `scrollback: 10000`. Аддоны: fit, unicode11 (`activeVersion='11'`), web-links (открытие через `@tauri-apps/plugin-opener` — добавить плагин), webgl (при `onContextLoss` — dispose и откат на DOM-рендер). `ResizeObserver` → `fit()` → `handle.resize(cols, rows)`, с дебаунсом 50 мс. Смена темы или шрифта из стора применяется к открытому xterm на лету, после чего вызывается `fit()`. OSC 7 перехватывается через `term.parser.registerOscHandler(7, ...)` → `onCwd`. `⌘C` при наличии выделения копирует его в буфер (`navigator.clipboard.writeText`), без выделения ничего не делает. `⌘V` вставляет через `term.paste`. При `focused` фокусируется xterm. Внутренний отступ панели 10px 12px, фон `var(--bg)`.
- [ ] **Step 6: Временно отрисовать одну `TerminalPane` в `App` и проверить вручную** (`npm run tauri dev`): работает zsh, `echo "Привет 👋"`, `vim` (открыть, изменить размер окна, `:q`), `htop` или `top`, цвета `ls -G`, вставка, выделение с `⌘C`; алиас `claude` из `~/.zshrc` доступен (`type claude`).
- [ ] **Step 7: Commit.** `"Панель терминала на xterm.js"`

---

### Task 6: Вкладки и разделение экрана

**Files:**
- Create: `src/layout/paneTree.ts`, `src/layout/tabsStore.ts`, `src/ui/PaneView.tsx`, `src/ui/TabBar.tsx`
- Modify: `src/App.tsx`
- Test: `src/layout/paneTree.test.ts`, `src/layout/tabsStore.test.ts`

**Interfaces:**
- Consumes: `TerminalPane` (Task 5).
- Produces:
  ```ts
  type Dir = 'left'|'right'|'up'|'down'
  type PaneNode = { kind: 'leaf'; id: string } | { kind: 'split'; axis: 'row'|'col'; ratio: number; a: PaneNode; b: PaneNode }
  interface Rect { x: number; y: number; w: number; h: number }
  function leaf(id: string): PaneNode
  function splitPane(t: PaneNode, target: string, axis: 'row'|'col', newId: string): PaneNode   // новая панель справа/снизу
  function closePane(t: PaneNode, target: string): PaneNode | null                              // null — дерево пусто
  function layoutRects(t: PaneNode, r?: Rect): Record<string, Rect>                             // по умолчанию 0..1
  function neighbor(t: PaneNode, from: string, dir: Dir): string | null
  function leaves(t: PaneNode): string[]
  interface Tab { id: string; tree: PaneNode; focused: string; cwd: Record<string, string> }
  // useTabs (zustand):
  //   tabs: Tab[]; active: string
  //   newTab(cwd?: string): void; closeTab(id: string): void; activate(id: string): void; activateIndex(i: number): void
  //   split(axis: 'row'|'col'): void          // в активной вкладке, у сфокусированной панели, наследует её cwd
  //   closeFocused(): void; paneExited(paneId: string): void
  //   focusDir(dir: Dir): void; focus(paneId: string): void; setCwd(paneId: string, cwd: string): void
  ```
- `row` = разделение вправо (`⌘D`), `col` = вниз (`⌘⇧D`).

- [ ] **Step 1: Падающие тесты `paneTree`.** `splitPane(leaf('a'),'a','row','b')` → split row `0.5` `a|b`; повторный split `b` по `col` → вложенный; `closePane` на `b` возвращает родителю `a` (сосед схлопывается), на единственном листе → `null`; `layoutRects` для `a|b` → `a {x:0,w:.5}`, `b {x:.5,w:.5}`; `neighbor` в раскладке `a | (b / c)`: `a→right` = `b` (наибольшее перекрытие по вертикали, при равенстве — верхний), `c→left` = `a`, `b→down` = `c`, `a→left` = `null`; `leaves` сохраняет порядок слева направо и сверху вниз.
- [ ] **Step 2: Падающие тесты `tabsStore`.** Изначально 1 вкладка с 1 панелью; `split('row')` → 2 листа, фокус на новом, cwd скопирован из прежней панели; `closeFocused()` на одной из двух панелей → фокус на соседа; `closing_last_pane_closes_tab`: при двух вкладках `paneExited` последней панели закрывает вкладку и активирует соседнюю; закрытие последней вкладки сразу создаёт новую (окно не пустеет); `activateIndex(8)` при 3 вкладках ничего не делает.
- [ ] **Step 3: Запустить** → FAIL. **Step 4: Реализовать** `paneTree.ts` и `tabsStore.ts` (id — `crypto.randomUUID()`). **Step 5: Запустить** → PASS.
- [ ] **Step 6: UI.** `PaneView` рекурсивно рисует дерево (flex, разделитель 1px `var(--rule)`, перетаскивание разделителя меняет `ratio` в пределах 0.15–0.85). Сфокусированная панель отмечена полосой 2px `var(--acc)` сверху (как в макете `04-main-window.html`). **Все** `TerminalPane` всех вкладок остаются смонтированными (неактивные вкладки скрыты через `display:none`), чтобы сессии не умирали. `TabBar`: вкладки в стиле макета (моноширинный шрифт 12px, активная на фоне `var(--bg)`), заголовок — имя проекта или последняя часть cwd сфокусированной панели, `×` при наведении, `+` в конце, клик выбирает вкладку, средний клик закрывает. `TerminalPane.onExit` → `paneExited`.
- [ ] **Step 7: Проверить вручную:** несколько вкладок и панелей, перетаскивание разделителя, `exit` в панели.
- [ ] **Step 8: Commit.** `"Вкладки и разделение экрана"`

---

### Task 7: Горячие клавиши

**Files:**
- Create: `src/keys/keymap.ts`
- Modify: `src/App.tsx` (глобальный обработчик), `src/terminal/TerminalPane.tsx` (`attachCustomKeyEventHandler`)
- Test: `src/keys/keymap.test.ts`

**Interfaces:**
- Consumes: `useTabs` (Task 6), `useSettings`, `stepSize`, `DEFAULTS` (Tasks 2–3).
- Produces:
  ```ts
  type Action = 'splitRight'|'splitDown'|'newTab'|'closePane'|'focusLeft'|'focusRight'|'focusUp'|'focusDown'
    |'tab1'|'tab2'|'tab3'|'tab4'|'tab5'|'tab6'|'tab7'|'tab8'|'tab9'|'prevTab'|'nextTab'
    |'fontBigger'|'fontSmaller'|'fontReset'|'openSettings'
  const KEYMAP: { action: Action; key: string; meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean }[]
  function matchKey(e: Pick<KeyboardEvent,'key'|'code'|'metaKey'|'shiftKey'|'altKey'|'ctrlKey'>): Action | null
  ```
- Раскладка: `⌘D` splitRight, `⌘⇧D` splitDown, `⌘T` newTab, `⌘W` closePane, `⌥⌘←→↑↓` focus*, `⌘1…⌘9` tabN (`⌘9` — последняя вкладка), `⌘⇧[` / `⌘⇧]` prev/next, `⌘=` и `⌘+` bigger, `⌘-` smaller, `⌘0` reset, `⌘,` openSettings.

- [ ] **Step 1: Падающие тесты.** `matchKey` должна работать **по `code`**, а не по `key`, чтобы клавиши срабатывали и в русской раскладке: `{code:'KeyD', key:'в', metaKey:true}` → `splitRight`; с `shiftKey` → `splitDown`; `{code:'ArrowLeft', metaKey:true, altKey:true}` → `focusLeft`; `{code:'Digit3', metaKey:true}` → `tab3`; `{code:'Equal', metaKey:true}` и `{code:'Equal', metaKey:true, shiftKey:true}` → `fontBigger`; `{code:'KeyD', ctrlKey:true}` → `null` (`⌃D` уходит в shell); `{code:'KeyC', metaKey:true}` → `null` (копирование обрабатывает `TerminalPane`).
- [ ] **Step 2: Запустить** → FAIL. **Step 3: Реализовать.** **Step 4: Запустить** → PASS.
- [ ] **Step 5: Подключить.** В `TerminalPane` через `attachCustomKeyEventHandler` вернуть `false`, если `matchKey(e) !== null`, чтобы xterm не съел клавишу. В `App` повесить `keydown` с `capture: true`: при совпадении `preventDefault()` и вызов действия стора. `fontBigger` и `fontSmaller` меняют **оба** размера через `stepSize`, `fontReset` возвращает оба к `DEFAULTS`. Событие `menu://settings` из Rust открывает настройки.
- [ ] **Step 6: Проверить вручную** все клавиши, в том числе при русской раскладке.
- [ ] **Step 7: Commit.** `"Горячие клавиши как в Warp"`

---

### Task 8: Статус-бар и git

**Files:**
- Create: `src-tauri/src/git.rs`, `src/status/useGitInfo.ts`, `src/ui/StatusBar.tsx`
- Modify: `lib.rs`, `App.tsx`, `TabBar.tsx` (заголовок вкладки = `projectName`)
- Test: модуль `tests` в `git.rs`, `src/ui/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useTabs` (cwd сфокусированной панели).
- Produces:
  - Rust: `#[derive(Serialize)] struct GitInfo { root: Option<String>, branch: Option<String>, dirty: bool }`, `fn git_info_at(cwd: &Path) -> GitInfo`, команда `git_info(cwd: String) -> GitInfo`.
  - TS: `interface GitInfo { root: string | null; branch: string | null; dirty: boolean }`, `function useGitInfo(cwd: string | undefined): GitInfo | null` (запрос при смене cwd и раз в 5 с, пока окно в фокусе); `function projectName(cwd: string, git: GitInfo | null): string` (имя папки `root`, иначе имя папки cwd, для `$HOME` — `~`); `function shortPath(cwd: string, home: string): string` (`/Users/me/x` → `~/x`); `StatusBar(p: { cwd?: string; git: GitInfo | null; now?: Date })`.

- [ ] **Step 1: Падающие тесты Rust** (временный репозиторий через `git init -b main` и коммит): `branch == Some("main")`, `dirty == false`; после создания файла `dirty == true`; в подпапке репозитория `root` указывает на корень; вне репозитория все поля пустые и нет паники; на несуществующем пути тоже нет паники; detached HEAD → `branch == Some("<короткий sha>")`.
- [ ] **Step 2: Падающие тесты TS.** `projectName('/Users/me/shop-app/src', {root:'/Users/me/shop-app', ...})` → `'shop-app'`; `shortPath('/Users/me/x','/Users/me')` → `'~/x'`. `StatusBar` с `git {branch:'feature/form', dirty:true}` показывает `проект shop-app`, `⎇ feature/form` и индикатор изменений, `~/shop-app/src` справа и время `14:32` при `now=14:32`; без git сегмент ветки не рендерится.
- [ ] **Step 3: Запустить** → FAIL. **Step 4: Реализовать** (`git_info_at` вызывает `git -C <cwd>` с `rev-parse --show-toplevel`, `branch --show-current`, `rev-parse --short HEAD`, `status --porcelain`, таймаут 2 с). **Step 5: Запустить** → PASS.
- [ ] **Step 6: Вёрстка по макету `04-main-window.html`** (класс `.sbar`, **не** `.status`): высота 28px, моноширинный шрифт 11.5px, сегменты с разделителями `var(--rule)`, подписи цветом `var(--muted)`, значения цветом `var(--strong)`, папка и время прижаты вправо. Сегменты Claude (режим, агент, модель, контекст) в этом плане **не** рисуются: их добавит план 3, оставить в компоненте место под слот `leading?: ReactNode`.
- [ ] **Step 7: Проверить вручную:** `cd` в репозиторий и обратно, создание файла (точка изменений появляется в течение 5 с), смена ветки.
- [ ] **Step 8: Commit.** `"Статус-бар: проект, ветка, папка, время"`

---

### Task 9: Окно настроек (темы и шрифты)

**Files:**
- Create: `src/ui/SettingsPanel.tsx`
- Modify: `App.tsx`
- Test: `src/ui/SettingsPanel.test.tsx`

**Interfaces:**
- Consumes: `useSettings`, `THEMES`, `stepSize`, команда `fonts_list` (Tasks 2–3).
- Produces: `SettingsPanel(p: { open: boolean; onClose: () => void })`.

- [ ] **Step 1: Падающие тесты** (замоканный `fonts_list` → `[{name:'Menlo',monospace:true},{name:'Helvetica',monospace:false}]`): видны 5 кнопок тем с названиями из `THEMES`, клик по «KodeVertex» вызывает `update({theme:'kv'})`; кнопка «+» у размера текста при 16 делает его 17, «−» у размера кода при 14 делает 13; выбор интервала `1.8` → `update({lineHeight:1.8})`; в списке шрифтов текста есть встроенные `Inter, Geist, IBM Plex Sans, PT Serif`, `system-ui` (подпись «Системный (SF Pro)») и `Helvetica`; в списке шрифтов кода есть `JetBrains Mono, Geist Mono, IBM Plex Mono, Fira Code, SF Mono` и `Menlo`, но **нет** `Helvetica`; `Esc` вызывает `onClose`.
- [ ] **Step 2: Запустить** → FAIL.
- [ ] **Step 3: Реализовать.** Модальная панель по центру, ширина 720px, фон `var(--panel)`. Разделы «Тема» (кнопки с тремя полосками-образцами цвета, как в макете `03-themes.html`) и «Шрифты» (два выпадающих списка, два счётчика − N +, четыре кнопки интервала, переключатель «Лигатуры в коде»). Справа или снизу **живой предпросмотр**: фрагмент текста на русском, абзац и блок кода, набранные текущими настройками. Встроенные шрифты в списке сверху, ниже разделитель и системные. Шрифт Geist в CSS называется `'Geist Sans'`, а в списке показывается как «Geist»: соответствие задать в одной таблице `FONT_CSS_NAME` в `SettingsPanel.tsx`. Изменения применяются сразу. Лигатуры в этом плане влияют только на `--liga` (карточки плана 3), в xterm они не поддерживаются, и это нужно указать подписью под переключателем.
- [ ] **Step 4: Запустить** → PASS.
- [ ] **Step 5: Проверить вручную:** `⌘,` открывает панель, смена темы перекрашивает открытые терминалы, смена шрифта кода и размера меняет xterm и пересчитывает колонки, после перезапуска приложения настройки сохраняются, в `~/.config/kodevertex-terminal/settings.toml` видны значения.
- [ ] **Step 6: Commit.** `"Окно настроек: темы и шрифты"`

---

### Task 10: Публичный репозиторий

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: `package.json` (`"license": "MIT"`, `"name": "kodevertex-terminal"`), `src-tauri/Cargo.toml` (`license = "MIT"`)

- [ ] **Step 1: `LICENSE`** — стандартный текст MIT, `Copyright (c) 2026 KodeVertex`.
- [ ] **Step 2: `README.md`** на русском с короткой английской аннотацией сверху: что это и зачем (удобное чтение, интеграция с Claude Code); что уже работает (этот план) и что в планах (блоки, Claude, релизы); сборка из исходников (`rustup`, `npm i`, `npm run tauri dev`, `npm run tauri build`); раздел «Первый запуск на macOS» о том, что приложение не подписано и открывается через правый клик → «Открыть» или `xattr -dr com.apple.quarantine "/Applications/KodeVertex Terminal.app"`; горячие клавиши (таблица из спеки §4.4, только реализованные); путь к конфигу.
- [ ] **Step 3: Проверить сборку.** `npm run typecheck && npm test && (cd src-tauri && cargo test) && npm run tauri build` → в `src-tauri/target/release/bundle/dmg/` есть `.dmg`. Установить его, запустить из `/Applications` (с обходом Gatekeeper из README) и убедиться, что открывается zsh.
- [ ] **Step 4: Commit.** `"README и лицензия MIT"`
- [ ] **Step 5: Создать публичный репозиторий и запушить.** `gh repo create KodeVertex-terminal --public --source . --remote origin --description "Терминал, удобный для чтения, с интеграцией Claude Code — KodeVertex" --push`. Проверка: `gh repo view KodeVertex-terminal --json visibility,url` → `"visibility":"PUBLIC"`.
