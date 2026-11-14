// Режим чтения для ответов Claude: markdown (GFM) → React.
// HTML из текста не исполняется: без rehype-raw react-markdown выводит его как обычный текст.
import { openUrl } from '@tauri-apps/plugin-opener'
import { memo, useRef, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { useSettings } from '../settings/store'
import { Diagram } from './diagram/Diagram'
import { useCopied } from './diagram/useCopied'

// Минимальные типы hast: сам пакет типов — транзитивная зависимость.
type HNode = { type: string; tagName?: string; children?: HNode[]; properties?: Record<string, unknown>; value?: string }

/** Блоки, внутрь которых спускается курсор стриминга, чтобы встать после последнего слова. */
const DESCEND = new Set(['ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'pre'])

function lastElement(n: HNode): HNode | undefined {
  const kids = n.children ?? []
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i]
    if (k.type === 'element') return k
    if (k.type === 'text' && k.value?.trim()) return undefined
  }
  return undefined
}

/** Пустые элементы HTML: детей у них не бывает (React падает с #137) — курсор ставится после них. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

/** rehype-плагин: мигающий курсор в конце текста. */
function rehypeCaret() {
  return (tree: HNode) => {
    let n: HNode = tree
    for (;;) {
      const last = lastElement(n)
      if (!last || VOID.has(last.tagName ?? '')) break
      n = last
      if (!DESCEND.has(last.tagName ?? '')) break
    }
    n.children = [...(n.children ?? []), { type: 'element', tagName: 'span', properties: { className: ['caret'] }, children: [] }]
  }
}

const SAFE_URL = /^(https?:|mailto:)/i

function onLinkClick(e: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
  // Ссылки не открываются внутри окна приложения — только в системном браузере
  // (обычный клик и ⌘-клик одинаково; средний клик гасится в onAuxClick).
  e.preventDefault()
  if (href && SAFE_URL.test(href)) openUrl(href).catch(() => {})
}

function CodeBlock({ children, note }: { children?: ReactNode; note?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, copyText] = useCopied()
  const copy = () => copyText((ref.current?.textContent ?? '').replace(/\n$/, ''))
  return (
    <div className="md-code">
      <button type="button" className="md-copy" aria-label="Копировать код" onClick={copy}>
        {copied ? 'Скопировано' : 'Копировать'}
      </button>
      <pre ref={ref}>{children}</pre>
      {note && <div className="dg-note">{note}</div>}
    </div>
  )
}

function textOf(n: HNode): string {
  return n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join('')
}

/** Исходник блока ```mermaid (pre > code.language-mermaid) или undefined. */
function mermaidSource(pre: HNode | undefined): string | undefined {
  const code = pre?.children?.find((k) => k.type === 'element')
  if (code?.tagName !== 'code') return undefined
  const cls = code.properties?.className
  if (!Array.isArray(cls) || !cls.includes('language-mermaid')) return undefined
  return textOf(code).replace(/\n$/, '')
}

const base: Components = {
  a: ({ href, children }) => (
    <a href={href} onClick={(e) => onLinkClick(e, href)} onAuxClick={(e) => e.preventDefault()}>
      {children}
    </a>
  ),
  // Картинки не загружаются: запрос по URL из ответа — канал утечки данных. Вместо картинки — ссылка.
  img: ({ src, alt }) => {
    const href = typeof src === 'string' ? src : undefined
    const label = alt ? `Изображение: ${alt}` : 'Изображение'
    return href && SAFE_URL.test(href) ? (
      <a href={href} className="md-img" onClick={(e) => onLinkClick(e, href)} onAuxClick={(e) => e.preventDefault()}>
        {label}
      </a>
    ) : (
      <span className="md-img">{label}</span>
    )
  },
}

/** Наборы компонентов по (схемы, стриминг) — постоянные ссылки, чтобы react-markdown не пересоздавал дерево. */
const COMPONENTS = new Map<string, Components>()

function componentsFor(diagrams: boolean, streaming: boolean): Components {
  const key = `${diagrams}/${streaming}`
  let c = COMPONENTS.get(key)
  if (!c) {
    c = {
      ...base,
      pre: ({ children, node }) => {
        const src = diagrams ? mermaidSource(node as HNode | undefined) : undefined
        if (src === undefined) return <CodeBlock>{children}</CodeBlock>
        // Пока ответ печатается, блок может быть недописан — рисуем после конца ответа.
        if (streaming) return <CodeBlock note="Схема рисуется…">{children}</CodeBlock>
        return <Diagram source={src} />
      },
    }
    COMPONENTS.set(key, c)
  }
  return c
}

const REMARK = [remarkGfm]
const REHYPE = [rehypeHighlight]
const REHYPE_STREAMING = [rehypeHighlight, rehypeCaret]

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  diagrams,
}: {
  text: string
  streaming?: boolean
  /** Схемы mermaid картинкой; по умолчанию — переключатель «Схемы картинкой» из настроек. */
  diagrams?: boolean
}) {
  const fromSettings = useSettings((s) => s.settings.claudeDiagrams)
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={streaming ? REHYPE_STREAMING : REHYPE}
        components={componentsFor(diagrams ?? fromSettings, streaming)}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
