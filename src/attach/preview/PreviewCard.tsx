// Карточка мини-просмотра (макет 06-attachments `.pv`, галерея В): своя для каждого типа значка.
// Размеры и значки записей — cardLayout.ts. variant: card — всплывающая над значком (~300px); bubble — картинка из пузыря «Вы» (сцена Д,
// 210px, без заголовка); side — справа от выбора `@` (сцена Е, 220px, без подвала).
import { memo, type ReactNode } from 'react'
import { relativize } from '../serialize'
import { iconOf, Icon, Token } from '../tokenView'
import { FileIcon } from '../../completion/FileIcon'
import { BLOCK_TAIL, cardWidth, NAME_PAD, SIDE_LINES, type PreviewVariant } from './cardLayout'
import type { Attachment } from '../types'
import { baseName } from '../classify'
import { formatDuration } from '../../feed/feed'
import { modelLabel } from '../../claude/labels'
import { shortPath } from '../../status/useGitInfo'
import { enterHint } from './actions'
import type { PreviewData } from './api'
import { highlightLines } from './highlight'
import { clock, filesLabel, linesLabel, plainMessage, sizeLabel, sizeParts, wordCount, wordsLabel } from './format'

export interface PreviewCardProps {
  token: Attachment
  /** null — ещё грузится (или загружать нечего: блок, сообщение, неподдерживаемое). */
  data: PreviewData | null
  variant?: PreviewVariant
  /** Значок из строки ввода: в подвале неподдерживаемого — «⌫ убрать». */
  fromInput?: boolean
  cwd?: string | null
  home?: string
}

function iconClass(t: Attachment): string {
  switch (t.kind) {
    case 'folder':
      return 'ico dir'
    case 'pdf':
      return 'ico pdf'
    case 'message':
      return 'ico ai'
    case 'unsupported':
      return 'ico bad'
    case 'block':
      return t.block && t.block.exitCode !== null && t.block.exitCode !== 0 ? 'ico bad' : 'ico ok'
    default:
      return iconOf(t) === 'code' ? 'ico code' : 'ico'
  }
}

function displayPath(path: string, cwd: string | null | undefined, home: string | undefined, dir: boolean): string {
  const rel = relativize(path, cwd)
  const shown = rel === path && home ? shortPath(path, home) : rel
  return dir && !shown.endsWith('/') ? shown + '/' : shown
}

function Head({ t, name, meta, metaBad }: { t: Attachment; name: ReactNode; meta?: ReactNode; metaBad?: boolean }) {
  return (
    <div className="ph">
      <Icon name={iconOf(t)} className={iconClass(t)} />
      <span className="pn">{name}</span>
      {meta !== undefined && meta !== null && meta !== '' && <span className={metaBad ? 'm bad' : 'm'}>{meta}</span>}
    </div>
  )
}

function Foot({ left, hint }: { left?: ReactNode; hint?: string | null }) {
  return (
    <div className="ft">
      {left}
      {hint && <span className="fh">{hint}</span>}
    </div>
  )
}

const Num = ({ n, unit }: { n: string | number; unit: string }) => (
  <span>
    <b>{n}</b> {unit}
  </span>
)

function lineWord(n: number): string {
  return linesLabel(n).replace(/^\d+ /, '')
}

function Muted({ children }: { children: ReactNode }) {
  return <div className="pv-note">{children}</div>
}

