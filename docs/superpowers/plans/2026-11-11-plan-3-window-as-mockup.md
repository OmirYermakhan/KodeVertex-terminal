# KodeVertex Terminal — План 3: окно точь-в-точь как в макете

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Окно выглядит и работает как `docs/design-mockups/04-main-window.html`: лента блоков (команды shell и сообщения Claude карточками по варианту B из `02-message-layers.html`), нижняя панель агентов, строка ввода внизу (`↵` — shell, `⌘↵` — Claude), полный статус-бар, уведомления (§4.7 спеки).

**Architecture:**
- **Shell-блоки.** zsh-интеграция (в режиме блоков) печатает OSC 133 (`A` начало приглашения, `C;<cmd в base64>` старт команды, `D;<exit>` конец) и скрывает собственное приглашение. В каждой панели один «живой» xterm: показывает вывод текущей команды. На `C` xterm очищается, на `D` его содержимое сериализуется в HTML (`@xterm/addon-serialize`) и замораживается в блок ленты. Полноэкранные программы (alt screen) получают xterm на всю панель.
- **Строка ввода** — своя (как в Warp). `↵` пишет команду + `\r` в PTY; `⌘↵` отправляет текст в Claude-сессию вкладки. Подсказки путей (план 2a) работают в строке ввода через ту же логику `completion.ts`.
- **Claude.** Rust запускает `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions` с pipe (не PTY) в cwd панели, одна долгоживущая сессия на панель. Строки stdout идут в TS через Channel. Чистый редьюсер превращает события в элементы ленты, агентов и метаданные (модель, контекст, стоимость).
- Режим ZLE-подсказок плана 2a остаётся для полноэкранного/классического режима; в режиме блоков zsh не видит ввода по буквам.

**Tech Stack:** как раньше + `@xterm/addon-serialize`, `react-markdown`, `remark-gfm`, `rehype-highlight` (или `shiki`), `@tauri-apps/plugin-notification`.

**Spec:** `docs/superpowers/specs/2026-11-11-kodevertex-terminal-design.md` §4.1–4.3, §4.7, §5, §6, §6.2–6.4, §7. **Визуальный эталон:** `docs/design-mockups/04-main-window.html` (окно), `02-message-layers.html` вариант B (карточки), `01-reading-modes.html` вариант B (режим чтения). Реальный формат событий Claude Code: `src/claude/fixtures/bash-ls.jsonl`.

## Global Constraints

