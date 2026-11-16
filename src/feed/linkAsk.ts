// Ссылки, которые открываются только после вопроса «? Открыть ссылку» над строкой ввода панели:
// OSC 8 из терминала (текст ссылки задаёт программа — адрес не виден) и ссылки ответа, чей текст
// выглядит адресом другого сайта (`[github.com](https://evil.example)`).
import { openUrl } from '@tauri-apps/plugin-opener'
import { create } from 'zustand'
import { useTabs } from '../layout/tabsStore'

export interface LinkAsk {
  url: string
  host: string
  /** Текст ссылки, если он выдаёт себя за другой адрес. */
  text?: string
}

export const useLinkAsk = create<{ asks: Record<string, LinkAsk> }>(() => ({ asks: {} }))

/** Хост ссылки (для mailto — адрес); не разбирается — пусто. */
export function linkHost(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'mailto:') return u.pathname
    return u.host
  } catch {
    return ''
  }
}

const bare = (h: string) => h.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')

/** Текст «похож на адрес»: необязательная схема, домен с зоной из букв, дальше — путь или ничего. */
const URLISH = /^(?:[a-z][\w+.-]*:\/\/)?((?:[^\s/?#:@.]+\.)+[^\s/?#:@.\d][^\s/?#:@.]+)(?::\d+)?(?:[/?#]\S*)?$/iu

/** Расширения файлов, похожие на доменные зоны. */
const FILE_EXT = new Set(['md', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'txt', 'py', 'rs', 'toml', 'yaml', 'yml', 'lock', 'html', 'css', 'sh', 'go', 'kt', 'java', 'cpp', 'swift', 'rb', 'log', 'csv', 'xml', 'png', 'jpg', 'svg', 'pdf', 'zip', 'env'])

/**
 * Текст ссылки выглядит адресом или доменом, а ведёт она на другой хост. Поддомен показанного
 * (`github.com` → `docs.github.com`) — тот же сайт.
 */
export function misleadingText(text: string, href: string): boolean {
  const t = text.trim()
  const m = URLISH.exec(t)
  if (!m) return false
  // Без схемы `README.md`, `package.json` — имена файлов, а не домены.
  const zone = m[1].slice(m[1].lastIndexOf('.') + 1).toLowerCase()
  if (!/^[a-z][\w+.-]*:\/\//i.test(t) && FILE_EXT.has(zone)) return false
  const real = linkHost(href)
  if (!real) return true
  let shown: string
  try {
    // Через URL: домен из текста в той же форме, что у ссылки (IDN → punycode, регистр).
    shown = new URL(`http://${m[1]}`).host
  } catch {
    return true
  }
  const a = bare(shown)
  const b = bare(real)
  return !(a === b || b.endsWith(`.${a}`))
}

/** Панель, в которой спросить: та, где щёлкнули, иначе панель в фокусе активной вкладки. */
export function paneOf(el: Element | null): string {
  const id = el?.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId
  if (id) return id
  const { tabs, active } = useTabs.getState()
  return tabs.find((t) => t.id === active)?.focused ?? ''
}

/** Спросить перед открытием ссылки (блок над строкой ввода панели). */
export function askOpenLink(paneId: string, url: string, text?: string): void {
  const ask: LinkAsk = { url, host: linkHost(url) || url, ...(text ? { text } : {}) }
  useLinkAsk.setState((st) => ({ asks: { ...st.asks, [paneId]: ask } }))
}

/** Ответ на «? Открыть ссылку»: «Открыть» — в системном браузере. */
export function answerLink(paneId: string, ok: boolean): void {
  const ask = useLinkAsk.getState().asks[paneId]
  if (!ask) return
  useLinkAsk.setState((st) => {
    const asks = { ...st.asks }
    delete asks[paneId]
    return { asks }
  })
  if (ok) openUrl(ask.url).catch((err: unknown) => console.error('openUrl failed:', err))
}
