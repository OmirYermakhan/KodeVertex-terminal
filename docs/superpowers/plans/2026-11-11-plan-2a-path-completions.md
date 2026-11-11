# KodeVertex Terminal — План 2a: подсказки путей, как в Warp

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** После `cd ` (и других команд с путями) над курсором появляется список папок и файлов
с нечётким поиском, а справа превью «что внутри». Выбор подставляет путь прямо в строку zsh.

**Architecture:** zsh-интеграция на каждой перерисовке строки (ZLE-хук `line-pre-redraw`) отправляет
терминалу невидимую OSC-последовательность `ESC ] 6973 ; <CURSOR> ; <BUFFER> BEL`, а в конце строки
(`line-finish`) — `ESC ] 6973 ; - BEL`. TerminalPane разбирает её, вычисляет контекст дополнения
(чистые TS-функции), запрашивает у Rust список каталога и превью, рисует попап у курсора.
Пока попап открыт, `↑↓ Tab → ↵ esc` перехватываются и не уходят в shell. Подстановка выполняется
отправкой в PTY `DEL` × (длина набранного токена в символах) + экранированного пути.
Собственная строка ввода в стиле Warp не нужна: zsh, его история и `Tab` остаются нетронутыми.

**Tech Stack:** как в плане 1 (Tauri 2, Rust, React + TS, xterm.js, Vitest).

**Spec:** `docs/superpowers/specs/2026-11-11-kodevertex-terminal-design.md` §6.1a.

## Global Constraints

- Ничего не менять в пользовательских `~/.zshrc`; всё только в `src-tauri/shell/zsh/.zshrc` интеграции.
- Попап закрыт → ни одна клавиша не перехватывается (zsh `Tab` работает как раньше).
- Без интеграции (нет отчётов OSC 6973) попап просто никогда не появляется.
- Чтение каталогов только в Rust, async-команды, не на главном потоке.
- Интерфейс на русском. Коммиты без упоминаний ИИ и без Co-Authored-By.
- Сборка Rust: `source ~/.cargo/env && export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

## Review Focus

1. **Имена с пробелами, кириллицей, кавычками, `'`, `$`, `*`** подставляются корректно экранированными, и количество удаляемых `DEL` считается в символах, а не в байтах. Тесты: Task 3 `shellEscape`, `applyCompletion`.
2. **Огромные и закрытые каталоги** (`/usr/lib`, `~/Library`, без прав): ответ быстрый, не больше 2000 прочитанных записей, ошибка «нет доступа» показывается в превью, а не роняет попап. Тесты: Task 2.
3. **`~`, `..`, абсолютные и вложенные пути** (`cd ~/pro`, `cd ../`, `cd src/comp`) ищутся в правильном каталоге. Тест: Task 3 `completionContext`.
4. **Устаревшие ответы**: при быстром наборе показывается результат для последнего запроса. Тест: Task 4.
5. **Клавиши не утекают**: при открытом попапе `↵` не отправляет команду в shell дважды; при закрытом — ничего не перехватывается. Тест: Task 4.

---

### Task 1: zsh сообщает строку ввода (OSC 6973) и исправленный OSC 7

**Files:**
- Modify: `src-tauri/shell/zsh/.zshrc`
- Test: модуль `tests` в `src-tauri/src/pty.rs`

**Interfaces:**
- Produces: последовательности `\x1b]6973;<cursor>;<buffer>\x07` при каждой перерисовке строки ZLE и `\x1b]6973;-\x07` при завершении строки. `<cursor>` — `$CURSOR` (индекс в символах), `<buffer>` — `$BUFFER` с удалёнными `\e` и `\a`. OSC 7 кодирует путь полностью по RFC 3986 (всё, кроме `A-Za-z0-9-._~/`, как `%XX` по байтам UTF-8).