- **Внешний вид — точь-в-точь по макету `04-main-window.html`:** размеры, отступы, радиусы, шрифты и цвета берутся из его CSS (переведённые на CSS-переменные темы: `--bg --panel --panel2 --rule --text --strong --muted --you --acc --accText --info --add --del --warn`). Тема по умолчанию Android Studio. Перед сдачей каждой UI-задачи — скриншот приложения в браузере (Vite + моки Tauri) рядом со скриншотом макета, расхождения устранены.
- Текст карточек — шрифт текста (`--font-text`, по умолчанию Inter), код/команды — шрифт кода. Ширина текста карточек ≤ 76ch, межстрочный интервал из настроек.
- Нельзя ломать обычный терминал: vim, htop, less, ssh, `sudo` с паролем, `read`, `⌃C`, `⌃D`, вставка, цвета.
- Интерфейс на русском. Коммиты без упоминаний ИИ и без Co-Authored-By.
- Процесс `claude` и shell не наследуют служебные переменные `CLAUDE_CODE_*`, `CLAUDECODE` из окружения приложения.
- Сборка Rust: `source ~/.cargo/env && export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

## Review Focus

1. **Интерактивные команды** (`sudo -v`, `read x`, `python3` REPL, `ssh`): пока команда идёт, ввод с клавиатуры попадает в живой xterm и в PTY; `⌃C` прерывает. Тест: Task 5.
2. **Полноэкранные программы** (`vim`, `htop`, `less`): занимают всю панель, после выхода лента возвращается. Тест: Task 5.
3. **Длинный вывод** (`cat` большого файла, `yes | head -n 100000`): блок не тормозит ленту — замороженный блок длиннее 2000 строк сворачивается с кнопкой «Показать всё»; приложение не зависает. Тест: Task 3 и Task 5.
4. **Claude-события в неожиданном порядке**: субагент отвечает до того, как пришёл его `tool_use`; нет `result`; процесс `claude` упал или его нет в PATH — понятная ошибка карточкой, а не белый экран. Тест: Task 4 и Task 2.
5. **Русский текст и markdown** в ответах (таблицы, код, списки, ссылки) отображаются как в режиме чтения; HTML в ответе не исполняется. Тест: Task 6.

---

### Task 1: zsh — OSC 133 и режим блоков

**Files:** Modify `src-tauri/shell/zsh/.zshrc`, `src-tauri/src/shell.rs`; Test: `src-tauri/src/pty.rs` (tests).

**Interfaces — Produces:** при `KV_BLOCKS=1` в окружении интеграция: `precmd` печатает `\e]133;D;<код выхода>\a` (только если перед этим была команда) и затем `\e]133;A\a`; `preexec` печатает `\e]133;C;<base64 от $1>\a` (base64 через `print -rn -- $1 | base64` допустим только тут — раз на команду); `PROMPT=''`, `RPROMPT=''`, `PROMPT_EOL_MARK=''` выставляются **после** пользовательского `.zshrc` и повторно в `precmd` (если тема их меняет). Без `KV_BLOCKS` поведение прежнее. `session_env` добавляет `KV_BLOCKS=1` и удаляет из окружения сессии `CLAUDECODE` и все `CLAUDE_CODE_*`.

- [ ] Падающие PTY-тесты: `blocks_mode_emits_osc133` — `echo hi\n` → в выводе по порядку `133;C;ZWNobyBoaQ==` (base64 «echo hi»), `hi`, `133;D;0`, `133;A`; `false\n` → `133;D;1`; `blocks_mode_hides_prompt` — после `133;A` до конца отчёта нет символов `%`/`$`/`❯` приглашения (пустой PROMPT); `session_env_scrubs_claude_vars` — при `CLAUDE_CODE_CHILD_SESSION=1` в окружении процесса спавн zsh не видит его (`echo ${CLAUDE_CODE_CHILD_SESSION:-none}` → `none`).
- [ ] Реализовать, `cargo test` ×3 → PASS. Commit `"zsh: блоки OSC 133 и скрытое приглашение"`.

### Task 2: Rust — сессии Claude Code

**Files:** Create `src-tauri/src/claude.rs`; Modify `lib.rs`; Test: `claude.rs` (tests) + `src-tauri/tests/fake-claude.sh`.

**Interfaces — Produces:**
```rust
pub struct ClaudeManager { /* Mutex<HashMap<String, Session>> */ }
impl ClaudeManager {
  pub fn start(&self, program: &Path, cwd: &Path, resume: Option<String>, on_line: impl Fn(String)+Send+'static, on_exit: impl Fn(Option<i32>, String /*stderr tail*/)+Send+'static) -> Result<String, String>;
  pub fn send(&self, id: &str, text: &str) -> Result<(), String>;   // пишет {"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}\n
  pub fn interrupt(&self, id: &str) -> Result<(), String>;          // SIGINT процессу
  pub fn stop(&self, id: &str) -> Result<(), String>;
}
pub fn resolve_claude() -> Result<PathBuf, String>; // `$SHELL -lic 'whence -p claude'`, кэш; ошибка «Claude Code не найден. Установите: npm i -g @anthropic-ai/claude-code»
```
Команды (все `async`): `claude_start(cwd, resume: Option<String>, on_line: Channel<String>, on_exit: Channel<ClaudeExit>) -> String`, `claude_send(id, text)`, `claude_interrupt(id)`, `claude_stop(id)`. Аргументы процесса: `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions` (+ `--resume <id>` если задан). Окружение без `CLAUDECODE` и `CLAUDE_CODE_*`. stdout читается построчно, каждая непустая строка — в `on_line`; последние 4 КБ stderr — в `on_exit`.
- [ ] Падающие тесты с `fake-claude.sh` (печатает строки из `src/claude/fixtures/bash-ls.jsonl`, затем эхо каждой строки stdin как `{"type":"echo",…}`): все 38 строк приходят по порядку; `send` → эхо содержит текст с кириллицей и кавычками в корректном JSON; `stop` → `on_exit` вызван, процесса нет; несуществующая программа → `Err`; падение скрипта с текстом в stderr → `on_exit(Some(code), "…текст…")`; окружение скрипта не содержит `CLAUDECODE`.
- [ ] Реализовать, `cargo test` → PASS. Commit `"Сессии Claude Code через stream-json"`.

### Task 3: TS — модель ленты и shell-блоков (чистая логика)

**Files:** Create `src/feed/feed.ts`; Test `src/feed/feed.test.ts`.

**Interfaces — Produces:**
```ts
type ShellBlock = { kind: 'shell'; id: string; command: string; cwd: string; startedAt: number; durationMs: number | null; exitCode: number | null; html: string | null; lines: number; running: boolean }
type ClaudeItem = { kind: 'claude'; id: string; item: FeedClaudeItem }   // из Task 4
type FeedItem = ShellBlock | ClaudeItem
type ShellEvent = { t: 'prompt' } | { t: 'start'; command: string; cwd: string; at: number } | { t: 'end'; exitCode: number; at: number; html: string; lines: number }
function parseOsc133(data: string): ShellEvent-like | null   // 'A' | 'C;<b64>' | 'D;<code>' → без времени/HTML
function applyShell(items: FeedItem[], ev: ShellEvent): FeedItem[]
function formatDuration(ms: number): string    // 80 → '0.1 с', 1500 → '1.5 с', 65000 → '1м 05с'
const COLLAPSE_LINES = 2000
```
- [ ] Тесты: `parseOsc133('C;ZWNobyBoaQ==')` → команда `echo hi` (UTF-8 base64 с кириллицей тоже); `'D;127'`; `'A'`; мусор → `null`; `start` добавляет `running` блок, `end` закрывает последний running с длительностью и HTML; `end` без `start` игнорируется; `formatDuration` по примерам. Commit `"Модель ленты и shell-блоков"`.

### Task 4: TS — редьюсер событий Claude (чистая логика)

**Files:** Create `src/claude/reducer.ts`, `src/claude/labels.ts`; Test `src/claude/reducer.test.ts` (использует `fixtures/bash-ls.jsonl` + синтетические события субагента).

**Interfaces — Produces:**
```ts
type FeedClaudeItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; agentId: string; text: string; streaming: boolean }
  | { type: 'action'; agentId: string; toolUseId: string; tool: string; title: string; detail: string; diff?: { before: string; after: string; path: string }; status: 'running'|'done'|'error'; result?: string }
  | { type: 'summary'; text: string; durationMs: number; costUsd: number; isError: boolean }
  | { type: 'error'; text: string }
