// `claude` в строке ввода: вместо полноэкранного TUI — наши карточки (режим Claude панели).

export type ClaudeCommand =
  /** `claude` без аргументов: войти в режим Claude. */
  | { kind: 'enter' }
  /** `claude <текст>`: вопрос в сессию панели (и режим Claude). */
  | { kind: 'ask'; text: string }
  /** Обычная команда оболочки (в т. ч. `claude --tui …` → `claude …`). */
  | { kind: 'shell'; cmd: string }

/** Подкоманды CLI `claude` — это не вопросы, а команды оболочки. */
const SUBCOMMANDS = new Set([
  'mcp',
  'config',
  'update',
  'doctor',
  'install',
  'setup-token',
  'migrate-installer',
  'plugin',
  'agents',
])

const TUI_FLAG = /(^|\s+)--tui(?=\s|$)/g

/** Одна пара одинаковых внешних кавычек снимается: `"вопрос"` → `вопрос`. */
function unquote(s: string): string {
  const q = s[0]
  if (s.length >= 2 && (q === '"' || q === "'") && s[s.length - 1] === q) return s.slice(1, -1)
  return s
}

export function parseClaudeCommand(text: string): ClaudeCommand {
  const t = text.trim()
  const m = /^claude(?:\s+([\s\S]*))?$/.exec(t)
  if (!m) return { kind: 'shell', cmd: text }
  const rest = m[1] ?? ''
  if (rest === '') return { kind: 'enter' }
  const first = rest.split(/\s/, 1)[0]
  if (first.startsWith('-')) {
    // `--tui` — запросить настоящий TUI: флаг убираем, остальное — как есть.
    if (/(^|\s)--tui(\s|$)/.test(rest)) {
      const args = rest.replace(TUI_FLAG, ' ').trim()
      return { kind: 'shell', cmd: args ? `claude ${args}` : 'claude' }
    }
    return { kind: 'shell', cmd: text }
  }
  if (SUBCOMMANDS.has(first)) return { kind: 'shell', cmd: text }
  return { kind: 'ask', text: unquote(rest) }
}

/** В режиме Claude: `/exit` или `exit` — выйти из режима. */
export function isClaudeExit(text: string): boolean {
  const t = text.trim()
  return t === '/exit' || t === 'exit'
}
