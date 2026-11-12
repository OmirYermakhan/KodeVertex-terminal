import { describe, expect, it } from 'vitest'
import { TOKEN_CHAR as T, type Attachment, type Doc } from '../attach/types'
import { ZWSP, domPoint, getSelection, modelOffset, readDoc, renderDoc, setSelection } from './richDom'

const tk = (id: string): Attachment => ({ id, kind: 'file', label: `${id}.ts`, path: `/w/${id}.ts` })

function field(doc: Doc, selected: string | null = null) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  renderDoc(root, doc, selected)
  return root
}

describe('DOM поля со значками', () => {
  const doc: Doc = { text: `ab${T}${T}c\n`, tokens: [tk('x'), tk('y')] }

  it('render → read возвращает ту же модель; между значками и после — место для курсора', () => {
    const root = field(doc, 'y')
    expect(readDoc(root, doc.tokens)).toEqual(doc)
    expect(root.querySelectorAll('[data-tk]')).toHaveLength(2)
    expect(root.querySelector('[data-tk="y"]')!.className).toBe('tk sel')
    expect(root.querySelector('[data-tk="x"]')!.getAttribute('contenteditable')).toBe('false')
    // ab | x | ZWSP | y | c\n | <br>
    expect([...root.childNodes].map((n) => (n.nodeType === 3 ? (n as Text).data : n.nodeName))).toEqual(['ab', 'SPAN', ZWSP, 'SPAN', 'c\n', 'BR'])
  })

  it('чтение после правки браузером: набор в узле с U+200B, удалённый значок, вставленный <div>', () => {
    const root = field(doc)
    ;(root.childNodes[2] as Text).data = `${ZWSP}Q`
    root.querySelector('[data-tk="y"]')!.remove()
    expect(readDoc(root, doc.tokens)).toEqual({ text: `ab${T}Qc\n`, tokens: [doc.tokens[0]] })
    const r2 = document.createElement('div')
    r2.innerHTML = 'one<div>two</div>'
    expect(readDoc(r2, []).text).toBe('one\ntwo')
  })

  it('позиции модели ↔ DOM туда и обратно', () => {
    const root = field(doc)
    for (let pos = 0; pos <= doc.text.length; pos++) {
      const p = domPoint(root, pos)
      expect(modelOffset(root, p.node, p.offset)).toBe(pos)
    }
    // После первого значка курсор — в узле U+200B, после него.
    expect(domPoint(root, 3)).toEqual({ node: root.childNodes[2], offset: 1 })
    // Точка внутри значка — до или после него.
    const span = root.querySelector('[data-tk="x"]')!
    expect(modelOffset(root, span, 0)).toBe(2)
    expect(modelOffset(root, span.lastChild!, 1)).toBe(3)
    expect(modelOffset(root, root, 2)).toBe(3)
  })

  it('выделение ставится и читается позициями модели', () => {
    const root = field(doc)
    setSelection(root, 1, 5)
    expect(getSelection(root)).toEqual({ start: 1, end: 5 })
    setSelection(root, 4)
    expect(getSelection(root)).toEqual({ start: 4, end: 4 })
    const empty = field({ text: '', tokens: [] })
    setSelection(empty, 0)
    expect(getSelection(empty)).toEqual({ start: 0, end: 0 })
  })
})