- [ ] **Step 1: Падающие тесты** (в стиле существующих PTY-тестов, временный HOME): `reports_zle_buffer`: записать `cd sr` без перевода строки → в выводе есть `\x1b]6973;5;cd sr\x07`; затем `\x15` (очистить строку) и `\n` → есть `\x1b]6973;-\x07`. `osc7_percent_encodes`: `mkdir -p '100%done/при вет' && cd '100%done/при вет'\n` → в выводе OSC 7 с путём, оканчивающимся на `/100%25done/%D0%BF%D1%80%D0%B8%20%D0%B2%D0%B5%D1%82`.
- [ ] **Step 2: Запустить** `cargo test reports_zle osc7_percent` → FAIL.
- [ ] **Step 3: Реализовать** в `.zshrc` после подключения пользовательского файла: `autoload -Uz add-zle-hook-widget`; функции `_kv_report_buffer` (`local b=${BUFFER//$'\e'/}; b=${b//$'\a'/}; print -rn -- $'\e]6973;'"$CURSOR;$b"$'\a'`) и `_kv_report_end` (`print -rn -- $'\e]6973;-\a'`); `add-zle-hook-widget line-pre-redraw _kv_report_buffer`, `add-zle-hook-widget line-finish _kv_report_end`. Без внешних процессов (никаких `base64`/`sed` на нажатие). OSC 7: кодирование на чистом zsh (цикл по байтам с `LC_ALL=C`, `printf '%%%02X'`), выполняется только в `precmd`.
- [ ] **Step 4: Запустить** `cargo test` (5 раз подряд) → PASS.
- [ ] **Step 5: Commit** `"zsh: отчёт о строке ввода и полное кодирование OSC 7"`

### Task 2: Чтение каталога и превью (Rust)

**Files:**
- Create: `src-tauri/src/fs_complete.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: модуль `tests` в `fs_complete.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Serialize)] #[serde(rename_all="camelCase")]
  pub struct FsEntry { pub name: String, pub is_dir: bool, pub is_symlink: bool }
  #[derive(Serialize)] #[serde(tag="kind", rename_all="camelCase")]
  pub enum FsPreview { Dir { entries: Vec<FsEntry>, total: usize }, Text { lines: Vec<String>, truncated: bool }, Binary { size: u64 }, Error { message: String } }
  pub fn list_dir(dir: &Path, dirs_only: bool, include_hidden: bool) -> Result<Vec<FsEntry>, String>
  pub fn preview(path: &Path) -> FsPreview
  ```
  Команды `#[tauri::command(async)] fs_list(dir: String, dirs_only: bool, include_hidden: bool) -> Result<Vec<FsEntry>, String>` и `#[tauri::command(async)] fs_preview(path: String) -> FsPreview`. Пути приходят уже абсолютными (раскрытие `~` делает TS).
- Правила: `list_dir` читает не больше 2000 записей, симлинк на каталог считается каталогом (`is_dir: true, is_symlink: true`), сортировка: каталоги сверху, затем по имени без учёта регистра. `preview` для каталога — первые 20 записей по тем же правилам + `total` (до 2000); для файла ≤ 1 МБ, валидного UTF-8 — первые 20 строк, каждая обрезана до 200 символов; иначе `Binary`; ошибка доступа → `Error { message: "Нет доступа" }`, несуществующий путь → `Error { message: "Не найдено" }`.

- [ ] **Step 1: Падающие тесты** (временный каталог): сортировка `B/`, `a/`, `c.txt`, `D.md` → `a, B, c.txt, D.md` (каталоги первыми); `dirs_only` оставляет только каталоги; скрытые (`.git`) появляются только при `include_hidden`; симлинк на каталог → `is_dir && is_symlink`; каталог с 2500 файлами → ровно 2000 записей; `preview` каталога → 20 записей и `total` 2000 при 2500 файлах; текстовый файл из 30 строк → 20 строк, `truncated: true`; строка 500 символов → 200; файл с нулевыми байтами → `Binary`; несуществующий путь → `Error "Не найдено"`; каталог с правами `000` → `Error "Нет доступа"` (и `list_dir` → `Err`), права вернуть после теста.
- [ ] **Step 2: Запустить** → FAIL. **Step 3: Реализовать.** **Step 4: Запустить** `cargo test` → PASS.
- [ ] **Step 5: Commit** `"Чтение каталога и превью для подсказок путей"`

### Task 3: Логика дополнения (чистый TS)

**Files:**
- Create: `src/completion/completion.ts`
- Test: `src/completion/completion.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ZleReport = { cursor: number; buffer: string } | 'end'
  function parseOsc6973(data: string): ZleReport | null
  interface CompletionContext { command: string; tokenStart: number; token: string;
    dirPart: string; namePart: string; dirsOnly: boolean; includeHidden: boolean }
  function completionContext(buffer: string, cursor: number): CompletionContext | null
  function resolveDir(dirPart: string, cwd: string, home: string): string   // абсолютный каталог для поиска
  function fuzzyScore(query: string, name: string): number | null          // null — не подходит
  function rankEntries<T extends { name: string; isDir: boolean }>(q: string, items: T[], limit?: number): T[]
  function shellEscape(name: string): string
  function applyCompletion(ctx: CompletionContext, entry: { name: string; isDir: boolean }): string // байты для PTY
  const PATH_COMMANDS: readonly string[]
  ```
