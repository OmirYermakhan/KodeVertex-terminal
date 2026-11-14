import type { Change } from './api'
import { fileIcon } from './fileIcon'
import { STATUS } from './store'

/** Склонение по числу: 1 файл, 2 файла, 5 файлов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

export const filesWord = (n: number) => plural(n, 'файл', 'файла', 'файлов')

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** Серый каталог строки (макет 07 `.ch .dir`): до трёх папок — целиком, длиннее — «первая/…/последняя». */
export function shortDir(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.length > 3 ? `${parts[0]}/…/${parts[parts.length - 1]}` : parts.join('/')
}

/** Счётчик справа (макет 07 `.ch .st`): «+a −d» без нулевых частей; неотслеживаемый — «новый». */
export function statText(c: Change): string {
  if (c.status === '?') return 'новый'
  const out: string[] = []
  if (c.add) out.push(`+${c.add}`)
  if (c.del) out.push(`−${c.del}`)
  return out.join(' ')
}

export function sumStat(changes: Change[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const c of changes) {
    add += c.add ?? 0
    del += c.del ?? 0
  }
  return { add, del }
}

/** Строка состояния при открытой панели (макет 07): «N изменено · M новый»; изменений нет — null. */
export function localSummary(changes: Change[] | null): string | null {
  if (!changes?.length) return null
  const fresh = changes.filter((c) => c.status === '?').length
  const tracked = changes.length - fresh
  const out: string[] = []
  if (tracked) out.push(`${tracked} изменено`)
  if (fresh) out.push(`${fresh} ${plural(fresh, 'новый', 'новых', 'новых')}`)
  return out.join(' · ')
}

/** Строка состояния окна «Git» (макет 07): «a41c9e2 · 3 файла · +146 −1». */
export function commitSummary(short: string, files: Change[]): string {
  const { add, del } = sumStat(files)
  return `${short} · ${files.length} ${filesWord(files.length)} · +${add} −${del}`
}

/** Строка файла в «Изменениях» и в файлах коммита (макет 07 `.ch`): значок, имя цветом статуса, каталог, счётчик. */
export function ChangeRow({ c, sel, onClick }: { c: Change; sel: boolean; onClick: () => void }) {
  const dir = shortDir(c.path)
  const title = c.oldPath ? `${c.oldPath} → ${c.path}` : c.path
  return (
    <div
      className={['ch', STATUS[c.status], sel && 'sel'].filter(Boolean).join(' ')}
      role="option"
      aria-selected={sel}
      title={title}
      data-path={c.path}
      onClick={onClick}
    >
      {fileIcon(baseName(c.path))}
      <span className="nm">{baseName(c.path)}</span>
      {dir && <span className="dir">{dir}</span>}
      <span className="st">{statText(c)}</span>
    </div>
  )
}
