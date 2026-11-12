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

/** Одна пара одинаковых внешних кавычек снимается, только если вся строка — одна строка в кавычках. */
function unquote(s: string): string {
  const q = s[0]
  if (s.length < 2 || (q !== '"' && q !== "'") || s[s.length - 1] !== q) return s
  const inner = s.slice(1, -1)
  // `"a" "b"`, `'it''s'` — несколько строк в кавычках: оставляем как есть.
  if (q === "'" ? inner.includes("'") : /(^|[^\\])"/.test(inner)) return s
  return inner
}

/** Оператор оболочки (|, &, ;, <, >) вне кавычек: это конвейер/перенаправление, а не вопрос. */
function hasShellOperator(s: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '\\') {
      i++
    } else if (quote === '"') {
      if (ch === '"') quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if ('|&;<>'.includes(ch)) {
      return true
    }
  }
  return false
}

/** `--tui` среди ведущих флагов: убрать его. null — флага нет. */
function dropTui(rest: string): string | null {
  for (const m of rest.matchAll(/\S+/g)) {
    const tok = m[0]
    if (!tok.startsWith('-')) break
    if (tok === '--tui') {
      const i = m.index ?? 0
      return (rest.slice(0, i) + rest.slice(i + tok.length)).replace(/^\s+|\s+$/g, '').replace(/\s{2,}/, ' ')
    }
  }
  return null
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
    const args = dropTui(rest)
    if (args === null) return { kind: 'shell', cmd: text }
    return { kind: 'shell', cmd: args ? `claude ${args}` : 'claude' }
  }
  // Конвейер, перенаправление, `&&`, `&` — команда оболочки (вопрос с такими знаками — в кавычках).
  if (hasShellOperator(rest)) return { kind: 'shell', cmd: text }
  if (SUBCOMMANDS.has(first)) return { kind: 'shell', cmd: text }
  return { kind: 'ask', text: unquote(rest) }
}

/** В режиме Claude: `/exit` или `exit` — выйти из режима. */
export function isClaudeExit(text: string): boolean {
  const t = text.trim()
  return t === '/exit' || t === 'exit'
}
