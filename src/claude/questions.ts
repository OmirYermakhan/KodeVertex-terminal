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
   * Запрос разрешения (даже под bypassPermissions: правила ask, защищённые пути, инструменты,
   * требующие пользователя) — спрашиваем. suggestions — `permission_suggestions` CLI для «всегда».
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

/** Понятное описание запроса разрешения: команда, путь, размер правки. */
export function permissionSummary(tool: string, input: Record<string, unknown>): { main: string; detail: string } {
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
