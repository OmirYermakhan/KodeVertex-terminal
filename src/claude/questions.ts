// Вопросы агента (AskUserQuestion) по протоколу stream-json: `claude --permission-prompt-tool stdio`
// присылает control_request `can_use_tool` и ждёт control_response. Чистая логика.

export interface QuestionOption {
  label: string
  description: string
}

export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}

export type PermissionRequest =
  | { kind: 'ask'; requestId: string; toolUseId: string | null; input: Record<string, unknown>; questions: Question[] }
  /**
   * Запрос разрешения (по режиму из настроек; даже под bypassPermissions — правила ask, защищённые
   * пути, инструменты, требующие пользователя) — спрашиваем. suggestions — `permission_suggestions` CLI для «всегда».
   */
  | {
      kind: 'permission'
      requestId: string
      toolUseId: string | null
      tool: string
      input: Record<string, unknown>
      suggestions: unknown[] | null
    }
  /** Ввод инструмента не объект — запрещаем сразу. */
  | { kind: 'deny'; requestId: string }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function parseQuestions(v: unknown): Question[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: Question[] = []
  for (const q of v) {
    if (!isRec(q) || !str(q.question) || !Array.isArray(q.options)) return null
    const options = q.options.filter(isRec).map((o) => ({ label: str(o.label), description: str(o.description) })).filter((o) => o.label)
    if (options.length === 0) return null
    out.push({ question: str(q.question), header: str(q.header), multiSelect: q.multiSelect === true, options })
  }
  return out
}

export function parsePermissionRequest(line: string | object): PermissionRequest | null {
  let ev: unknown = line
  if (typeof line === 'string') {
    try {
      ev = JSON.parse(line)
    } catch {
      return null
    }
  }
  if (!isRec(ev) || ev.type !== 'control_request' || !isRec(ev.request)) return null
  const r = ev.request
  const requestId = str(ev.request_id)
  if (r.subtype !== 'can_use_tool' || !requestId) return null
  if (!isRec(r.input)) return { kind: 'deny', requestId }
  const input = r.input
  const toolUseId = str(r.tool_use_id) || null
  const questions = r.tool_name === 'AskUserQuestion' ? parseQuestions(input.questions) : null
  if (questions) return { kind: 'ask', requestId, toolUseId, input, questions }
  const suggestions = Array.isArray(r.permission_suggestions) && r.permission_suggestions.length ? r.permission_suggestions : null
  return { kind: 'permission', requestId, toolUseId, tool: str(r.tool_name) || 'инструмент', input, suggestions }
}

/** Ответ на вопросы: `answers` — текст вопроса → выбранный вариант (несколько — через запятую) или свой ответ. */
export function answerResponse(input: Record<string, unknown>, answers: string[]) {
  const qs = Array.isArray(input.questions) ? input.questions : []
  const map: Record<string, string> = {}
  qs.forEach((q, i) => {
    if (isRec(q) && typeof q.question === 'string' && answers[i] !== undefined) map[q.question] = answers[i]
  })
  return { behavior: 'allow', updatedInput: { ...input, answers: map } }
}

export const allowResponse = (input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input })
/** «Разрешить всегда для этой сессии»: правила, которые предложил сам CLI. */
export const alwaysResponse = (input: Record<string, unknown>, suggestions: unknown[]) => ({
  behavior: 'allow',
  updatedInput: input,
  updatedPermissions: suggestions,
})
export const DENY_MESSAGE = 'Пользователь запретил'
export const denyResponse = () => ({ behavior: 'deny', message: DENY_MESSAGE })

const lines = (t: unknown) => (typeof t === 'string' && t ? t.split('\n').length : 0)
const clip = (t: string, max = 160) => (t.length > max ? t.slice(0, max - 1) + '…' : t)

/**
 * Невидимые и «переворачивающие» символы: управляющие C0 (кроме \n и \t), DEL и C1, мягкий перенос,
 * нулевой ширины и метки направления (U+200B–200F), разделители строк/абзацев (U+2028/2029),
 * встраивания и переопределения направления (U+202A–202E), невидимые операторы (U+2060–2064),
 * изоляты (U+2066–2069), BOM (U+FEFF). Ими команду в запросе можно показать не той, что выполнится.
 */
function isHidden(c: number): boolean {
  return (
    (c < 0x20 && c !== 0x0a && c !== 0x09) ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xad ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x2064) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  )
}

/** Невидимые символы — видимой меткой `⟨U+202E⟩`: в запросе разрешения видно всё, что уйдёт в инструмент. */
export function neutralize(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out += isHidden(c) ? `⟨U+${c.toString(16).toUpperCase().padStart(4, '0')}⟩` : s[i]
  }
  return out
}

/** Понятное описание запроса разрешения одной строкой (лента): команда, путь, размер правки. */
export function permissionSummary(tool: string, input: Record<string, unknown>): { main: string; detail: string } {
  const s = summaryRaw(tool, input)
  return { main: neutralize(s.main), detail: neutralize(s.detail) }
}

