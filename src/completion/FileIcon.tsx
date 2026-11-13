// Монохромные значки видов файлов (inline SVG, currentColor; цвет — токенами темы в global.css).
import { fileKind, type FileKind } from './fileKind'

const PAGE = 'M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13'
const PATHS: Record<FileKind, string> = {
  dir: 'M1.5 4.5a1 1 0 0 1 1-1h3.4l1.4 1.5h5.2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z',
  code: `${PAGE} M7 8 5.8 9.5 7 11 M10 8l1.2 1.5L10 11`,
  script: `${PAGE} M6 8l1.5 1.2L6 10.5 M8.5 11.2h2`,
  web: `${PAGE} M6.3 8 5.3 9.5l1 1.5 M10.7 8l1 1.5-1 1.5`,
  data: `${PAGE} M6.5 8.5h4 M6.5 10.5h4 M6.5 12.5h4`,
  image: `${PAGE} M5.8 12.5l1.8-2.2 1.3 1.4 1-1 1.3 1.8`,
  media: `${PAGE} M7 8.2v3.6l3-1.8z`,
  archive: `${PAGE} M8.5 6.5v1 M7.5 8h2 M8.5 9v1 M7.5 10.5h2`,
  config: `${PAGE} M5.8 9h5.4 M5.8 11.5h5.4`,
  md: `${PAGE} M5.6 12V8.6l1.3 1.5 1.3-1.5V12 M10.6 8.5V12 M9.7 11l.9 1 .9-1`,
  doc: `${PAGE} M6 8.5h5 M6 10.5h5 M6 12.5h3`,
  lock: `${PAGE} M6.8 10.2h3.4v2.3H6.8z M7.5 10.2V9.3a.9.9 0 0 1 1.8 0v.9`,
  binary: `${PAGE} M6 8.2v2.2 M8.5 8.2v2.2 M11 8.2v2.2 M6 12.4v.1 M8.5 12.4v.1`,
  file: PAGE,
}

export function FileIcon({ name, isDir }: { name: string; isDir: boolean }) {
  const kind = fileKind(name, isDir)
  return (
    <svg className={`fi fi-${kind}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d={PATHS[kind]} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
