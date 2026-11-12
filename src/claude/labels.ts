// Подписи для карточек и панели агентов: чистые функции без состояния.

/** 'claude-opus-5-5' → 'Opus 5.5'; неизвестный формат возвращается как есть. */
export function modelLabel(id: string): string {
  const clean = id.replace(/\[[^\]]*\]$/, '')
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(clean)
  if (!m) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return `${family} ${m[2]}.${m[3]}`
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function base(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0]
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function actionTitle(tool: string, input: any): { title: string; detail: string } {
  const i = input && typeof input === 'object' ? input : {}
  switch (tool) {
    case 'Bash':
      return { title: 'Запустил команду', detail: str(i.command) }
    case 'Read':
      return { title: 'Прочитал файл', detail: str(i.file_path) }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return { title: 'Изменил файл', detail: str(i.file_path) }
    case 'Grep':
    case 'Glob':
      return { title: 'Искал', detail: str(i.pattern) }
    case 'WebFetch':
      return { title: 'Открыл страницу', detail: str(i.url) }
    case 'WebSearch':
      return { title: 'Искал в сети', detail: str(i.query) }
    case 'TodoWrite':
      return { title: 'План', detail: '' }
    case 'Task':
    case 'Agent':
      return { title: 'Запустил агента', detail: str(i.description) }
    default:
      return { title: tool, detail: '' }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function nowLabel(tool: string, input: any): string {
  const i = input && typeof input === 'object' ? input : {}
  switch (tool) {
    case 'Bash':
      return `Запускает ${firstLine(str(i.command))}`.trim()
    case 'Read':
      return `Читает ${base(str(i.file_path))}`.trim()
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return `Пишет ${base(str(i.file_path))}`.trim()
    case 'Grep':
    case 'Glob':
      return `Ищет ${str(i.pattern)}`.trim()
    case 'WebFetch':
      return `Открывает ${str(i.url)}`.trim()
    case 'WebSearch':
      return `Ищет в сети ${str(i.query)}`.trim()
    case 'TodoWrite':
      return 'Обновляет план'
    case 'Task':
    case 'Agent':
      return `Запускает агента ${str(i.description)}`.trim()
    case 'AskUserQuestion':
      return 'Ждёт ответа'
    default:
      return `Использует ${tool}`
  }
}
