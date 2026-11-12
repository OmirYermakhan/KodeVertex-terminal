// Выбор через `@` в режиме Claude (макет 06, сцена Е): группы «Файлы» (подсказки путей),
// «Блоки» (недавние блоки ленты по команде и выводу), «Сообщения» (ответы Claude по тексту).
import type { FsEntryTS } from '../completion/useCompletion'
import { blockTextOf } from '../feed/blockHtml'
import type { ShellBlock } from '../feed/feed'
import type { Agent } from '../claude/reducer'
import { plainMessage } from './preview/format'
import { quickKind } from './preview/api'
import { joinPath } from '../completion/useCompletion'
import { blockAttachment, messageAttachment } from './fromFeed'
import type { Attachment } from './types'

/** Видно строк без прокрутки (кроме заголовков групп). */
export const AT_VISIBLE = 8
/** Блоков и сообщений — не больше (файлы — сколько влезет до AT_VISIBLE, но не меньше 3). */
export const AT_FEED_MAX = 3
const FILES_MIN = 3
const DETAIL_MAX = 24
const SNIPPET_MAX = 16

export type AtGroup = 'files' | 'blocks' | 'messages'
export const GROUP_TITLE: Record<AtGroup, string> = { files: 'Файлы', blocks: 'Блоки', messages: 'Сообщения' }

/** [начало, конец) подсветки в строке. */
export type Mark = [number, number]

export type AtRow =
  | { group: 'files'; key: string; index: number; entry: FsEntryTS }
  | { group: 'blocks'; key: string; block: ShellBlock; detail: string | null; cmdMark: Mark | null; detailMark: Mark | null }
  | { group: 'messages'; key: string; id: string; text: string; agent?: Agent; snippet: string; mark: Mark | null }

export interface AtMessage {
  id: string
  text: string
  agent?: Agent
}

/** Источник блоков и сообщений: лента панели (от старых к новым). */
export interface AtFeed {
  blocks: readonly ShellBlock[]
  messages: readonly AtMessage[]
}

/** Вывода блока ищем не больше (хвост): огромный вывод не тормозит набор. */
export const SEARCH_MAX = 64 * 1024

interface Indexed {
  text: string
  lower: string
}

const fold = (s: string) => s.toLowerCase()
const index = (text: string): Indexed => ({ text, lower: fold(text) })

/** Индекс вывода блока: замороженный блок не меняется — кэш по объекту (новая лента — новые объекты). */
const blockIndex = new WeakMap<ShellBlock, Indexed>()
function outputOf(b: ShellBlock): Indexed {
  let x = blockIndex.get(b)
  if (!x) {
    const t = blockTextOf(b)
    x = index(t.length > SEARCH_MAX ? t.slice(-SEARCH_MAX) : t)
    blockIndex.set(b, x)
  }
  return x
}

/** Индекс сообщения: по id, пока текст тот же (законченный ответ не меняется). */
const messageIndex = new Map<string, { src: string } & Indexed>()
function messageOf(m: AtMessage): Indexed {
  const hit = messageIndex.get(m.id)
  if (hit && hit.src === m.text) return hit
  const x = { src: m.text, ...index(plainMessage(m.text).replace(/\s+/g, ' ')) }
  messageIndex.set(m.id, x)
  if (messageIndex.size > 500) messageIndex.delete(messageIndex.keys().next().value!)
  return x
}

/** Для проверки кэша в тестах. */
export const searchIndexSize = () => messageIndex.size

/** Слово вокруг совпадения (для «npm test · form.test.tsx»). */
function wordAround(text: string, at: number, len: number): { word: string; mark: Mark } {
  let a = at
  let b = at + len
  while (a > 0 && !/\s/.test(text[a - 1]) && at - a < DETAIL_MAX) a--
  while (b < text.length && !/\s/.test(text[b]) && b - a < DETAIL_MAX) b++
  return { word: text.slice(a, b), mark: [at - a, at - a + len] }
}

function matchBlock(b: ShellBlock, q: string): Extract<AtRow, { group: 'blocks' }> | null {
  const cmd = b.command.replace(/\s+/g, ' ').trim()
  const key = `b:${b.id}`
  if (q === '') return { group: 'blocks', key, block: b, detail: null, cmdMark: null, detailMark: null }
  const ci = fold(cmd).indexOf(q)
  if (ci >= 0) return { group: 'blocks', key, block: b, detail: null, cmdMark: [ci, ci + q.length], detailMark: null }
  const out = outputOf(b)
  const oi = out.lower.indexOf(q)
  if (oi < 0) return null
  const w = wordAround(out.text, oi, q.length)
  return { group: 'blocks', key, block: b, detail: w.word, cmdMark: null, detailMark: w.mark }
}

function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() + '…' : s
}

function matchMessage(m: AtMessage, q: string): Extract<AtRow, { group: 'messages' }> | null {
  const { text: plain, lower } = messageOf(m)
  const key = `m:${m.id}`
  if (q === '') return { group: 'messages', key, id: m.id, text: m.text, agent: m.agent, snippet: clip(plain, SNIPPET_MAX), mark: null }
  const i = lower.indexOf(q)
  if (i < 0) return null
  // Отрывок — с начала слова, в котором совпадение.
  let a = i
  while (a > 0 && !/\s/.test(plain[a - 1]) && i - a < SNIPPET_MAX) a--
  const snippet = clip(plain.slice(a), Math.max(SNIPPET_MAX, i - a + q.length))
  return { group: 'messages', key, id: m.id, text: m.text, agent: m.agent, snippet, mark: [i - a, i - a + q.length] }
}

/**
 * Строки выбора по порядку групп. files — уже отранжированные подсказки путей; dirPart не пуст
 * (идём по папкам) — только файлы. Новые блоки и сообщения — выше.
 */
export function atRows(query: string, dirPart: string, files: readonly FsEntryTS[], feed: AtFeed | null): AtRow[] {
  const q = fold(query)
  const blocks: AtRow[] = []
  const messages: AtRow[] = []
  if (feed && dirPart === '') {
    for (let i = feed.blocks.length - 1; i >= 0 && blocks.length < AT_FEED_MAX; i--) {
      const b = feed.blocks[i]
      if (b.running) continue
      const r = matchBlock(b, q)
      if (r) blocks.push(r)
    }
    for (let i = feed.messages.length - 1; i >= 0 && messages.length < AT_FEED_MAX; i--) {
      const r = matchMessage(feed.messages[i], q)
      if (r) messages.push(r)
    }
  }
  const others = blocks.length + messages.length
  const fileMax = others === 0 ? files.length : Math.max(FILES_MIN, AT_VISIBLE - others)
  const fileRows: AtRow[] = files.slice(0, fileMax).map((entry, index) => ({ group: 'files', key: `f:${entry.name}`, index, entry }))
  return [...fileRows, ...blocks, ...messages]
}

/** Значок для бокового просмотра выбранной строки (у файла — тип по расширению). */
export function rowToken(row: AtRow, dir: string): Attachment {
  switch (row.group) {
    case 'files': {
      const e = row.entry
      return { id: `at-side:${row.key}`, kind: quickKind(e.name, e.isDir), label: e.isDir ? `${e.name}/` : e.name, path: joinPath(dir, e.name) }
    }
    case 'blocks':
      return blockAttachment(row.block)
    case 'messages':
      return messageAttachment(row.text, row.agent, row.id)
  }
}