interface Agent { id: string /* 'main' | toolUseId */; parentId: string | null; name: string; model: string | null; status: 'running'|'waiting'|'done'|'error'; now: string; history: string[]; step: { n: number; m: number } | null; startedAt: number; endedAt: number | null; tokens: number }
interface ClaudeState { sessionId: string | null; model: string | null; contextUsed: number; contextMax: number; costUsd: number; busy: boolean; items: FeedClaudeItem[]; agents: Agent[]; currentAgentId: string | null }
function initialClaude(): ClaudeState
function reduceClaude(s: ClaudeState, line: string | object, now: number): ClaudeState
function userSent(s: ClaudeState, text: string, now: number): ClaudeState
function modelLabel(id: string): string           // 'claude-haiku-5-5' → 'Haiku 5.5', 'claude-fable-5-2' → 'Fable 5.2'
function actionTitle(tool: string, input: any): { title: string; detail: string }  // Bash → «Запустил команду» + команда; Read → «Прочитал файл» + путь; Edit/Write/MultiEdit → «Изменил файл» + путь (+diff); Grep/Glob → «Искал» + шаблон; WebFetch/WebSearch → «Открыл страницу»/«Искал в сети»; TodoWrite → «План» ; Task/Agent → «Запустил агента» + description; прочее → имя инструмента
function nowLabel(tool: string, input: any): string // «Запускает npm test», «Читает form.css», «Пишет PaymentService.kt», «Ищет …»
```
Правила: `system/init` → sessionId, model; `stream_event` text_delta → дописывает текущую assistant-карточку агента (`streaming: true`); `assistant` → финализирует текст, на каждый `tool_use` создаёт action `running`, а для `Task`/`Agent` ещё и агента-ребёнка (имя = `input.description`, модель из первого его ответа); `user` с `tool_result` → action `done`/`error` (`is_error`), для агента-ребёнка — статус `done`/`error`; `AskUserQuestion` → агент `waiting`; `TodoWrite` → `step` (n = выполненные+1 ≤ m); `parent_tool_use_id` относит событие к агенту-ребёнку; события агента, пришедшие раньше его `tool_use`, создают агента «Агент» и дополняются позже; контекст = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` последнего ответа главного агента; `contextMax` из `result.modelUsage[*].contextWindow`, до него 200000; `result` → summary-карточка (текст `result`), `busy=false`, главный `done`, стоимость; непарсящаяся строка игнорируется; главный агент называется «Главный».
- [ ] Тесты по фикстуре: после всех строк — `model 'claude-haiku-5-5'`, элементы: action Bash `ls` done с результатом, assistant с русским текстом, summary со стоимостью 0.004824; `contextMax 1000000`; стриминг: после первых text_delta assistant-карточка `streaming: true` с частичным текстом. Синтетика: Task → агент-ребёнок running → его Read → `now 'Читает …'` → tool_result → done; ранний ребёнок; TodoWrite 2 из 3 → step `{n:3,m:3}`/правила; мусорная строка не ломает. Commit `"Редьюсер событий Claude"`.

