// DOM поля ввода со значками (contenteditable): Doc → узлы, узлы → Doc, позиции модели ↔ DOM.
// Значок — <span data-tk contenteditable=false>, занимает один символ модели. Рядом со значком,
// где нет текста, стоит текстовый узел с U+200B: в нём живёт курсор (иначе WebKit не ставит его
// между двумя значками или в начале строки перед значком). U+200B в модель не попадает.
import { segments } from '../attach/doc'
import { tokenElement } from '../attach/tokenView'
import { TOKEN_CHAR, type Attachment, type Doc } from '../attach/types'

export const ZWSP = '​'
const isTk = (n: Node): n is HTMLElement => n.nodeType === 1 && !!(n as HTMLElement).dataset?.tk
const isEndBr = (n: Node) => n.nodeName === 'BR' && !n.nextSibling && !!n.parentNode && n.parentNode.lastChild === n
const visible = (s: string) => s.replaceAll(ZWSP, '')

/** Перерисовать поле по модели. selected — id выделенного значка. */
export function renderDoc(root: HTMLElement, doc: Doc, selected: string | null): void {
  const frag = document.createDocumentFragment()
  const segs = segments(doc)
  const text = (s: string) => frag.appendChild(document.createTextNode(s))
  let prevText = false
  for (const s of segs) {
    if (s.type === 'text') {
      text(s.text)
      prevText = !s.text.endsWith('\n')
      continue
    }
    if (!prevText) text(ZWSP)
    frag.appendChild(tokenElement(s.token, s.token.id === selected))
    prevText = false
  }
  // После значка в конце — место для курсора; после \n в конце — пустая последняя строка.
  if (segs.length > 0 && segs[segs.length - 1].type === 'token') text(ZWSP)
  if (doc.text.endsWith('\n')) frag.appendChild(document.createElement('br'))
  root.replaceChildren(frag)
}

/** Модель из DOM (после правки браузером: набор, IME). Значки ищутся по id в tokens. */
export function readDoc(root: HTMLElement, tokens: readonly Attachment[]): Doc {
  const byId = new Map(tokens.map((t) => [t.id, t]))
  let text = ''
  const out: Attachment[] = []
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) text += visible((c as Text).data)
      else if (isTk(c)) {
        const t = byId.get((c as HTMLElement).dataset.tk!)
        if (t && !out.includes(t)) {
          text += TOKEN_CHAR
          out.push(t)
        }
      } else if (c.nodeName === 'BR') {
        if (!isEndBr(c)) text += '\n'
      } else if (c.nodeType === 1) {
        // Блок, вставленный браузером (<div> на новой строке), — с новой строки.
        const block = c.nodeName === 'DIV' || c.nodeName === 'P'
        if (block && text !== '' && !text.endsWith('\n')) text += '\n'
        walk(c)
      }
    }
  }
  walk(root)
  return { text: text.replaceAll('\r', ''), tokens: out }
}

/** Длина узла в символах модели. */
function nodeLen(n: Node): number {
  if (n.nodeType === 3) return visible((n as Text).data).length
  if (isTk(n)) return 1
  if (n.nodeName === 'BR') return isEndBr(n) ? 0 : 1
  let len = 0
  for (let c = n.firstChild; c; c = c.nextSibling) len += nodeLen(c)
  return len
}

/** Позиция модели для точки DOM (node, offset). */
export function modelOffset(root: HTMLElement, node: Node, offset: number): number {
  if (!root.contains(node)) return 0
  // Точка внутри значка — до него или после.
  let tk: Node | null = node
  while (tk && tk !== root && !isTk(tk)) tk = tk.parentNode
  if (tk && tk !== root) return before(root, tk) + (offset > 0 || node !== tk ? 1 : 0)
  if (node.nodeType === 3) return before(root, node) + visible((node as Text).data.slice(0, offset)).length
  let pos = node === root ? 0 : before(root, node)
  for (let i = 0, c = node.firstChild; c && i < offset; i++, c = c.nextSibling) pos += nodeLen(c)
  return pos
}

/** Символов модели до узла n (в порядке документа). */
function before(root: HTMLElement, n: Node): number {
  let pos = 0
  let found = false
  const walk = (p: Node) => {
    for (let c = p.firstChild; c && !found; c = c.nextSibling) {
      if (c === n) {
        found = true
        return
      }
      if (c.contains(n) && !isTk(c)) walk(c)
      else pos += nodeLen(c)
    }
  }
  walk(root)
  return pos
}

/** Точка DOM для позиции модели: первый текстовый узел, внутри которого она лежит. */
export function domPoint(root: HTMLElement, pos: number): { node: Node; offset: number } {
  let count = 0
  let hit: { node: Node; offset: number } | null = null
  const walk = (p: Node): boolean => {
    for (let c = p.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const data = (c as Text).data
        const len = visible(data).length
        if (pos >= count && pos <= count + len) {
          // Отсчитываем видимые символы; U+200B перед позицией пропускаем (курсор — после них).
          let seen = 0
          let i = 0
          while (i < data.length && (seen < pos - count || data[i] === ZWSP)) {
            if (data[i] !== ZWSP) seen++
            i++
          }
          hit = { node: c, offset: i }
          return true
        }
        count += len
      } else if (isTk(c) || c.nodeName === 'BR') {
        if (!isTk(c) && pos === count) {
          hit = { node: p, offset: Array.prototype.indexOf.call(p.childNodes, c) }
          return true
        }
        count += nodeLen(c)
      } else if (c.nodeType === 1 && walk(c)) return true
    }
    return false
  }
  if (walk(root)) return hit!
  // Текстового узла нет (значок последним без ZWSP, пустое поле) — после всех узлов.
  return { node: root, offset: root.childNodes.length }
}

/** Выделение в поле — позициями модели; null — выделение не в поле. */
export function getSelection(root: HTMLElement): { start: number; end: number } | null {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null
  const a = modelOffset(root, r.startContainer, r.startOffset)
  const b = modelOffset(root, r.endContainer, r.endOffset)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

export function setSelection(root: HTMLElement, start: number, end = start): void {
  const sel = root.ownerDocument.getSelection()
  if (!sel) return
  const a = domPoint(root, start)
  const b = end === start ? a : domPoint(root, end)
  const r = root.ownerDocument.createRange()
  r.setStart(a.node, a.offset)
  r.setEnd(b.node, b.offset)
  sel.removeAllRanges()
  sel.addRange(r)
}

/** Текст поля как в модели (значки — TOKEN_CHAR), без списка значков: для проверок и отладки. */
export function domText(root: HTMLElement): string {
  const tokens = Array.from(root.querySelectorAll<HTMLElement>('[data-tk]'), (el) => ({ id: el.dataset.tk!, kind: 'file' as const, label: '' }))
  return readDoc(root, tokens).text
}
