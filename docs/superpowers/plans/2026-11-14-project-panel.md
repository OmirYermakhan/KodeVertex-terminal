# Панель проекта — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Слева — полоса инструментов и окно «Проект / Изменения / Git» как в Android Studio, справа — просмотр файла и изменений (только чтение), точь-в-точь по макету 07.

**Architecture:** Rust-команды в новом `src-tauri/src/project.rs` (дерево, чтение файла в границах корня, git status/log/show/diff с защитой из `git.rs`). Фронт: `src/project/` — api, разбор unified diff, zustand-стор, компоненты; встраивается в `App.tsx` слева и справа от `.panes`, кнопка — в `TabBar`.

**Tech Stack:** Tauri 2 / Rust (cargo test, tempfile), React 19 + TS, zustand, vitest + jsdom, существующие `highlightLines` и `diff.ts`.

**Spec:** `docs/superpowers/specs/2026-11-14-project-panel-design.md` · **Макет:** `docs/design-mockups/07-project-panel.html`

## Global Constraints
- Вёрстка, отступы, размеры, цвета — как в макете 07 (классы и значения CSS брать оттуда; цвета — через токены темы: добавить `vcsMod #6c9fef, vcsAdd #73bd79, vcsNew #d1675a, vcsDel = muted` в ThemeTokens всех тем, для светлых тем — подобрать читаемые оттенки).
- Только просмотр: ни одной команды, меняющей репозиторий или файлы.
- Все пути от фронта — относительные к корню; Rust канонизирует и отказывает, если путь вне корня (`..`, симлинк наружу).
- git: только через общий запуск из `git.rs` (GIT_ENV, GIT_SAFE_CONFIG, stdin null, таймаут 5 с для этих команд); ревизии — только `^[0-9a-f]{4,40}$`; пути — после `--`.
- Сборка cargo/tauri: префикс `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- Текст интерфейса и комментарии — по-русски. Коммиты без упоминаний ИИ и без Co-Authored-By.

## Review Focus
- Репозиторий без коммитов / не git-папка → дерево работает, «Изменения» и «Git» показывают «Не git-репозиторий» / «Коммитов ещё нет», без ошибок (тесты в Task 1 и 2).
- Имена с пробелами, кириллицей, переименования (`R old -> new`) в status/numstat → корректные пути (`-z`-разбор; тест в Task 2).
- Огромная папка (node_modules 50k) → первые 2000 записей + «ещё N», UI не зависает (тест в Task 1).
- Файл удалён/переименован, пока открыт во вкладке → вкладка показывает «Файл удалён», не падает (тест в Task 6).
- Сужение ленты при открытом файле → xterm пересчитывает cols (существующий ResizeObserver) и не ломает живой блок (проверка глазами в Task 9).

---

### Task 1: Rust — дерево и чтение файла

**Files:** Create `src-tauri/src/project.rs`; Modify `src-tauri/src/lib.rs` (команды), `src-tauri/src/git.rs` (сделать `run_cmd`, `GIT_ENV`, `GIT_SAFE_CONFIG`, `git_args` доступными `pub(crate)`).

**Interfaces (Produces):**
- `#[tauri::command] project_root(cwd: String) -> String` — `git rev-parse --show-toplevel` или сам cwd.
- `#[tauri::command] project_list(root: String, rel: String) -> Result<DirList, String>`; `DirList { entries: Vec<Entry>, more: u32 }`, `Entry { name: String, is_dir: bool }` (serde camelCase); папки первыми, затем файлы, без учёта регистра; `.git` скрыт; максимум 2000 записей, остаток — `more`.
- `#[tauri::command] project_read(root: String, rel: String) -> FileText`; `FileText` — enum с `#[serde(tag="kind")]`: `Text { lines: Vec<String>, truncated: bool, size: u64 }` (до 2 МБ / 20 000 строк), `Binary { size }`, `Missing`, `Error { message }`.
- `fn inside_root(root: &Path, rel: &str) -> Option<PathBuf>` — канонизация, отказ при выходе за корень.

- [ ] Тесты (`#[cfg(test)]`, tempfile): сортировка и скрытие `.git`; 2100 файлов → 2000 + more=100; `rel="../x"` и симлинк наружу → Err; чтение: текст, бинарный (NUL), отсутствующий → Missing, 25 000 строк → truncated, 20 000 строк; не-git cwd → project_root = cwd.
- [ ] `cargo test project` → FAIL; реализация; → PASS; весь `cargo test` → PASS.
- [ ] Commit «Проект: дерево файлов и чтение файла в границах корня».

### Task 2: Rust — git: состояние, лог, файлы коммита, изменения файла

**Files:** Modify `src-tauri/src/project.rs`, `src-tauri/src/lib.rs`.