### Task 5: Лента и живой терминал в панели

**Files:** Create `src/feed/Feed.tsx`, `src/feed/ShellBlockView.tsx`, `src/feed/LiveTerminal.tsx`; Modify `src/terminal/TerminalPane.tsx` (разделить: PTY/xterm-логика остаётся, раскладка панели → лента + живой терминал), `src/global.css`; Test: `src/feed/*.test.tsx`.

Поведение: панель = прокручиваемая лента (`.feed` из макета: padding 16px 22px) + внизу (в Task 6) строка ввода. Живой xterm виден только пока идёт команда (блок `running` — внутри него, высота по содержимому до 60% панели, далее скролл внутри) или при alt screen (вся панель поверх ленты, `term.buffer.onBufferChange`). На `start` — `term.reset()`; на `end` — `SerializeAddon.serializeAsHTML({ includeGlobalBackground: false })` → HTML блока (без внешних стилей, цвета ANSI → токены темы через классы/inline как отдаёт аддон), `lines` из буфера. Пока команда идёт, фокус клавиатуры в xterm (ввод уходит в PTY). Вид блока — `.blk` из макета: заголовок `❯ <команда>` слева (❯ цветом `--accText`, команда `--strong`), длительность справа (`--muted`, 11px), вывод моноширинным 13px, line-height 1.7; ненулевой код выхода — полоса слева `--del` и `exit 1` справа; выбранный блок (`⌘↑/⌘↓`) — рамка `--acc` и фон acc 6%; `⌘⇧C` копирует вывод выбранного блока как текст. Блок > `COLLAPSE_LINES` строк показывает первые 200 и кнопку «Показать всё (N строк)». Автопрокрутка вниз, если пользователь у низа. HTML блока вставляется только из SerializeAddon (не из внешних данных).
- [ ] Тесты: лента рендерит блоки и Claude-элементы по порядку; running-блок содержит живой терминал; alt screen → оверлей; свёртка длинного блока; ⌘↑/⌘↓ выбор; ⌘⇧C копирует текст. Ручная проверка (человек): `ls`, `git status`, `vim`, `htop`, `sudo -v`, `read x`, `⌃C` на `sleep 10`, `yes | head -n 100000`.
- [ ] Commit `"Лента блоков и живой терминал"`.

