// Чистая логика дополнения путей: разбор отчётов zsh, контекст, ранжирование.

export type ZleReport = { cursor: number; buffer: string } | 'end'

export const PATH_COMMANDS: readonly string[] = [
  'cd', 'ls', 'cat', 'less', 'vim', 'nvim', 'nano', 'code', 'open',
  'cp', 'mv', 'rm', 'mkdir', 'touch', 'tail', 'head', 'bat', 'source',
]

export interface CompletionContext {
  command: string
  /** Индекс начала токена в buffer (UTF-16). */
  tokenStart: number
  /** Сырой токен как набран (с кавычками и экранированием). */
  token: string
  dirPart: string
  namePart: string
  dirsOnly: boolean
  includeHidden: boolean
}

/** Данные OSC 6973: `<cursor>;<buffer>` или `-`. Делится по первой `;`. */
export function parseOsc6973(data: string): ZleReport | null {
  if (data === '-') return 'end'
  const i = data.indexOf(';')
  if (i < 0) return null
  const head = data.slice(0, i)
  if (!/^\d+$/.test(head)) return null
  return { cursor: Number(head), buffer: data.slice(i + 1) }
}

/** Разбор до курсора: границы слов и значение последнего токена без кавычек/экранирования. */
function scan(text: string): { starts: number[]; value: string; inToken: boolean; multi: boolean } {
  const starts: number[] = []
  let value = ''
  let quote: '"' | "'" | null = null
  let inToken = false
  let multi = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (!inToken && (quote !== null || (ch !== ' ' && ch !== '\t'))) {
      starts.push(i)
      inToken = true
      value = ''
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      else value += ch
    } else if (ch === '\\' && i + 1 < text.length) {
      value += text[++i]
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else value += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === ' ' || ch === '\t') {
      inToken = false
      value = ''
    } else {
      if (ch === ';' || ch === '|' || ch === '&') multi = true
      value += ch
    }
  }
  if (!inToken) value = ''
  return { starts, value, inToken, multi }
}

/** cursor — индекс в code points (как в zsh). */
export function completionContext(buffer: string, cursor: number): CompletionContext | null {
  const chars = [...buffer]
  if (cursor < 0 || cursor > chars.length) return null
  const idx = chars.slice(0, cursor).join('').length
  const before = buffer.slice(0, idx)
  const after = buffer.slice(idx)
  if (after.trim() !== '') return null

  const { starts, value, inToken, multi } = scan(before)
  if (multi || starts.length === 0) return null
  const command = before.slice(starts[0]).split(/[ \t]/, 1)[0]
  if (!PATH_COMMANDS.includes(command)) return null

  // Первое слово — команда; аргумент начинается после хотя бы одного пробела.
  let tokenStart = idx
  let token = ''
  let name = ''
  if (inToken) {
    if (starts.length < 2) return null
    tokenStart = starts[starts.length - 1]
    token = before.slice(tokenStart)
    name = value
  }
  if (name.startsWith('-')) return null

  const slash = name.lastIndexOf('/')
  const dirPart = name.slice(0, slash + 1)
  const namePart = name.slice(slash + 1)
  return {
    command,
    tokenStart,
    token,
    dirPart,
    namePart,
    dirsOnly: command === 'cd',
    includeHidden: namePart.startsWith('.'),
  }
}

function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/** Абсолютный каталог для поиска по dirPart. */
export function resolveDir(dirPart: string, cwd: string, home: string): string {
  if (dirPart === '') return normalize(cwd)
  if (dirPart === '~' || dirPart.startsWith('~/')) return normalize(home + '/' + dirPart.slice(1))
  if (dirPart.startsWith('/')) return normalize(dirPart)
  return normalize(cwd + '/' + dirPart)
}

/** Больше — лучше; null — не подходит. */
export function fuzzyScore(query: string, name: string): number | null {
  if (query === '') return 0
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  const at = n.indexOf(q)
  if (at === 0) return 3000 - Math.min(n.length, 999)
  if (at > 0) return 2000 - Math.min(at * 10 + n.length, 999)
  let pos = -1
  let first = -1
  for (const ch of q) {
    pos = n.indexOf(ch, pos + 1)
    if (pos < 0) return null
    if (first < 0) first = pos
  }
  return 1000 - Math.min(pos - first + n.length, 999)
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/

export function rankEntries<T extends { name: string; isDir: boolean }>(
  q: string,
  items: T[],
  limit = 50,
): T[] {
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    // Управляющие символы в имени попали бы в ZLE как нажатия клавиш.
    if (CONTROL_CHARS.test(item.name)) continue
    const score = fuzzyScore(q, item.name)
    if (score !== null) scored.push({ item, score })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.item.isDir !== b.item.isDir) return a.item.isDir ? -1 : 1
    return a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0
  })
  return scored.slice(0, limit).map((s) => s.item)
}

export function shellEscape(name: string): string {
  let out = ''
  let first = true
  for (const ch of name) {
    // '=' в начале слова zsh раскрывает как =cmd.
    if (first && ch === '=') {
      out += '\\='
      first = false
      continue
    }
    first = false
    out += /[A-Za-z0-9._\-/+,@%=:]/.test(ch) || /[\p{L}\p{N}\p{M}]/u.test(ch) ? ch : '\\' + ch
  }
  return out
}

/**
 * Байты для PTY: стереть набранный токен и вписать выбранную запись.
 * Число DEL считается по code points (zsh без COMBINING_CHARS, по умолчанию).
 */
export function applyCompletion(
  ctx: CompletionContext,
  entry: { name: string; isDir: boolean },
): string {
  // Ведущие - + = без каталога стали бы опцией, стеком каталогов или =cmd.
  const name = ctx.dirPart === '' && /^[-+=]/.test(entry.name) ? './' + entry.name : entry.name
  const full = ctx.dirPart + name
  // '~' остаётся неэкранированной только как домашний каталог в самом токене.
  const keepTilde = ctx.dirPart === '~' || ctx.dirPart.startsWith('~/')
  const escaped = keepTilde ? '~' + shellEscape(full.slice(1)) : shellEscape(full)
  return '\x7f'.repeat([...ctx.token].length) + escaped + (entry.isDir ? '/' : '')
}
