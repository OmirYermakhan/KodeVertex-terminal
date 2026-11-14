import { useCallback, useEffect, useRef, useState } from 'react'
import { gitCommitFiles, gitLog, type Change, type Commit } from './api'
import { ChangeRow, commitSummary, filesWord } from './changeRow'
import { useTakeFocus } from './ChangesView'
import { useProject } from './store'

/** Коммитов за один запрос; следующая страница — при прокрутке к концу. */
export const LOG_PAGE = 100
/** За сколько пикселей до конца списка догружать. */
const NEAR_END_PX = 300
/** Выбор стрелками: файлы коммита запрашиваем, когда выбор задержался (быстрая прокрутка не плодит git show). */
export const FILES_DELAY_MS = 150

const MONTHS = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']
const pad = (n: number) => String(n).padStart(2, '0')
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** Дата коммита по местному времени (макет 07): «сегодня 14:20», «вчера 19:05», «12 нояб.», «12 нояб. 2025». */
export function commitDate(time: number, now: Date): string {
  const d = new Date(time * 1000)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay(d, now)) return `сегодня ${hm}`
  if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `вчера ${hm}`
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`
}

export interface Ref {
  name: string
  head: boolean
}

/** Метки из `%D` git log: «HEAD -> main» → HEAD и main, «tag: v1» → v1. */
export function parseRefs(refs: string[]): Ref[] {
  const out: Ref[] = []
  for (const r of refs) {
    const m = /^HEAD -> (.+)$/.exec(r)
    if (m) {
      out.push({ name: 'HEAD', head: true }, { name: m[1], head: false })
    } else if (r === 'HEAD') out.push({ name: 'HEAD', head: true })
    else out.push({ name: r.replace(/^tag: /, ''), head: false })
  }
  return out
}

/** Строка списка: локальные изменения, коммит, файл раскрытого коммита. */
type Item = { key: string; kind: 'local' } | { key: string; kind: 'commit'; c: Commit } | { key: string; kind: 'file'; c: Commit; f: Change }

const commitKey = (hash: string) => `c:${hash}`
/** Подпись страницы: хэши и метки — та же подпись, значит, перерисовывать нечего. */
const signature = (list: Commit[]) => list.map((c) => `${c.hash}\0${c.refs.join('\0')}`).join('\n')
const fileKey = (hash: string, path: string) => `f:${hash}\0${path}`

export default function GitLog({ now }: { now?: Date }) {
  const root = useProject((s) => s.root)
  const notGit = useProject((s) => s.notGit)
  if (!root || notGit)
    return (
      <div className="log" data-testid="git-log" tabIndex={0}>
        <div className="tree-hint">{notGit ? 'Не git-репозиторий' : 'Папка проекта ещё не известна'}</div>
      </div>
    )
  return <Log key={root} root={root} now={now} />
}

function Log({ root, now }: { root: string; now?: Date }) {
  const host = useRef<HTMLDivElement>(null)
  useTakeFocus(host)
  const changes = useProject((s) => s.changes)
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [files, setFiles] = useState<ReadonlyMap<string, Change[] | string>>(() => new Map())
  const [sel, setSel] = useState<string | null>(null)
  const commitsRef = useRef<Commit[] | null>(null)
  const paging = useRef(false)
  /** Запросы файлов коммитов в пути. */
  const inflight = useRef(new Set<string>())
  const filesRef = useRef(files)
  const expandedRef = useRef(expanded)
  useEffect(() => {
    commitsRef.current = commits
    filesRef.current = files
    expandedRef.current = expanded
  }, [commits, files, expanded])

  const ensureFiles = useCallback(
    (hash: string) => {
      // Уже есть список или запрос в пути — не спрашиваем; ошибка не запоминается: следующий раз — снова.
      if (inflight.current.has(hash) || Array.isArray(filesRef.current.get(hash))) return
      inflight.current.add(hash)
      gitCommitFiles(root, hash).then(
        (list) => {
          inflight.current.delete(hash)
          setFiles((m) => new Map(m).set(hash, list))
        },
        (e) => {
          inflight.current.delete(hash)
          setFiles((m) => new Map(m).set(hash, String(e)))
        },
      )
    },
    [root],
  )

  // Первая страница: при открытии и при каждом обновлении статуса (появился коммит, сдвинулась ветка).
  // Ничего не изменилось — список не трогаем; та же вершина (сменились только метки) — догруженный хвост остаётся.
  useEffect(() => {
    let alive = true
    gitLog(root, 0, LOG_PAGE).then(
      (page) => {
        if (!alive) return
        setError(null)
        // Раскрытые коммиты, чьи файлы не загрузились, — повторить.
        for (const h of expandedRef.current) if (typeof filesRef.current.get(h) === 'string') ensureFiles(h)
        const cur = commitsRef.current
        if (cur && signature(cur.slice(0, page.length)) === signature(page) && (cur.length > 0 || page.length === 0)) return
        let next = page
        if (cur && page.length > 0 && cur.length > page.length && cur[0].hash === page[0].hash) {
          const seen = new Set(page.map((c) => c.hash))
          next = [...page, ...cur.slice(page.length).filter((c) => !seen.has(c.hash))]
        } else setMore(page.length === LOG_PAGE)
        commitsRef.current = next
        setCommits(next)
      },
      (e) => {
        if (!alive) return
        const m = String(e)
        setError(m.includes('not-git') ? 'Не git-репозиторий' : m)
      },
    )
    return () => {
      alive = false
    }
  }, [root, changes, ensureFiles])

  const loadMore = useCallback(() => {
    const cur = commitsRef.current
    if (!cur || paging.current) return
    paging.current = true
    gitLog(root, cur.length, LOG_PAGE).then(
      (page) => {
        paging.current = false
        // Пока грузилось, лог перечитался с начала — эта страница уже не к месту.
        if (commitsRef.current !== cur) return
        // Пока листали, сверху мог появиться коммит — страница начнётся с уже показанных.
        const seen = new Set(cur.map((c) => c.hash))
        const next = [...cur, ...page.filter((c) => !seen.has(c.hash))]
        commitsRef.current = next
        setCommits(next)
        setMore(page.length === LOG_PAGE)
      },
      () => {
        // Ошибка (таймаут) — не конец лога: следующая прокрутка попробует снова.
        paging.current = false
      },
    )
  }, [root])

  // Строка состояния: «хэш · N файла · +a −d» коммита под выбором (или коммита выбранного файла).
  const selHash = sel?.startsWith('c:') ? sel.slice(2) : sel?.startsWith('f:') ? sel.slice(2, sel.indexOf('\0')) : null
  const selCommit = selHash ? commits?.find((c) => c.hash === selHash) : undefined
  const selFiles = selHash ? files.get(selHash) : undefined
  const stat = selCommit && Array.isArray(selFiles) ? commitSummary(selCommit.short, selFiles) : null
  useEffect(() => {
    if (!selHash) return
    const t = setTimeout(() => ensureFiles(selHash), FILES_DELAY_MS)
    return () => clearTimeout(t)
  }, [selHash, ensureFiles])
  useEffect(() => {
    useProject.setState({ commitStat: stat })
  }, [stat])
  useEffect(() => () => useProject.setState({ commitStat: null }), [])

  const local = changes?.length ?? 0
  const items: Item[] = []
  if (local > 0) items.push({ key: 'local', kind: 'local' })
  for (const c of commits ?? []) {
    items.push({ key: commitKey(c.hash), kind: 'commit', c })
    const fl = files.get(c.hash)
    if (expanded.has(c.hash) && Array.isArray(fl)) for (const f of fl) items.push({ key: fileKey(c.hash, f.path), kind: 'file', c, f })
  }

  // Выбранная строка — в видимой области.
  useEffect(() => {
    if (sel === null) return
    const el = [...(host.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((x) => x.dataset.key === sel)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [sel])

  const toggle = (hash: string, open?: boolean) => {
    setExpanded((s) => {
      const want = open ?? !s.has(hash)
      if (want === s.has(hash)) return s
      const n = new Set(s)
      if (want) n.add(hash)
      else n.delete(hash)
      return n
    })
    if (open ?? !expanded.has(hash)) ensureFiles(hash)
  }
  const showChanges = () => useProject.setState({ tool: 'changes' })
  const activate = (it: Item) => {
    if (it.kind === 'local') showChanges()
    else if (it.kind === 'commit') toggle(it.c.hash)
    else useProject.getState().openDiff(it.f.path, it.c.hash, it.f.oldPath)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const i = items.findIndex((it) => it.key === sel)
    const cur = i >= 0 ? items[i] : null
    const go = (it: Item | undefined) => it && setSel(it.key)
    if (e.key === 'ArrowDown') go(items[i < 0 ? 0 : Math.min(items.length - 1, i + 1)])
    else if (e.key === 'ArrowUp') go(items[i < 0 ? items.length - 1 : Math.max(0, i - 1)])
    else if (e.key === 'Home') go(items[0])
    else if (e.key === 'End') go(items[items.length - 1])
    else if (e.key === 'ArrowRight') {
      if (cur?.kind === 'commit') {
        if (!expanded.has(cur.c.hash)) toggle(cur.c.hash, true)
        else if (items[i + 1]?.kind === 'file') go(items[i + 1])
      }
    } else if (e.key === 'ArrowLeft') {
      if (cur?.kind === 'file') setSel(commitKey(cur.c.hash))
      else if (cur?.kind === 'commit' && expanded.has(cur.c.hash)) toggle(cur.c.hash, false)
    } else if (e.key === 'Enter') {
      if (cur) activate(cur)
    } else return
    e.preventDefault()
  }

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (more && el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_END_PX) loadMore()
  }

  const date = now ?? new Date()
  const rows: React.ReactNode[] = []
  if (local > 0)
    rows.push(
      <div
        key="local"
        data-key="local"
        className={sel === 'local' ? 'local sel' : 'local'}
        role="option"
        aria-selected={sel === 'local'}
        onClick={() => {
          setSel('local')
          showChanges()
        }}
      >
        {`● Локальные изменения · ${local} ${filesWord(local)}`}
        <span className="kh">⌥⌘0</span>
      </div>,
    )
  for (const c of commits ?? []) {
    const k = commitKey(c.hash)
    rows.push(
      <div
        key={k}
        data-key={k}
        className={sel === k ? 'cm sel' : 'cm'}
        role="option"
        aria-selected={sel === k}
        aria-expanded={expanded.has(c.hash)}
        title={`${c.subject}\n${c.author} · ${c.short}`}
        onClick={() => {
          setSel(k)
          toggle(c.hash)
        }}
      >
        <span className="gr">
          <i />
        </span>
        <div className="cm-b">
          <div className="msg">{c.subject}</div>
          <div className="meta">
            {parseRefs(c.refs).map((r, j) => (
              <span key={j} className={r.head ? 'ref head' : 'ref'}>
                {r.name}
              </span>
            ))}
            <span className="h">{c.short}</span>
            <span>{commitDate(c.time, date)}</span>
          </div>
        </div>
      </div>,
    )
    if (!expanded.has(c.hash)) continue
    const fl = files.get(c.hash)
    if (fl === undefined) continue
    rows.push(
      <div key={`${k}:files`} className="cfiles" role="group">
        {typeof fl === 'string' ? (
          <div className="tree-hint">{fl}</div>
        ) : (
          fl.map((f) => {
            const fk = fileKey(c.hash, f.path)
            return (
              <div key={fk} data-key={fk}>
                <ChangeRow
                  c={f}
                  sel={sel === fk}
                  onClick={() => {
                    setSel(fk)
                    useProject.getState().openDiff(f.path, c.hash, f.oldPath)
                  }}
                />
              </div>
            )
          })
        )}
      </div>,
    )
  }

  const msg = error ?? (commits && commits.length === 0 ? 'Коммитов ещё нет' : null)
  return (
    <div
      ref={host}
      className="log"
      data-testid="git-log"
      tabIndex={0}
      role="listbox"
      aria-label="Git"
      onKeyDown={onKeyDown}
      onScroll={onScroll}
    >
      {rows}
      {msg && <div className="tree-hint">{msg}</div>}
    </div>
  )
}