**Interfaces (Produces):**
- `Change { path: String, old_path: Option<String>, status: String /* "M"|"A"|"D"|"R"|"?" */, add: Option<u32>, del: Option<u32> }`.
- `git_status(root) -> Result<Vec<Change>, String>` — `status --porcelain=v1 -z --untracked-files=all` + `diff HEAD --numstat -z` (в репо без коммитов — `diff --cached --numstat`); не git → `Err("not-git")`.
- `git_log(root, skip: u32, limit: u32) -> Result<Vec<Commit>, String>`; `Commit { hash, short, subject, author, time: i64 /* unix */, refs: Vec<String>, head: bool }` — `log --format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%D%x1e`; без коммитов → `Ok(vec![])`.
- `git_commit_files(root, hash) -> Result<Vec<Change>, String>` — `show --format= --name-status -z -M` + `--numstat -z`; первый коммит — тоже работает (root commit).
- `git_diff(root, rel, rev: Option<String>) -> Result<String, String>` — unified `-U3 --no-color --no-ext-diff`; `rev=None`: `diff HEAD -- rel` (неотслеживаемый — синтезировать «всё добавлено» из содержимого, до 2 МБ); `rev=Some(h)`: `show --format= h -- rel`.

- [ ] Тесты на temp-репо (git init, user.name/email через `-c`): M/A/D/R/?, имена с пробелом и кириллицей, numstat бинарного (`-`) → add/del None; лог из 3 коммитов, refs и head; файлы первого коммита; diff изменённого, неотслеживаемого, файла коммита; невалидный hash `"--all"` → Err; не git → Err("not-git").
- [ ] FAIL → реализация → PASS (`cargo test`).
- [ ] Commit «Проект: git — состояние, лог, файлы коммита, изменения файла».

### Task 3: Фронт — данные: api, разбор diff, стор

**Files:** Create `src/project/api.ts`, `src/project/unified.ts`, `src/project/store.ts` (+ тесты `*.test.ts`).

**Interfaces:**
- Consumes: команды Task 1–2 (имена camelCase-аргументов: `root`, `rel`, `rev`, `skip`, `limit`, `hash`, `cwd`).
- Produces:
  - `parseUnified(text: string): { hunks: Hunk[]; add: number; del: number }` (Hunk из `src/claude/diff.ts`).
  - `type Tool = 'project' | 'changes' | 'git'`; `type ViewerTab = { kind: 'file'; rel: string } | { kind: 'diff'; rel: string; rev: string | null }`.
  - `useProject` (zustand): `{ tool: Tool | null; width: number; root: string | null; changes: Change[] | null; notGit: boolean; tabs: ViewerTab[]; active: number; focusLine: number | null; claudeTouched: Set<string> }` и действия `toggle(tool)`, `close()`, `setWidth(px)` (200–600, localStorage `kv.projectWidth`), `setRoot(cwd)`, `refresh()` (троттлинг 500 мс), `openFile(rel)`, `openDiff(rel, rev)`, `closeTab(i)`, `markClaudeTouched(absPath)`.
  - `statusOf(changes, rel): 'mod'|'add'|'new'|'del'|null`, `dirHasChanges(changes, relDir): boolean`.
- [ ] Тесты: parseUnified (несколько ханков, `\ No newline`, новый файл `@@ -0,0 +1,3 @@`); toggle/close; ширина ограничивается и сохраняется; openFile не дублирует вкладку; refresh троттлится (fake timers, invoke замокан); statusOf/dirHasChanges.
- [ ] FAIL → реализация → PASS (`npx vitest run src/project`, затем весь + tsc).
- [ ] Commit «Проект: данные панели — запросы, разбор изменений, состояние».

### Task 4: Каркас окна: кнопка проекта, полоса, окно инструмента, клавиши

**Files:** Create `src/project/ProjectButton.tsx`, `src/project/Stripe.tsx`, `src/project/ToolWindow.tsx`, `src/project/Viewer.tsx` (пустая оболочка вкладок); Modify `src/App.tsx`, `src/ui/TabBar.tsx`, `src/keys/keymap.ts` (+`toolProject` ⌥⌘1, `toolChanges` ⌥⌘0, `toolGit` ⌥⌘9, во всех раскладках как остальные), `src/keys/actions.ts`, `src/global.css`, `src/theme/themes.ts` (токены vcs*).

**Interfaces:** Consumes `useProject`. Produces: `<ToolWindow>` рендерит по `tool` компонент-заглушку `ProjectTree` / `ChangesView` / `GitLog` (реальные — Task 5, 7); `<Viewer>` справа от `.panes`, когда `tabs.length > 0`; при активной вкладке `diff` `.panes` скрыт так же, как неактивная вкладка (смонтирован).
- [ ] Тесты: кнопка показывает имя/ветку из `git` (как StatusBar), клик → tool='project'; ⌥⌘1/⌥⌘0/⌥⌘9 переключают, повтор — скрывает; esc в панели — скрывает; ресайз за край меняет ширину; ⌘W при фокусе в просмотре закрывает вкладку файла, иначе — как раньше (закрытие панели).
- [ ] Реализация по макету (bar `.proj`, `.stripe`, `.sb`, `.tw`, `.twh`) → PASS.
- [ ] Commit «Проект: кнопка слева вверху, полоса инструментов, окно и клавиши ⌥⌘1 ⌥⌘0 ⌥⌘9».