- Правила:
  - `PATH_COMMANDS = ['cd','ls','cat','less','vim','nvim','nano','code','open','cp','mv','rm','mkdir','touch','tail','head','bat','source']`.
  - Контекст есть, только если курсор стоит в конце токена-аргумента (первое слово — команда из `PATH_COMMANDS`, курсор после хотя бы одного пробела после неё, символ справа от курсора — конец строки или пробел). Токен — от последнего неэкранированного пробела до курсора; учитываются `\ ` и одинарные/двойные кавычки (токен `'my fo` → незакрытая кавычка, искомое имя `my fo`). Флаги (`-la`) не дополняются.
  - `dirsOnly` = `command === 'cd'`; `includeHidden` = `namePart.startsWith('.')`.
  - `dirPart` — часть токена до последнего `/` включительно (без кавычек и экранирования), `namePart` — после.
  - `resolveDir`: `''` → cwd; `~` и `~/x/` → от home; абсолютный — как есть; относительный — от cwd; `..` нормализуется.
  - `fuzzyScore`: без учёта регистра; пустой запрос → 0; подстрока-префикс лучше подстроки, подстрока лучше подпоследовательности (`cmp` → `components`); не подпоследовательность → `null`.
  - `rankEntries`: по убыванию счёта, при равенстве каталоги выше, затем по имени; `limit` по умолчанию 50.
  - `shellEscape`: безопасные символы `A-Za-z0-9._-/+,@%=:` и любые не-ASCII буквы (кириллица) — как есть; иначе каждый спецсимвол экранируется `\` (пробел → `\ `, `'` → `\'`, `$` → `\$`).
  - `applyCompletion`: `'\x7f'.repeat([...ctx.token].length)` + `shellEscape(dirPart + name)` + (`/` для каталога); токен с ведущей `~` сохраняет `~` неэкранированной.
- [ ] **Step 1: Падающие тесты** на все правила выше, включая: `completionContext('cd sr', 5)` → `{command:'cd', token:'sr', dirPart:'', namePart:'sr', dirsOnly:true}`; `('cd ~/pro', 8)` → `dirPart '~/'`; `('cd src/comp', 11)` → `dirPart 'src/', namePart 'comp'`; `('cd my\\ fo', 9)` → `namePart 'my fo'`; `('git sr', 6)` → `null`; `('cd', 2)` → `null`; `('cd sr x', 5)` → `null` (курсор не в конце токена); `('ls -la', 6)` → `null`; `resolveDir('../', '/a/b', '/h')` → `'/a'`; `resolveDir('~/x/', '/c', '/h')` → `'/h/x'`; `fuzzyScore('cmp','components')` не `null`, `fuzzyScore('xyz','components')` → `null`, префикс > подстрока > подпоследовательность; `shellEscape("my folder's $x")` → `my\ folder\'s\ \$x`; `shellEscape('Документы')` → `Документы`; `applyCompletion(ctx('cd Док'), {name:'Документы',isDir:true})` → `'\x7f'.repeat(3) + 'Документы/'`; с `~/pro` и `projects` → `'\x7f'.repeat(5) + '~/projects/'`; `parseOsc6973('5;cd sr')` → `{cursor:5, buffer:'cd sr'}`, `('-')` → `'end'`, `('x;y')` → `null`, `('3;a;b')` → buffer `'a;b'`.
- [ ] **Step 2: Запустить** → FAIL. **Step 3: Реализовать.** **Step 4: Запустить** → PASS.
- [ ] **Step 5: Commit** `"Логика дополнения путей"`

### Task 4: Попап подсказок в терминале

**Files:**
- Create: `src/completion/CompletionPopup.tsx`, `src/completion/useCompletion.ts`
- Modify: `src/terminal/TerminalPane.tsx`, `src/global.css`
- Test: `src/completion/useCompletion.test.ts`, `src/completion/CompletionPopup.test.tsx`, `src/terminal/TerminalPane.test.tsx`

