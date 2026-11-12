// Вложения внутри текста сообщения Claude (макет 06-attachments): значок стоит в тексте
// на месте одного символа TOKEN_CHAR. Сообщение — Doc: текст с этими символами + значки по порядку.

/** Символ-заместитель значка в тексте (U+FFFC OBJECT REPLACEMENT CHARACTER). */
export const TOKEN_CHAR = '\ufffc'

export type AttachKind = 'image' | 'pdf' | 'file' | 'folder' | 'block' | 'message' | 'unsupported'

/** Снимок блока терминала в момент вставки (дальше блок может уйти из ленты). */
export interface BlockSnapshot {
  command: string
  exitCode: number | null
  cwd: string
  /** Вывод — текстом, хвост уже обрезан (см. BLOCK_MAX_LINES). */
  output: string
  durationMs: number | null
  at: number
}

/** Снимок сообщения Claude в момент вставки. */
export interface MessageSnapshot {
  author: string
  model?: string | null
  text: string
}

export interface Attachment {
  id: string
  kind: AttachKind
  /** Подпись в значке: «скрин», «Form.tsx», «styles/», «npm test», «Главный: «…»». */
  label: string
  /** Абсолютный путь (файл, папка, картинка, pdf, неподдерживаемый файл). */
  path?: string
  /** Строка в файле (`Form.tsx:42`). */
  line?: number
  size?: number
  width?: number
  height?: number
  /** Миниатюра картинки (data: URL от Rust), 15px в значке. */
  thumb?: string
  /** Почему не уйдёт (неподдерживаемый тип или превышен размер). */
  reason?: string
  block?: BlockSnapshot
  message?: MessageSnapshot
  /** Элемент ленты, из которого взят блок или сообщение (↵ в просмотре — к нему). */
  source?: string
}

/** Текст строки ввода со значками: tokens[i] — i-й TOKEN_CHAR в text. */
export interface Doc {
  text: string
  tokens: Attachment[]
}

export const EMPTY_DOC: Doc = { text: '', tokens: [] }

let seq = 0
export const attachmentId = () => `at-${Date.now().toString(36)}-${++seq}`
