import type { ReactNode } from 'react'

/** Расширение → класс цвета (макет 07 `.fi.*`). Буква — первая буква расширения. */
const LANG: Record<string, string> = {
  kt: 'kt',
  xml: 'xml',
  md: 'md',
  ts: 'ts',
  tsx: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  rs: 'rs',
  json: 'json',
  py: 'py',
  java: 'java',
  swift: 'swift',
  go: 'go',
}

/** Значок файла (макет 07): K — Kotlin, G — Gradle, X — XML, M — Markdown, ≡ — прочее. */
export function fileIcon(name: string): ReactNode {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  let cls = 'txt'
  let letter = '≡'
  if (ext === 'kts' || ext === 'gradle') {
    cls = 'gr'
    letter = 'G'
  } else if (LANG[ext]) {
    cls = LANG[ext]
    letter = ext[0].toUpperCase()
  }
  return <span className={`fi pfi ${cls}`}>{letter}</span>
}

/** Цвет папки: корни исходников — синие (`src/main/java`), ресурсы — жёлтые (`res`), прочие — серые. */
export function folderKind(rel: string): '' | 'src' | 'res' {
  if (rel === 'src' || /(^|\/)src\/[^/]+\/(java|kotlin)$/.test(rel)) return 'src'
  if (/(^|\/)res$/.test(rel) || /(^|\/)src\/[^/]+\/resources$/.test(rel)) return 'res'
  return ''
}

export function folderIcon(rel: string): ReactNode {
  const k = folderKind(rel)
  return <span className={k ? `fold ${k}` : 'fold'} />
}