### Task 6: Карточки Claude и режим чтения

**Files:** Create `src/claude/cards/{UserBubble,AssistantCard,ActionCard,SummaryCard,ErrorCard}.tsx`, `src/claude/Markdown.tsx`; Modify `Feed.tsx`, `global.css`; Test: `src/claude/cards/*.test.tsx`.

Вид — точно по `04-main-window.html` (`.you`, `.card`, `.act`, `.diff`) и `02-message-layers.html` вариант B (`.sum` для итога): вопрос справа (`--you`, радиус 10/10/2/10, подпись «Вы»); ответ — карточка `--panel`, рамка `--rule`, полоса слева 2px `--acc`, подпись «<Имя агента> · <Модель>» моноширинным 10.5px uppercase цветом `--accText` (у Fable — `#e8c46a`); markdown через `react-markdown` + `remark-gfm` (заголовки, списки, таблицы, ссылки открываются через opener, код с подсветкой по токенам `--kw --str --fn --num --com` и кнопкой «Копировать»), без `rehype-raw` (HTML не исполняется); стриминг — мигающий курсор в конце; действие — пунктирная рамка, подпись `▶ Запустил команду`/`✎ Изменил файл` цветом `--info`, деталь моноширинным, diff «было/стало» (`--del`/`--add`), идущее действие — полоса `--acc` и спиннер «Сейчас выполняю…» (`.act.run`); итог — `--sumBg`/`--sumRule`, подпись «✓ Итог», время и стоимость; ошибка — рамка `--del`. Ширина текста ≤ 76ch.
- [ ] Тесты: markdown-таблица и код рендерятся, `<script>` в тексте выводится как текст; diff показывает строки -/+; подпись агента с моделью. Скриншот против макета. Commit `"Карточки Claude по макету"`.

### Task 7: Строка ввода (как в Warp)

**Files:** Create `src/input/InputBar.tsx`, `src/input/history.ts`; Modify `TerminalPane.tsx`, `src-tauri/src/lib.rs` (команда `shell_history() -> Vec<String>`: последние 5000 команд из `$HISTFILE`/`~/.zsh_history`, формат extended `: ts:0;cmd` и обычный); Test: `src/input/*.test.ts(x)`, Rust тест на парсинг истории.

Вид — `.input` из макета: отступ 8px 12px 10px, поле `--bg`, рамка `--rule`, радиус 9px, моноширинный 13.5px, плейсхолдер «Команда или вопрос Claude…», справа подсказка «⌘↵ отправить агенту»; **без** плашек папки/ветки. Поведение: многострочное (`⇧↵` — новая строка, авто-высота до 8 строк); `↵` — команда в PTY (`text + '\r'`) и в историю; `⌘↵` — в Claude-сессию панели (создаётся при первом сообщении в cwd панели; карточка «Вы» сразу); `↑/↓` на первой/последней строке — история; `⌃C` — очистить строку (или прервать: если идёт команда — в PTY, если Claude занят — `claude_interrupt`); `⌃L` — очистить ленту; пока идёт shell-команда — строка неактивна, фокус в живом терминале; подсказки путей плана 2a работают в строке ввода (`completionContext` по тексту/курсору строки, подстановка меняет значение поля, а не пишет в PTY; попап над полем). `esc` при открытом попапе закрывает его.
- [ ] Тесты: ↵ пишет в PTY и добавляет в историю; ⌘↵ вызывает `claude_send`/`claude_start`; ↑ листает историю; ⇧↵ перенос; подсказка `cd Док` → Tab → значение `cd Документы/`; парсинг истории zsh. Скриншот против макета. Commit `"Строка ввода как в Warp"`.