function summaryRaw(tool: string, input: Record<string, unknown>): { main: string; detail: string } {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  switch (tool) {
    case 'Bash':
      return { main: clip(str(input.command)), detail: str(input.description) }
    case 'Edit':
      return { main: path, detail: `−${lines(input.old_string)} +${lines(input.new_string)} строк` }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isRec) : []
      const del = edits.reduce((n, e) => n + lines(e.old_string), 0)
      const add = edits.reduce((n, e) => n + lines(e.new_string), 0)
      return { main: path, detail: `${edits.length} правок · −${del} +${add} строк` }
    }
    case 'Write':
      return { main: path, detail: `${lines(input.content)} строк` }
    case 'Read':
    case 'NotebookEdit':
      return { main: path, detail: '' }
    case 'WebFetch':
      return { main: str(input.url), detail: '' }
  }
  if (path) return { main: path, detail: '' }
  let json = ''
  try {
    json = JSON.stringify(input)
  } catch {
    json = ''
  }
  return { main: clip(json), detail: '' }
}

export type ViewLine = { k: 'a' | 'd' | 'n'; t: string }

/** Сколько строк записи/правки показываем в запросе разрешения (лимит только показа). */
export const VIEW_LINES = 200

/** Что именно будет разрешено — без обрезки команды и с обезвреженными невидимыми символами. */
export interface PermissionView {
  /** Путь или URL одной строкой. */
  target: string
  /** Полный текст: команда Bash; для неизвестных и MCP-инструментов — весь ввод (JSON). */
  code: string
  /** Строки записи и правки: `d` — было, `a` — станет, `n` — разделитель правок. */
  lines: ViewLine[]
  /** Сколько строк не показано сверх VIEW_LINES (они тоже будут записаны). */
  more: number
  /** Важные флаги ввода: «в фоне», «без песочницы», «все вхождения». */
  facts: string[]
  /** Поля ввода, которые не разобраны выше (JSON): одобряется весь ввод, показываем весь. */
  extra: string
  /** `description` пишет сам агент — это его слова, а не факт о команде. */
  agentNote: string
}

const textLines = (t: unknown): string[] => (typeof t === 'string' && t !== '' ? t.replace(/\n$/, '').split('\n') : [])

function pretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? ''
  } catch {
    return ''
  }
}

export function permissionView(tool: string, input: Record<string, unknown>): PermissionView {
  const used = new Set<string>()
  const take = (k: string) => {
    used.add(k)
    return input[k]
  }
  let target = ''
  let code = ''
  let agentNote = ''
  const facts: string[] = []
  const out: ViewLine[] = []
  const push = (k: ViewLine['k'], t: unknown) => {
    for (const line of textLines(t)) out.push({ k, t: line })
  }
  switch (tool) {
    case 'Bash': {
      code = str(take('command'))
      agentNote = str(take('description'))
      if (take('run_in_background') === true) facts.push('в фоне')
      if (take('dangerouslyDisableSandbox') === true) facts.push('без песочницы')
      const t = take('timeout')
      if (typeof t === 'number') facts.push(`тайм-аут ${t} мс`)
      break
    }
    case 'Write':
      target = str(take('file_path'))
      push('a', take('content'))
      if (out.length === 0) facts.push('пустой файл')
      break
    case 'Edit':
      target = str(take('file_path'))
      push('d', take('old_string'))
      push('a', take('new_string'))
      if (take('replace_all') === true) facts.push('все вхождения')
      break
    case 'MultiEdit': {
      target = str(take('file_path'))
      if (!Array.isArray(input.edits)) break
      const edits = take('edits') as unknown[]
      facts.push(`${edits.length} правок`)
      edits.forEach((e, i) => {
        if (!isRec(e)) {
          out.push({ k: 'n', t: `@@ правка ${i + 1}: ${JSON.stringify(e)}` })
          return
        }
        out.push({ k: 'n', t: `@@ правка ${i + 1} из ${edits.length}${e.replace_all === true ? ' · все вхождения' : ''}` })
        push('d', e.old_string)
        push('a', e.new_string)
      })
      break
    }
    case 'NotebookEdit':
      target = str(take('notebook_path'))
      push('a', take('new_source'))
      break
    case 'Read':
      target = str(take('file_path'))
      break
    case 'WebFetch':
      target = str(take('url'))
      break
    default:
      code = pretty(input)
      for (const k of Object.keys(input)) used.add(k)
  }
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !used.has(k)))
  const extra = Object.keys(rest).length ? pretty(rest) : ''
  return {
    target: neutralize(target),
    code: neutralize(code),
    lines: out.slice(0, VIEW_LINES).map((l) => ({ k: l.k, t: neutralize(l.t) })),
    more: Math.max(0, out.length - VIEW_LINES),
    facts,
    extra: neutralize(extra),
    agentNote: neutralize(agentNote),
  }
}