**Interfaces:**
- Consumes: Task 1 (OSC 6973), Task 2 (`fs_list`, `fs_preview`), Task 3 (всё из `completion.ts`), cwd панели (уже приходит через OSC 7 → `onCwd`), home (`@tauri-apps/api/path` `homeDir()`, как в `useGitInfo`).
- Produces:
  ```ts
  interface CompletionState { open: boolean; items: FsEntryTS[]; selected: number; ctx: CompletionContext | null; preview: FsPreviewTS | null; dir: string }
  function useCompletion(o: { cwd: () => string | undefined; home: string | null; write: (s: string) => void }): {
    state: CompletionState; onReport(r: ZleReport): void;
    onKey(e: KeyboardEvent): boolean /* true — клавиша съедена */; close(): void }
  function CompletionPopup(p: { state: CompletionState; x: number; y: number; onPick(i: number): void }): JSX.Element | null
  ```
- Поведение:
  - `onReport` с контекстом → (дебаунс 30 мс) `fs_list(resolveDir(...), dirsOnly, includeHidden)`; список кэшируется по каталогу на время, пока каталог не меняется; ранжирование `rankEntries(namePart, …)`; пустой результат → попап закрыт. Ответ, пришедший для устаревшего запроса, отбрасывается (счётчик). `'end'` или `null`-контекст → закрыть.
  - Превью подсвеченного элемента: `fs_preview(абсолютный путь)`, дебаунс 80 мс, тоже с защитой от устаревших ответов.
  - Клавиши при открытом попапе (обрабатываются в `attachCustomKeyEventHandler` до отправки в PTY, только `keydown`): `↓`/`↑` — выбор по кругу; `Tab` и `→` — `write(applyCompletion(...))`; `↵` — то же, и если команда `cd`, после подстановки ещё `'\r'` (без завершающего `/`); `esc` — закрыть, повторное появление только после следующего изменения строки. Остальные клавиши не съедаются. При закрытом попапе `onKey` всегда возвращает `false`.
  - Позиция: над строкой курсора xterm (`term.buffer.active.cursorX/cursorY`, размер ячейки = размер экрана xterm / cols, rows); если сверху не помещается — под строкой. Ширина списка 280px, превью 300px справа (если не помещается — превью скрыто).
  - Вид — по токенам темы: фон `var(--panel)`, рамка `var(--rule)`, выбранная строка фон `var(--acc)` с прозрачностью 25% и полоса 2px `var(--acc)` слева; каталоги со значком `▸` и цветом `var(--info)`, файлы `var(--text)`; совпавшие буквы — `var(--strong)` жирным; превью моноширинным шрифтом кода 12px; ошибка превью — `var(--del)`. Внизу попапа строка-подсказка `↑↓ выбрать · Tab подставить · ↵ перейти · esc` (для не-`cd` «↵ подставить»).
- [ ] **Step 1: Падающие тесты** `useCompletion` (fake timers, мок `invoke`): отчёт `cd sr` при cwd `/p` вызывает `fs_list('/p', true, false)` и открывает список, где `src` первым; быстрые отчёты `cd s` → `cd sr`: ответ для `cd s`, пришедший последним, не меняет список; `↓` меняет `selected`; `Tab` вызывает `write` с `applyCompletion`; `↵` для `cd` пишет подстановку + `'\r'`; `esc` закрывает и `onKey` дальше возвращает `false` до следующего отчёта; отчёт `'end'` закрывает; при закрытом попапе `onKey(↵)` → `false` и `write` не вызывается; ошибка `fs_list` → попап закрыт без исключений. `CompletionPopup`: рендерит элементы, выделяет `selected`, показывает превью каталога (имена) и текст ошибки. `TerminalPane`: OSC 6973 через замоканный `registerOscHandler` доходит до `onReport`; при открытом попапе кастомный обработчик клавиш возвращает `false` для `↵` (не уходит в xterm).
- [ ] **Step 2: Запустить** → FAIL. **Step 3: Реализовать** и подключить в `TerminalPane` (`registerOscHandler(6973, …)`, состояние, `CompletionPopup` абсолютно поверх xterm внутри контейнера панели). **Step 4: Запустить** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Проверить вручную** (человек): `cd ` → папки; `cd Док` → «Документы»; `cd ~/pro` → `projects`; `↵` переходит; `cat READ` → файлы и превью текста; `esc`; обычный `Tab` zsh при закрытом попапе.
- [ ] **Step 6: Commit** `"Попап подсказок путей с превью"`
