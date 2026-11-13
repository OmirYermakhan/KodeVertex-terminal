// Режим чтения для ответов Claude: markdown (GFM) → React.
// HTML из текста не исполняется: без rehype-raw react-markdown выводит его как обычный текст.
import { openUrl } from '@tauri-apps/plugin-opener'
import { memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

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

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = () => {
    const text = (ref.current?.textContent ?? '').replace(/\n$/, '')
    navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => {})
  }
  return (
    <div className="md-code">
      <button type="button" className="md-copy" aria-label="Копировать код" onClick={copy}>
        {copied ? 'Скопировано' : 'Копировать'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} onClick={(e) => onLinkClick(e, href)} onAuxClick={(e) => e.preventDefault()}>
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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

const REMARK = [remarkGfm]
const REHYPE = [rehypeHighlight]
const REHYPE_STREAMING = [rehypeHighlight, rehypeCaret]

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={streaming ? REHYPE_STREAMING : REHYPE} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