### Task 8: Панель агентов и статус-бар

**Files:** Create `src/claude/AgentsPanel.tsx`; Modify `src/ui/StatusBar.tsx`, `src/ui/TabBar.tsx`, `TerminalPane.tsx`, `src/keys/keymap.ts`; Test: `src/claude/AgentsPanel.test.tsx`, `src/ui/StatusBar.test.tsx`.

Панель — `.dock`/`.dh`/`.row`/`.detail` из `04-main-window.html`, над строкой ввода; видна, когда в панели есть Claude-сессия; заголовок «Агенты · N работают · M ждёт · K готов» и подсказка клавиш; строка: точка статуса (running — пульс `--accText`, waiting `--warn`, done `--add`, error `--del`), имя (дети со сдвигом `└`), плашка модели (Fable — золотая), что делает сейчас, время (`1м 04с`), токены (`38k`); выбранная строка — фон `#232b3a`-эквивалент через `--acc` 12% и полоса `--acc`; `↵` раскрывает `.detail` («→ сейчас: …», «✓ …» из history, «шаг N из M»); `⌘↓` из строки ввода переводит фокус в панель, `↑↓` выбор, `esc` назад, `⌘J` скрыть/показать. Статус-бар — по макету: `◆ CLAUDE` (сегмент `--acc`, только при сессии) · `сейчас <агент>` · `проект` · `⎇ ветка` · `модель <Модель>` · `контекст` полоска 70px + `84k/200k` (желтеет > 80%) · справа время. Точка на вкладке: синяя пульсирующая — работает, жёлтая — ждёт, зелёная — готово (пока вкладку не открыли), красная — ошибка.
- [ ] Тесты по состояниям. Скриншот против макета. Commit `"Панель агентов и статус-бар Claude"`.

### Task 9: Уведомления

**Files:** Create `src/notify/notify.ts`, `src/notify/Toasts.tsx`; Modify `src-tauri` (plugin notification + capability), `settings.ts`, `SettingsPanel.tsx` (раздел «Уведомления»); Test: `src/notify/*.test.ts(x)`.

По §4.7 спеки: события «завершил задачу», «ждёт ответа», «ошибка» (главный агент — всегда; субагенты — если включено), долгая shell-команда > 10 с. Тост справа внизу над статус-баром 6 с, клик — переход к вкладке/агенту; системное уведомление, если окно не в фокусе или событие не в текущей вкладке; счётчик «ждут ответа» на иконке Dock (`setBadgeCount`); тихий звук (WebAudio, короткий тон) при «готово»/«ждёт», выключаемый. Настройки: системные уведомления, звук, субагенты, долгие команды.
- [ ] Тесты: правила «когда уведомлять»; тост исчезает через 6 с. Commit `"Уведомления об агентах и долгих командах"`.

### Task 10: Сверка с макетом и сборка

- [ ] Запустить фронтенд в браузере с моками (сценарий как в макете: `git status`, вопрос, ответ Главного, действие Поиска, ответ Архитектора, агенты, статус-бар) и снять скриншот; положить рядом со скриншотом `04-main-window.html`; устранить все видимые расхождения (отступы, цвета, шрифты, размеры).
- [ ] `npm run typecheck && npm test && cargo test && npm run tauri build`; README: обновить «что работает». Commit `"Сверка с макетом и README"`.
