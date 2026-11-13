// Сообщение со значками → текст для Claude (stream-json) и список файлов, которые Rust
// превратит в блоки image/document. Значки заменяются на месте, по порядку текста:
// картинка → [Изображение N], pdf → [Документ N], файл/папка → @путь, блок → [Блок N] +
// <terminal_block>, сообщение → [Сообщение N] + <quoted_message>.
import { isToken } from './doc'
import type { Attachment, Doc } from './types'

/** Сколько картинок уходит блоками (лимит API); остальные — путём @…. */
export const MAX_IMAGES = 20
/** Хвост вывода блока: не больше строк и байт. */
export const BLOCK_MAX_LINES = 200
export const BLOCK_MAX_BYTES = 16 * 1024
/** Текст цитируемого сообщения — не больше. */
export const MESSAGE_MAX_BYTES = 16 * 1024

export interface SendFile {
  kind: 'image' | 'pdf'
  path: string
}

export interface Serialized {
  text: string
  files: SendFile[]
}

/** Путь относительно каталога сессии; вне его — абсолютный. */
export function relativize(path: string, cwd: string | null | undefined): string {
  if (!cwd) return path
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  if (path === base) return '.'
  if (base !== '' && path.startsWith(base + '/')) return path.slice(base.length + 1)
  return path
}

/** `@путь`; путь с пробелами — в кавычках. */
export function atMention(path: string): string {
  return /[\s"]/.test(path) ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`
}

const utf8 = new TextEncoder()

/** Обрезка по байтам UTF-8 с конца строки (хвост) или с начала (голова). */
function capBytes(s: string, max: number, keep: 'head' | 'tail'): string {
  if (utf8.encode(s).length <= max) return s
  const chars = [...s]
  let bytes = 0
  const out: string[] = []
  const order = keep === 'tail' ? chars.reverse() : chars
  for (const c of order) {
    bytes += utf8.encode(c).length
    if (bytes > max) break
    out.push(c)
  }
  return keep === 'tail' ? out.reverse().join('') : out.join('')
}

/** Хвост вывода блока: последние BLOCK_MAX_LINES строк, не больше BLOCK_MAX_BYTES. */
export function tailOutput(output: string): string {
  const lines = output.split('\n')
  const tail = lines.length > BLOCK_MAX_LINES ? lines.slice(-BLOCK_MAX_LINES).join('\n') : output
  return capBytes(tail, BLOCK_MAX_BYTES, 'tail')
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
/**
 * Теги обёрток в содержимом (вывод команды, текст сообщения) в любом написании: `</terminal_block>`,
 * `</TERMINAL_BLOCK >`, `< / quoted_message>`, `<terminal_block n="9" …>`. Иначе вывод мог бы закрыть
 * обёртку раньше времени и дописать «свой» блок с поддельной командой и кодом выхода.
 */
const WRAPPER_TAG = /<(\s*\/?\s*)(terminal_block|quoted_message)(?=[\s/>]|$)/gi
/** Тег обёртки внутри содержимого обезврежен: `<` → `<\` (`</x>` → `<\/x>`, `<x …>` → `<\x …>`). */
const body = (s: string) => s.replace(WRAPPER_TAG, '<\\$1$2')

function terminalBlock(n: number, t: Attachment): string {
  const b = t.block
  if (!b) return ''
  const exit = b.exitCode === null ? '' : ` exit="${b.exitCode}"`
  return `<terminal_block n="${n}" cmd="${attr(b.command)}"${exit} cwd="${attr(b.cwd)}">\n${body(tailOutput(b.output))}\n</terminal_block>`
}

function quotedMessage(n: number, t: Attachment): string {
  const m = t.message
  if (!m) return ''
  const text = capBytes(m.text, MESSAGE_MAX_BYTES, 'head')
  return `<quoted_message n="${n}" author="${attr(m.author)}">\n${body(text)}\n</quoted_message>`
}

function pathRef(t: Attachment, cwd: string | null | undefined): string {
  if (!t.path) return `[${t.label}]`
  let p = relativize(t.path, cwd)
  if (t.kind === 'folder' && !p.endsWith('/')) p += '/'
  return atMention(p + (t.line ? `:${t.line}` : ''))
}

export function serialize(doc: Doc, cwd: string | null | undefined): Serialized {
  let text = ''
  const files: SendFile[] = []
  const tail: string[] = []
  const n = { image: 0, pdf: 0, block: 0, message: 0 }
  let ti = 0
  for (const ch of doc.text) {
    if (!isToken(ch)) {
      text += ch
      continue
    }
    const t = doc.tokens[ti++]
    if (!t) continue
    switch (t.kind) {
      case 'image':
        if (t.path && n.image < MAX_IMAGES) {
          files.push({ kind: 'image', path: t.path })
          text += `[Изображение ${++n.image}]`
        } else text += pathRef(t, cwd)
        break
      case 'pdf':
        if (t.path) {
          files.push({ kind: 'pdf', path: t.path })
          text += `[Документ ${++n.pdf}]`
        } else text += `[${t.label}]`
        break
      case 'file':
      case 'folder':
        text += pathRef(t, cwd)
        break
      case 'block':
        text += `[Блок ${++n.block}]`
        tail.push(terminalBlock(n.block, t))
        break
      case 'message':
        text += `[Сообщение ${++n.message}]`
        tail.push(quotedMessage(n.message, t))
        break
      default:
        // Неподдерживаемые значки отправку блокируют (см. blocksSend); на всякий случай — подпись.
        text += `[${t.label}]`
    }
  }
  const extra = tail.filter(Boolean)
  if (extra.length) text = `${text.trimEnd()}\n\n${extra.join('\n\n')}`
  return { text, files }
}