### Task 5: Дерево проекта

**Files:** Create `src/project/ProjectTree.tsx`, `src/project/fileIcon.tsx` (+ тесты).

**Interfaces:** Consumes `project_list`, `useProject` (`changes`, `statusOf`, `dirHasChanges`, `openFile`). Produces `fileIcon(name): ReactNode` (K для .kt/.kts? — `.kts` = G для gradle, X для .xml, M для .md, ≡ прочее, + ts/tsx/rs/json/py — цвет по языку, буква — первая буква расширения), используется в Task 6–7.
- [ ] Тесты: ленивое раскрытие (list вызывается при раскрытии); цвета статусов (классы `mod/add/new/del`), папка с изменениями внутри — `dirm`; удалённый файл появляется в своей папке зачёркнутым; ↑↓→←↵ навигация; набор букв — выбор первого совпадения; «ещё N»; ↵/клик → `openFile`.
- [ ] Реализация по макету окна 1 (отступ уровня 16px, стрелки ▾/▸, `.n.sel`) → PASS.
- [ ] Commit «Проект: дерево файлов с цветами git».

### Task 6: Просмотр файла

**Files:** Create `src/project/FileView.tsx` (+ тест); Modify `src/project/Viewer.tsx`, `src/ui/StatusBar.tsx`.

**Interfaces:** Consumes `project_read`, `git_diff(rel, null)` + `parseUnified` (полоски на полях: строки нового файла в ханках — добавленные `a`, изменённые `m` — если в ханке есть и удаление), `highlightLines`, `openPath(abs,'editor',line)` из `src/attach/preview/api`.
- [ ] Тесты: номера строк и подсветка; полоски `vc a`/`vc m` на правильных строках; truncated → строка «Файл большой — показаны первые N строк»; Binary/Missing → свои сообщения; клик по строке → текущая строка, в строке состояния «Имя · строка:столбец · Язык · UTF-8»; вкладки (значок, цвет статуса, ✕, активная).
- [ ] Реализация по макету (`.etabs`, `.et`, `.ebar`, `.ro`, `.code`, `.ln`) → PASS.
- [ ] Commit «Проект: просмотр файла с номерами строк и метками изменений».

### Task 7: «Изменения», «Git» и просмотр изменений

**Files:** Create `src/project/ChangesView.tsx`, `src/project/GitLog.tsx`, `src/project/DiffTab.tsx` (+ тесты); Modify `src/project/ToolWindow.tsx`, `src/project/Viewer.tsx`.

**Interfaces:** Consumes `git_status`, `git_log`, `git_commit_files`, `git_diff`, `parseUnified`, `diffParts`/строки как в `DiffView` (переиспользовать отрисовку строк; заголовок — свой по макету `.dvh`).
- [ ] Тесты: группы и счётчики; подвал «+A −D · N файлов» и «Claude менял K из N»; клик → `openDiff(rel,null)`; лог: даты «сегодня HH:MM»/«вчера HH:MM»/«12 нояб.», метки HEAD/веток, раскрытие файлов коммита, догрузка по 100; клик по файлу коммита → `openDiff(rel, hash)`, плашка «новый файл в a41c9e2», «Копировать хэш»; not-git и пустой лог — сообщения.
- [ ] Реализация по макету окон 2–3 → PASS.
- [ ] Commit «Проект: изменения и лог коммитов с файлами и просмотром изменений».

### Task 8: Корень, обновление, «Claude менял»

**Files:** Modify `src/App.tsx` (корень из cwd панели в фокусе → `setRoot`), `src/claude/sessionStore.ts` или место, где применяются события Claude (после `tool_result` Edit/Write/MultiEdit/Bash → `refresh()` и `markClaudeTouched(file_path)`), место окончания shell-блока (`refresh()`), `window` focus → `refresh()`; открытый файл перечитывается при `refresh`.
- [ ] Тесты: смена вкладки меняет root; действие Claude Edit → refresh вызван и файл помечен; конец блока → refresh; троттлинг.
- [ ] Commit «Проект: панель обновляется после правок Claude и команд».

### Task 9: Сборка и сверка с макетом
- [ ] `DEVELOPER_DIR=… npm run tauri build`, заменить `/Applications/KodeVertex Terminal.app`.
- [ ] Скриншоты трёх состояний в теме AS рядом со скриншотами макета; расхождения — исправить. Проверить светлую тему, xterm при сужении, большой репо (этот проект: node_modules, src-tauri/target).
