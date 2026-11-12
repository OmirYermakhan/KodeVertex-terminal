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
  /** Любой другой запрос разрешения: при bypassPermissions разрешаем без вопросов. */
  | { kind: 'allow'; requestId: string; input: Record<string, unknown> }

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
  const input = isRec(r.input) ? r.input : {}
  const questions = r.tool_name === 'AskUserQuestion' ? parseQuestions(input.questions) : null
  if (!questions) return { kind: 'allow', requestId, input }
  return { kind: 'ask', requestId, toolUseId: str(r.tool_use_id) || null, input, questions }
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
