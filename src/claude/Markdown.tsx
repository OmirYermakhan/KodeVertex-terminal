// Режим чтения для ответов Claude: markdown (GFM) → React.
// HTML из текста не исполняется: без rehype-raw react-markdown выводит его как обычный текст.
import { openUrl } from '@tauri-apps/plugin-opener'
import { memo, useRef, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { askOpenLink, linkHost, misleadingText, paneOf } from '../feed/linkAsk'
import { useSettings } from '../settings/store'
import { Diagram } from './diagram/Diagram'
import { rehypeDiff } from './diffBlock'
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
  if (!href || !SAFE_URL.test(href)) return
  // Текст выдаёт себя за другой адрес (`[github.com](https://evil.example)`) — сначала вопрос с настоящим хостом.
  const text = e.currentTarget.textContent ?? ''
  if (misleadingText(text, href)) return askOpenLink(paneOf(e.currentTarget), href, text)
  openUrl(href).catch(() => {})
}

/** Подсказка ссылки — куда она ведёт (хост; для mailto — адрес). */
const linkTitle = (href: string | undefined) => (href && SAFE_URL.test(href) ? linkHost(href) || href : undefined)

/**
 * Своё меню WKWebView у ссылки («Открыть ссылку») открыло бы её в главном окне приложения —
 * у ссылок меню нет.
 */
const noMenu = (e: MouseEvent) => e.preventDefault()

function CodeBlock({ children, note, className }: { children?: ReactNode; note?: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, copyText] = useCopied()
  const copy = () => copyText((ref.current?.textContent ?? '').replace(/\n$/, ''))
  return (
    <div className="md-code">
      <button type="button" className="md-copy" aria-label="Копировать код" onClick={copy}>
        {copied ? 'Скопировано' : 'Копировать'}
      </button>
      <pre ref={ref} className={className}>
        {children}
      </pre>
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
    <a href={href} title={linkTitle(href)} onClick={(e) => onLinkClick(e, href)} onAuxClick={(e) => e.preventDefault()} onContextMenu={noMenu}>
      {children}
    </a>
  ),
  // Картинки не загружаются: запрос по URL из ответа — канал утечки данных. Вместо картинки — ссылка.
  img: ({ src, alt }) => {
    const href = typeof src === 'string' ? src : undefined
    const label = alt ? `Изображение: ${alt}` : 'Изображение'
    return href && SAFE_URL.test(href) ? (
      <a href={href} className="md-img" title={linkTitle(href)} onClick={(e) => onLinkClick(e, href)} onAuxClick={(e) => e.preventDefault()} onContextMenu={noMenu}>
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
      pre: ({ children, node, className }) => {
        const src = diagrams ? mermaidSource(node as HNode | undefined) : undefined
        if (src === undefined) return <CodeBlock className={className}>{children}</CodeBlock>
        // Пока ответ печатается, блок может быть недописан — рисуем после конца ответа.
        if (streaming) return <CodeBlock note="Схема рисуется…">{children}</CodeBlock>
        return <Diagram source={src} />
      },
    }
    COMPONENTS.set(key, c)
  }
  return c
}

type PluggableList = NonNullable<Options['rehypePlugins']>

const REMARK = [remarkGfm]
// Сначала diff (свои строки с подсветкой языка файла, помечены no-highlight), потом остальной код.
const REHYPE: PluggableList = [rehypeDiff, rehypeHighlight]
// Печатающийся хвост: язык diff без имени файла не угадываем на каждый токен; курсор в конце.
const REHYPE_TAIL: PluggableList = [[rehypeDiff, { guess: false }], rehypeHighlight, rehypeCaret]

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(\s|$)/
/** Определение ссылки или сноски (`[x]: url`, `[^1]: …`): действует на весь текст — его не делим. */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m

/**
 * Текст ответа → блоки верхнего уровня, которые разбираются независимо: граница — пустая строка вне
 * ``` перед строкой с начала строки, которая не продолжает предыдущее (не пункт списка — свободный
 * список не рвётся; не отступ — продолжение пункта или код; не ``` — у блока diff подсказка языка
 * в абзаце перед ним). Пока ответ печатается, дописывается только последний блок: готовые не
 * разбираются заново на каждый токен (иначе весь markdown — на каждый токен, O(n²) за ответ).
 */
export function splitBlocks(text: string): string[] {
  if (DEFINITION.test(text)) return [text]
  const lines = text.split('\n')
  const out: string[] = []
  let start = 0
  let fence: string | null = null
  let blank = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (fence !== null) {
      const c = FENCE_CLOSE.exec(l)
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null
      continue
    }
    const open = FENCE_OPEN.exec(l)
    if (blank && l !== '' && !/^\s/.test(l) && !LIST_ITEM.test(l) && !open) {
      out.push(lines.slice(start, i).join('\n'))
      start = i
    }
    if (open) fence = open[1]
    blank = l.trim() === ''
  }
  out.push(lines.slice(start).join('\n'))
  return out
}

/** Готовый блок печатающегося ответа: тот же текст — не разбирается заново. */
const Block = memo(function Block({ text, rehype, components }: { text: string; rehype: PluggableList; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={rehype} components={components}>
      {text}
    </ReactMarkdown>
  )
})

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
  const components = componentsFor(diagrams ?? fromSettings, streaming)
  if (!streaming) {
    // Ответ готов — разбирается один раз целиком (сноски, ссылки и списки — как в исходнике).
    return (
      <div className="md">
        <Block text={text} rehype={REHYPE} components={components} />
      </div>
    )
  }
  const blocks = splitBlocks(text)
  const last = blocks.length - 1
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <Block key={i} text={b} rehype={i === last ? REHYPE_TAIL : REHYPE} components={components} />
      ))}
    </div>
  )
})
