// `/btw` — побочный вопрос, как в Claude Code: пока агент работает, можно спросить о разговоре,
// не прерывая ход. Отдельный процесс `claude` — ответвление сессии без записи на диск и без
// инструментов (`side` в claude_start); основной разговор и лента не меняются. Ответ — карточкой
// над строкой ввода (BtwCard), esc или ✕ закрывает её и останавливает процесс.
import { Channel, invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { btwContext, type ClaudeExit } from './sessionStore'

export interface BtwAnswer {
  /** Номер вопроса: поздние строки прежнего процесса не попадают в новый ответ. */
  seq: number
  question: string
  text: string
  status: 'run' | 'done' | 'error'
  error?: string
  /** Вопрос задан без контекста разговора (сессии ещё нет). */
  bare: boolean
}

export const useBtw = create<{ byPane: Record<string, BtwAnswer> }>(() => ({ byPane: {} }))

const procs = new Map<string, { seq: number; id: Promise<string | null> }>()
let seqs = 0

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export const NO_QUESTION = 'Напишите вопрос после /btw'
const NO_DIR = 'Каталог панели неизвестен — спросить негде'
const UNTRUSTED = 'Папка не в доверенных — сначала начните разговор с Claude здесь'

/** `/btw вопрос` → вопрос (может быть пустым); не `/btw` → null. */
export function btwQuestion(text: string): string | null {
  const m = /^\s*\/btw(?:\s+([\s\S]*))?$/.exec(text)
  return m ? (m[1] ?? '').trim() : null
}

function set(paneId: string, seq: number, f: (a: BtwAnswer) => BtwAnswer): void {
  useBtw.setState((st) => {
    const cur = st.byPane[paneId]
    return cur && cur.seq === seq ? { byPane: { ...st.byPane, [paneId]: f(cur) } } : st
  })
}

function stopProc(paneId: string): void {
  const p = procs.get(paneId)
  if (!p) return
  procs.delete(paneId)
  void p.id.then((id) => {
    if (id) invoke('claude_stop', { id }).catch(() => {})
  })
}

/** Текст сообщения ассистента (блоки text). */
function messageText(msg: unknown): string | null {
  if (!isRec(msg) || !Array.isArray(msg.content)) return null
  const parts = msg.content.filter((b): b is { type: 'text'; text: string } => isRec(b) && b.type === 'text' && typeof b.text === 'string')
  return parts.length > 0 ? parts.map((b) => b.text).join('') : null
}

/** Строка stream-json процесса вопроса → ответ. */
export function reduceBtw(a: BtwAnswer, line: string): BtwAnswer {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return a
  }
  if (!isRec(ev) || a.status !== 'run') return a
  if (ev.type === 'stream_event' && isRec(ev.event)) {
    const e = ev.event
    if (e.type === 'content_block_delta' && isRec(e.delta) && e.delta.type === 'text_delta' && typeof e.delta.text === 'string') {
      return { ...a, text: a.text + e.delta.text }
    }
    return a
  }
  if (ev.type === 'assistant') {
    // Целое сообщение — итог потока (и запасной путь, если частей не было).
    const t = messageText(ev.message)
    return t !== null ? { ...a, text: t } : a
  }
  if (ev.type === 'result') {
    if (ev.is_error === true) {
      const errs = Array.isArray(ev.errors) ? ev.errors.filter((x) => typeof x === 'string').join('; ') : ''
      const msg = (typeof ev.result === 'string' && ev.result) || errs || 'Claude не ответил'
      return { ...a, status: 'error', error: msg }
    }
    const t = typeof ev.result === 'string' && ev.result ? ev.result : a.text
    return { ...a, text: t, status: 'done' }
  }
  return a
}

/** Задать побочный вопрос в панели: прежний (если был) закрывается. */
export function askBtw(paneId: string, paneCwd: string | undefined, question: string): void {
  stopProc(paneId)
  const seq = ++seqs
  const ctx = btwContext(paneId, paneCwd)
  const answer: BtwAnswer = { seq, question, text: '', status: 'run', bare: ctx.resume === null }
  useBtw.setState((st) => ({ byPane: { ...st.byPane, [paneId]: answer } }))
  if (ctx.cwd === null) {
    set(paneId, seq, (a) => ({ ...a, status: 'error', error: NO_DIR }))
    return
  }
  const fail = (msg: string) => set(paneId, seq, (a) => (a.status === 'run' ? { ...a, status: 'error', error: msg } : a))
  const onLine = (line: string) => {
    if (line === '') return
    set(paneId, seq, (a) => reduceBtw(a, line))
    const a = useBtw.getState().byPane[paneId]
    // Ответ готов — процесс больше не нужен (stdin открыт, сам он не выйдет).
    if (a?.seq === seq && a.status !== 'run' && procs.get(paneId)?.seq === seq) stopProc(paneId)
  }
  const onExit = (e: ClaudeExit) => {
    if (procs.get(paneId)?.seq === seq) procs.delete(paneId)
    const tail = e.stderr.trim().split('\n').slice(-3).join('\n')
    fail(tail || `claude завершился (код ${e.code ?? '—'}) без ответа`)
  }
  const id = invoke<string>('claude_start', {
    cwd: ctx.cwd,
    resume: ctx.resume,
    fork: ctx.resume !== null,
    model: ctx.model,
    effort: ctx.effort,
    side: true,
    onLine: new Channel<string>(onLine),
    onExit: new Channel<ClaudeExit>(onExit),
  }).then(
    async (id) => {
      if (procs.get(paneId)?.seq !== seq) {
        // Закрыли, пока запускался.
        invoke('claude_stop', { id }).catch(() => {})
        return null
      }
      try {
        await invoke('claude_send', { id, text: question })
      } catch (e) {
        fail(errText(e))
      }
      return id
    },
    (e: unknown) => {
      fail(errText(e).includes('UNTRUSTED_DIR') ? UNTRUSTED : errText(e))
      return null
    },
  )
  procs.set(paneId, { seq, id })
}

/** Закрыть карточку ответа (и остановить процесс). false — карточки не было. */
export function closeBtw(paneId: string): boolean {
  stopProc(paneId)
  if (!(paneId in useBtw.getState().byPane)) return false
  useBtw.setState((st) => {
    const { [paneId]: _gone, ...rest } = st.byPane
    return { byPane: rest }
  })
  return true
}