/** Окно кода с номерами строк и подсветкой. */
function Code({ start, lines, name }: { start: number; lines: string[]; name: string }) {
  const lit = highlightLines(lines, name)
  const digits = String(start + lines.length - 1).length
  return (
    <pre>
      {lit.map((pieces, i) => (
        <span key={i}>
          <span className="ln" style={digits > 2 ? { width: `${digits + 1}ch` } : undefined}>
            {start + i}
          </span>
          {pieces.map((p, j) =>
            p.cls ? (
              <span key={j} className={p.cls}>
                {p.text}
              </span>
            ) : (
              p.text
            ),
          )}
          {i < lit.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  )
}

function FileCard({ t, data, variant, cwd, home }: { t: Attachment; data: PreviewData | null; variant: PreviewVariant; cwd?: string | null; home?: string }) {
  const side = variant === 'side'
  const name = side ? t.label : displayPath(t.path ?? t.label, cwd, home, false)
  const hint = enterHint(t, data)
  if (data?.kind === 'error') {
    return (
      <>
        <Head t={t} name={name} />
        <div className="body">
          <div className="pv-err">{data.message}</div>
        </div>
      </>
    )
  }
  if (data?.kind === 'binary') {
    return (
      <>
        <Head t={t} name={name} meta={side ? undefined : sizeLabel(data.size)} />
        <div className="body">
          <Muted>Двоичный файл · Claude получит путь</Muted>
        </div>
        {!side && <Foot hint={hint} />}
      </>
    )
  }
  if (data?.kind !== 'text') {
    return (
      <>
        <Head t={t} name={name} />
        <div className="body">
          <Muted>…</Muted>
        </div>
      </>
    )
  }
  const lines = side ? data.lines.slice(0, SIDE_LINES) : data.lines
  const end = data.start + lines.length - 1
  const meta = side ? undefined : t.line && lines.length > 0 ? `строки ${data.start}–${end}` : sizeLabel(data.size)
  const [sz, unit] = sizeParts(data.size)
  return (
    <>
      <Head t={t} name={name} meta={meta} />
      <div className="body">{lines.length > 0 ? <Code start={data.start} lines={lines} name={t.path ?? t.label} /> : <Muted>Пустой файл</Muted>}</div>
      {!side && (
        <Foot
          left={
            <>
              {data.total !== null && <Num n={data.total} unit={lineWord(data.total)} />}
              {t.line ? <Num n={sz} unit={unit} /> : null}
            </>
          }
          hint={hint}
        />
      )}
    </>
  )
}

function ImageCard({ t, data, variant }: { t: Attachment; data: PreviewData | null; variant: PreviewVariant }) {
  const img = data?.kind === 'image' ? data : null
  const w = img?.width ?? t.width
  const h = img?.height ?? t.height
  const dims = w && h ? `${w}×${h}` : ''
  const size = img?.size ?? t.size
  const shot = (
    <div className="shot">
      {img && <img src={img.src} alt="" draggable={false} />}
      {data?.kind === 'error' && <div className="pv-err">{data.message}</div>}
    </div>
  )
  if (variant === 'bubble') {
    return (
      <>
        <div className="body tight">{shot}</div>
        <Foot left={<span>{[t.label, dims].filter(Boolean).join(' · ')}</span>} hint={enterHint(t, data)} />
      </>
    )
  }
  if (variant === 'side') {
    return (
      <>
        <Head t={t} name={t.label} />
        <div className="body">{shot}</div>
      </>
    )
  }
  return (
    <>
      <div className="ph">
        <Token token={t} />
        <span className="m">{[dims, size ? sizeLabel(size) : ''].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="body">{shot}</div>
      <Foot left={<span className="pn">{t.path ? baseName(t.path) : t.label}</span>} hint={enterHint(t, data)} />
    </>
  )
}

function PdfCard({ t, data, variant }: { t: Attachment; data: PreviewData | null; variant: PreviewVariant }) {
  const pdf = data?.kind === 'pdf' ? data : null
  const side = variant === 'side'
  const size = pdf?.size ?? t.size
  const [sz, unit] = size !== undefined ? sizeParts(size) : ['', '']
  return (
    <>
      <Head t={t} name={t.path ? baseName(t.path) : t.label} meta={!side && pdf ? `стр. ${pdf.page} из ${pdf.pages}` : undefined} />
      <div className="body">
        <div className="pdfp">
          {pdf && <img src={pdf.src} alt="" draggable={false} />}
          {data?.kind === 'error' && <div className="pv-err">{data.message}</div>}
        </div>
      </div>
      {!side && <Foot left={size !== undefined ? <Num n={sz} unit={unit} /> : undefined} hint={enterHint(t, data)} />}
    </>
  )
}

function DirCard({ t, data, variant, cwd, home }: { t: Attachment; data: PreviewData | null; variant: PreviewVariant; cwd?: string | null; home?: string }) {
  const side = variant === 'side'
  const name = side ? t.label : displayPath(t.path ?? t.label, cwd, home, true)
  const dir = data?.kind === 'dir' ? data : null
  const shown = dir ? (side ? dir.entries.slice(0, SIDE_LINES) : dir.entries) : []
  return (
    <>
      <Head t={t} name={name} meta={!side && dir ? filesLabel(dir.total) : undefined} />
      <div className="body">
        {data?.kind === 'error' && <div className="pv-err">{data.message}</div>}
        {!data && <Muted>…</Muted>}
        {dir && dir.total === 0 && <Muted>Пустая папка</Muted>}
        {dir && shown.length > 0 && (
          <pre>
            {shown.map((e, i) => {
              const label = e.isDir ? e.name + '/' : e.name
              const extra = e.isDir ? (e.count !== null ? String(e.count) : '') : e.size !== null ? sizeLabel(e.size) : ''
              return (
                <span key={e.name}>
                  <FileIcon name={e.name} isDir={e.isDir} /> {label.padEnd(NAME_PAD)} <span className="dim">{extra}</span>
                  {i < shown.length - 1 || dir.total > shown.length ? '\n' : ''}
                </span>
              )
            })}
            {dir.total > shown.length && <span className="dim">{`  … ещё ${dir.total - shown.length}`}</span>}
          </pre>
        )}
      </div>
      {!side && <Foot left={<span>Claude получит путь</span>} hint={enterHint(t, data)} />}
    </>
  )
}

function BlockCard({ t, variant, home }: { t: Attachment; variant: PreviewVariant; home?: string }) {
  const b = t.block
  const side = variant === 'side'
  if (!b) return <Head t={t} name={t.label} />
  const failed = b.exitCode !== null && b.exitCode !== 0
  const meta = [b.exitCode !== null ? `код ${b.exitCode}` : '', b.durationMs !== null ? formatDuration(b.durationMs) : ''].filter(Boolean).join(' · ')
  const lines = b.output.replace(/\s+$/, '').split('\n')
  const tail = lines.slice(-(side ? SIDE_LINES : BLOCK_TAIL))
  return (
    <>
      <Head t={t} name={b.command} meta={side ? undefined : meta} metaBad={failed} />
      <div className="body">{b.output.trim() ? <pre>{tail.join('\n')}</pre> : <Muted>Без вывода</Muted>}</div>
      {!side && <Foot left={<span>{[home ? shortPath(b.cwd, home) : b.cwd, clock(b.at)].filter(Boolean).join(' · ')}</span>} hint={enterHint(t, null)} />}
    </>
  )
}

/** `код` в тексте сообщения — как в карточке ответа. */
function inlineCode(s: string): ReactNode[] {
  return s.split(/(`[^`\n]+`)/).map((part, i) => (part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part))
}

function MessageCard({ t, variant }: { t: Attachment; variant: PreviewVariant }) {
  const m = t.message
  const side = variant === 'side'
  if (!m) return <Head t={t} name={t.label} />
  const who = m.model ? `${m.author} · ${modelLabel(m.model)}` : m.author
  const text = plainMessage(m.text)
  const words = wordCount(text)
  return (
    <>
      <Head t={t} name={who} />
      <div className={side ? 'body msg side' : 'body msg'}>{inlineCode(text)}</div>
      {!side && <Foot left={<Num n={words} unit={wordsLabel(words).replace(/^\d+ /, '')} />} hint={enterHint(t, null)} />}
    </>
  )
}

function UnsupportedCard({ t, variant, fromInput }: { t: Attachment; variant: PreviewVariant; fromInput?: boolean }) {
  return (
    <>
      <Head t={t} name={t.label} meta={variant !== 'side' && t.size ? sizeLabel(t.size) : undefined} />
      <div className="body">
        <div className="pv-err">{t.reason ?? 'Claude это не примет'}</div>
      </div>
      {variant !== 'side' && <Foot left={<span>Не уйдёт с сообщением</span>} hint={fromInput ? '⌫ убрать' : null} />}
    </>
  )
}

export const PreviewCard = memo(function PreviewCard({ token: t, data, variant = 'card', fromInput, cwd, home }: PreviewCardProps) {
  let body: ReactNode
  switch (t.kind) {
    case 'image':
      body = <ImageCard t={t} data={data} variant={variant} />
      break
    case 'pdf':
      body = <PdfCard t={t} data={data} variant={variant} />
      break
    case 'folder':
      body = <DirCard t={t} data={data} variant={variant} cwd={cwd} home={home} />
      break
    case 'block':
      body = <BlockCard t={t} variant={variant} home={home} />
      break
    case 'message':
      body = <MessageCard t={t} variant={variant} />
      break
    case 'unsupported':
      body = <UnsupportedCard t={t} variant={variant} fromInput={fromInput} />
      break
    default:
      body = <FileCard t={t} data={data} variant={variant} cwd={cwd} home={home} />
  }
  return (
    <div className={`pv pv-${t.kind} pv-${variant}`} style={{ width: cardWidth(t, variant) }} data-pv={t.id}>
      {body}
    </div>
  )
})