/** Куда CLI запишет правило «всегда» (`destination` в permission_suggestions). */
const DESTINATION: Record<string, string> = {
  session: 'на эту сессию',
  localSettings: 'в .claude/settings.local.json',
  projectSettings: 'в .claude/settings.json',
  userSettings: 'в ~/.claude/settings.json',
  cliArg: 'в аргументы запуска',
}

const BEHAVIOR: Record<string, string> = { allow: 'разрешить', deny: 'запретить', ask: 'спрашивать' }

/** Значение из словаря только по своему ключу (не `constructor` и прочее из прототипа). */
const own = (m: Record<string, string>, k: string): string | undefined => (Object.hasOwn(m, k) ? m[k] : undefined)

const ruleText = (r: unknown): string => {
  if (!isRec(r)) return JSON.stringify(r) ?? ''
  const name = str(r.toolName) || '?'
  return typeof r.ruleContent === 'string' && r.ruleContent ? `${name}(${r.ruleContent})` : name
}

/**
 * Что добавит «Разрешить всегда»: правила из `permission_suggestions` CLI по-человечески
 * (`разрешить: Bash(npm test:*) — на эту сессию`); незнакомое — как JSON.
 */
export function suggestionLines(suggestions: unknown[]): string[] {
  return suggestions.map((s) => {
    const json = JSON.stringify(s) ?? ''
    if (!isRec(s)) return neutralize(json)
    const dest = str(s.destination)
    const where = own(DESTINATION, dest) ?? (dest ? `в ${dest}` : 'куда — не указано')
    const list = (v: unknown) => (Array.isArray(v) ? v : [])
    let what: string
    switch (s.type) {
      case 'addRules':
      case 'replaceRules':
      case 'removeRules': {
        const verb = s.type === 'addRules' ? '' : s.type === 'replaceRules' ? 'заменить на · ' : 'убрать · '
        what = `${verb}${own(BEHAVIOR, str(s.behavior)) ?? str(s.behavior)}: ${list(s.rules).map(ruleText).join(', ')}`
        break
      }
      case 'setMode':
        what = `режим: ${str(s.mode)}`
        break
      case 'addDirectories':
        what = `доступ к каталогам: ${list(s.directories).map(String).join(', ')}`
        break
      case 'removeDirectories':
        what = `убрать каталоги: ${list(s.directories).map(String).join(', ')}`
        break
      default:
        return neutralize(json)
    }
    return neutralize(`${what} — ${where}`)
  })
}

/** Все правила — только на сессию: подпись «для этой сессии» честна; иначе — просто «всегда». */
export function alwaysLabel(suggestions: unknown[]): string {
  const sessionOnly = suggestions.length > 0 && suggestions.every((s) => isRec(s) && s.destination === 'session')
  return sessionOnly ? 'Разрешить всегда для этой сессии' : 'Разрешить всегда'
}

/** Варианты, отмеченные в вопросе с несколькими ответами, — одной строкой. */
export const joinLabels = (labels: string[]) => labels.join(', ')

/** Курсор карточки вопроса (последняя строка — «Свой ответ…») и отмеченные варианты. */
export interface QuestionCursor {
  cursor: number
  checked: number[]
}

export type QuestionAction = { kind: 'answer'; text: string } | { kind: 'custom' } | { kind: 'leave' }

export function questionKey(
  s: QuestionCursor,
  q: Question,
  key: string,
): { state: QuestionCursor; action: QuestionAction | null; handled: boolean } {
  const n = q.options.length + 1
  const done = (state: QuestionCursor, action: QuestionAction | null = null) => ({ state, action, handled: true })
  switch (key) {
    case 'ArrowDown':
      return done({ ...s, cursor: (s.cursor + 1) % n })
    case 'ArrowUp':
      return done({ ...s, cursor: (s.cursor - 1 + n) % n })
    case ' ':
      if (!q.multiSelect || s.cursor >= q.options.length) return done(s)
      return done({
        ...s,
        checked: s.checked.includes(s.cursor) ? s.checked.filter((i) => i !== s.cursor) : [...s.checked, s.cursor].sort((a, b) => a - b),
      })
    case 'Enter': {
      if (s.cursor >= q.options.length) return done(s, { kind: 'custom' })
      const picked = q.multiSelect && s.checked.length ? s.checked : [s.cursor]
      return done(s, { kind: 'answer', text: joinLabels(picked.map((i) => q.options[i].label)) })
    }
    case 'Escape':
      return done(s, { kind: 'leave' })
  }
  if (/^[1-9]$/.test(key) && Number(key) <= n) return done({ ...s, cursor: Number(key) - 1 })
  return { state: s, action: null, handled: false }
}

const RECOMMENDED = /\s*[([]?\s*(recommended|рекомендуется|рекомендую|рекомендовано)\s*[)\]]?\s*$/i

/** Вариант помечен как рекомендуемый (в подписи или описании). */
export const isRecommended = (o: QuestionOption) => /recommend|рекоменд/i.test(o.label + ' ' + o.description)

/** Подпись без хвоста «(Recommended)» — его заменяет метка «рекомендуется». */
export const displayLabel = (label: string) => label.replace(RECOMMENDED, '') || label
