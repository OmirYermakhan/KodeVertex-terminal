import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { projectList, type Change, type DirEntry, type DirList } from './api'
import { fileIcon, folderIcon } from './fileIcon'
import { STATUS, useProject, type VcsClass } from './store'

/** Отступ уровня дерева (макет 07): корень — 6px, каждый уровень +16px. */
const INDENT0 = 6
const INDENT = 16
/** Пауза набора, после которой поиск по буквам начинается заново. */
const TYPE_RESET_MS = 1000

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
/** Порядок как у project_list: папки первыми, затем файлы, без учёта регистра. */
const byName = (a: DirEntry, b: DirEntry) => {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}
/** Домашний каталог → «~» для серой подписи корня. */
const tildify = (p: string) => p.replace(/^(\/Users|\/home)\/[^/]+(?=\/|$)/, '~')
/** Внутри корня исходников Java/Kotlin цепочка папок — пакет через точку (`com.shop.payments`). */
const inSourceRoot = (rel: string) => /(^|\/)src\/[^/]+\/(java|kotlin)(\/|$)/.test(rel)

/** Поиск по изменениям, построенный один раз на список: статус файла, папки с изменениями, удалённые. */
interface Vcs {
  status: Map<string, VcsClass>
  dirs: Set<string>
  /** Каталог → удалённые прямые потомки (файлы и целиком удалённые папки — их нет на диске). */
  deleted: Map<string, Map<string, boolean>>
}

function buildVcs(changes: Change[] | null): Vcs {
  const vcs: Vcs = { status: new Map(), dirs: new Set(), deleted: new Map() }
  for (const c of changes ?? []) {
    vcs.status.set(c.path, STATUS[c.status])
    const parts = c.path.split('/')
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      vcs.dirs.add(dir)
      if (c.status !== 'D') continue
      let m = vcs.deleted.get(dir)
      if (!m) vcs.deleted.set(dir, (m = new Map()))
      const isDir = i < parts.length - 1
      m.set(parts[i], (m.get(parts[i]) ?? false) || isDir)
    }
  }
  return vcs
}

/** Содержимое каталога: с диска плюс удалённые (их на диске нет) на своих местах по порядку. */
function childrenOf(rel: string, v: Vcs, ls: Map<string, DirList>): DirEntry[] | null {
  const l = ls.get(rel)
  if (!l) return null
  const del = v.deleted.get(rel)
  if (!del) return l.entries
  const have = new Set(l.entries.map((e) => e.name))
  const extra = [...del].filter(([n]) => !have.has(n)).map(([name, isDir]) => ({ name, isDir }))
  return extra.length ? [...l.entries, ...extra].sort(byName) : l.entries
}

/** Папка из одной папки (не корень, без «ещё N») — путь этой папки: её раскрываем сразу, цепочка — одной строкой. */
function onlyChild(rel: string, v: Vcs, ls: Map<string, DirList>): string | null {
  if (!rel || (ls.get(rel)?.more ?? 0) > 0) return null
  const kids = childrenOf(rel, v, ls)
  return kids?.length === 1 && kids[0].isDir ? join(rel, kids[0].name) : null
}

/** Настоящий корень исходников Java/Kotlin — на нём цепочка папок кончается (корневой `src` — нет). */
const isSourceRoot = (rel: string) => /(^|\/)src\/[^/]+\/(java|kotlin)$/.test(rel)

interface Row {
  /** Ключ выбора: путь папки, которую строка раскрывает (у цепочки — верхней), файла; корень — ''. */
  key: string
  /** Путь, чьё содержимое под строкой (у цепочки — нижняя папка). */
  rel: string
  parent: string | null
  depth: number
  label: string
  kind: 'root' | 'dir' | 'file' | 'more'
  open: boolean
  cls: string
}

/** Окно инструмента открылось с фокусом на себе — фокус в дерево, чтобы стрелки работали сразу. */
function useTakeFocus(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement === el.closest('.tw')) el.focus()
  }, [ref])
}

export default function ProjectTree() {
  const root = useProject((s) => s.root)
  return root ? <Tree key={root} root={root} /> : <NoRoot />
}

function NoRoot() {
  const ref = useRef<HTMLDivElement>(null)
  useTakeFocus(ref)
  return (
    <div ref={ref} className="tree" data-testid="project-tree" tabIndex={0}>
      <div className="tree-hint">Папка проекта ещё не известна</div>
    </div>
  )
}

function Tree({ root }: { root: string }) {
  const host = useRef<HTMLDivElement>(null)
  useTakeFocus(host)
  const changes = useProject((s) => s.changes)
  const openFile = useProject((s) => s.openFile)
  const vcs = useMemo(() => buildVcs(changes), [changes])
  const [lists, setLists] = useState<Map<string, DirList>>(() => new Map())
  // Раскрытые папки и выбор живут в сторе (свои у корня): окно размонтируется при смене инструмента.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => useProject.getState().treeExpanded)
  const [sel, setSel] = useState<string | null>(() => useProject.getState().treeSel)
  useEffect(() => useProject.setState({ treeExpanded: expanded, treeSel: sel }), [expanded, sel])
  const typed = useRef({ text: '', at: 0 })
  const reqs = useRef(new Map<string, number>())
  // Копии состояния для асинхронных ответов project_list; меняются вместе с setState.
  const vcsRef = useRef(vcs)
  useLayoutEffect(() => {
    vcsRef.current = vcs
  }, [vcs])
  const expandedRef = useRef(expanded)
  const listsRef = useRef(lists)

  /** Ответ project_list; ошибка (каталога нет — удалён целиком, или не читается) — пусто, удалённые добавятся сами. */
  const fetchDir = useCallback(
    (rel: string) => projectList(root, rel).catch((): DirList => ({ entries: [], more: 0 })),
    [root],
  )

  const load = useCallback(
    (top: string) => {
      const loadDir = (rel: string) => {
        const id = (reqs.current.get(rel) ?? 0) + 1
        reqs.current.set(rel, id)
        fetchDir(rel).then((l) => {
          if (reqs.current.get(rel) !== id) return
          const next = new Map(listsRef.current).set(rel, l)
          listsRef.current = next
          setLists(next)
          const c = onlyChild(rel, vcsRef.current, next)
          if (c !== null && !expandedRef.current.has(c)) {
            const ex = new Set(expandedRef.current).add(c)
            expandedRef.current = ex
            setExpanded(ex)
            loadDir(c)
          }
        })
      }
      loadDir(top)
    },
    [fetchDir],
  )

  // Сначала корень, затем всё, что было раскрыто до размонтирования.
  useEffect(() => {
    for (const rel of new Set(['', ...expandedRef.current])) load(rel)
  }, [load])

  // Изменился набор путей и статусов — перечитать все раскрытые папки и применить одним обновлением
  // (файлы могли появиться и исчезнуть). Та же картина в новой ссылке — ничего не делаем.
  // Вне git изменений нет — перечитываем на каждый ответ обновления (tick), иначе новые файлы не видны.
  const notGit = useProject((s) => s.notGit)
  const tick = useProject((s) => (s.notGit ? s.tick : 0))
  const pathsKey = useMemo(() => (changes ?? []).map((c) => `${c.status}\0${c.path}`).join('\n'), [changes])
  const changesKey = notGit ? `\0tick${tick}` : pathsKey
  const lastKey = useRef(changesKey)
  useEffect(() => {
    if (changesKey === lastKey.current) return
    lastKey.current = changesKey
    const dirs = [...expandedRef.current].filter((rel) => listsRef.current.has(rel))
    const ids = dirs.map((rel) => {
      const id = (reqs.current.get(rel) ?? 0) + 1
      reqs.current.set(rel, id)
      return id
    })
    Promise.all(dirs.map(fetchDir)).then((got) => {
      const next = new Map(listsRef.current)
      let changed = false
      got.forEach((l, i) => {
        if (reqs.current.get(dirs[i]) !== ids[i]) return
        next.set(dirs[i], l)
        changed = true
      })
      if (!changed) return
      listsRef.current = next
      setLists(next)
      // Как при раскрытии: папка стала «из одной папки» — раскрыть и её, чтобы цепочка шла одной строкой.
      const add = dirs
        .map((rel) => onlyChild(rel, vcsRef.current, next))
        .filter((c): c is string => c !== null && !expandedRef.current.has(c))
      if (!add.length) return
      const ex = new Set(expandedRef.current)
      for (const c of add) ex.add(c)
      expandedRef.current = ex
      setExpanded(ex)
      for (const c of add) load(c)
    })
  }, [changesKey, fetchDir, load])

  const toggle = (key: string) => {
    const ex = new Set(expandedRef.current)
    if (ex.has(key)) {
      ex.delete(key)
      // Выбранная строка ушла внутрь свёрнутой папки — выбор на саму папку.
      setSel((s) => (s !== null && s !== key && (key === '' || s.startsWith(key + '/')) ? key : s))
    } else {
      ex.add(key)
      load(key)
    }
    expandedRef.current = ex
    setExpanded(ex)
  }

  const rows = useMemo(() => {
    const out: Row[] = []
    const name = root.replace(/\/+$/, '').split('/').pop() || root
    const rootOpen = expanded.has('')
    out.push({
      key: '',
      rel: '',
      parent: null,
      depth: 0,
      label: name,
      kind: 'root',
      open: rootOpen,
      cls: vcs.dirs.has('') ? 'dirm' : '',
    })
    const walk = (dir: string, parentKey: string, depth: number) => {
      const kids = childrenOf(dir, vcs, lists)
      if (!kids) return
      for (const e of kids) {
        const top = join(dir, e.name)
        const gone = vcs.deleted.get(dir)?.has(e.name) && !lists.get(dir)?.entries.some((x) => x.name === e.name)
        if (!e.isDir) {
          out.push({
            key: top,
            rel: top,
            parent: parentKey,
            depth,
            label: e.name,
            kind: 'file',
            open: false,
            cls: vcs.status.get(top) ?? '',
          })
          continue
        }
        const open = expanded.has(top)
        let cur = top
        const parts = [e.name]
        if (open) {
          // Цепочка папок по одной — одной строкой, пока следующая раскрыта.
          for (;;) {
            const k = childrenOf(cur, vcs, lists)
            // Корень исходников (`src/main/java`) — конец цепочки: пакеты ниже начинают свою.
            if (isSourceRoot(cur)) break
            if (!k || k.length !== 1 || !k[0].isDir || (lists.get(cur)?.more ?? 0) > 0) break
            const next = join(cur, k[0].name)
            if (!expanded.has(next)) break
            parts.push(k[0].name)
            cur = next
          }
        }
        const label = parts.join(inSourceRoot(dir) ? '.' : '/')
        const cls = gone ? 'del' : vcs.dirs.has(cur) ? 'dirm' : ''
        out.push({
          key: top,
          rel: cur,
          parent: parentKey,
          depth,
          label,
          kind: 'dir',
          open,
          cls,
        })
        if (open) walk(cur, top, depth + 1)
      }
      const more = lists.get(dir)?.more ?? 0
      if (more > 0)
        out.push({
          key: `${dir}\0more`,
          rel: dir,
          parent: parentKey,
          depth,
          label: `ещё ${more}`,
          kind: 'more',
          open: false,
          cls: 'more',
        })
    }
    if (rootOpen) walk('', '', 1)
    return out
  }, [root, expanded, lists, vcs])

  // Выбранная строка — в видимой области.
  useEffect(() => {
    if (sel === null) return
    const el = [...(host.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((x) => x.dataset.key === sel)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [sel])

  const activate = (r: Row) => {
    if (r.kind === 'file') openFile(r.rel)
    else if (r.kind !== 'more') toggle(r.key)
  }

  const nav = rows.filter((r) => r.kind !== 'more')
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const i = nav.findIndex((r) => r.key === sel)
    const cur = i >= 0 ? nav[i] : null
    const go = (r: Row | undefined) => r && setSel(r.key)
    let handled = true
    if (e.key === 'ArrowDown') go(nav[i < 0 ? 0 : Math.min(nav.length - 1, i + 1)])
    else if (e.key === 'ArrowUp') go(nav[i < 0 ? nav.length - 1 : Math.max(0, i - 1)])
    else if (e.key === 'Home') go(nav[0])
    else if (e.key === 'End') go(nav[nav.length - 1])
    else if (e.key === 'ArrowRight') {
      if (cur && cur.kind !== 'file') {
        if (!cur.open) toggle(cur.key)
        else if (nav[i + 1]?.parent === cur.key) go(nav[i + 1])
      }
    } else if (e.key === 'ArrowLeft') {
      if (cur && cur.kind !== 'file' && cur.open) toggle(cur.key)
      else if (cur && cur.parent !== null) go(nav.find((r) => r.key === cur.parent))
    } else if (e.key === 'Enter') {
      if (cur) activate(cur)
    } else if (e.key.length === 1 && e.key !== ' ') {
      // Набор букв — переход к первому совпадению по имени (как speed search в AS).
      const t = typed.current
      t.text = (e.timeStamp - t.at > TYPE_RESET_MS ? '' : t.text) + e.key.toLowerCase()
      t.at = e.timeStamp
      const hit =
        nav.find((r) => r.label.toLowerCase().startsWith(t.text)) ??
        nav.find((r) => r.label.toLowerCase().includes(t.text))
      go(hit)
      e.preventDefault()
      return
    } else handled = false
    if (handled) {
      typed.current.text = ''
      e.preventDefault()
    }
  }

  return (
    <div
      ref={host}
      className="tree"
      data-testid="project-tree"
      tabIndex={0}
      role="tree"
      aria-label="Проект"
      onKeyDown={onKeyDown}
    >
      {rows.map((r) => (
        <div
          key={r.key}
          data-key={r.key}
          role="treeitem"
          aria-expanded={r.kind === 'dir' || r.kind === 'root' ? r.open : undefined}
          aria-selected={r.key === sel}
          className={['n', r.cls, r.key === sel ? 'sel' : ''].filter(Boolean).join(' ')}
          style={{ paddingLeft: INDENT0 + INDENT * r.depth }}
          onClick={() => {
            if (r.kind === 'more') return
            setSel(r.key)
            activate(r)
          }}
        >
          <span className="tw-a">{r.kind === 'dir' || r.kind === 'root' ? (r.open ? '▾' : '▸') : ''}</span>
          {r.kind !== 'more' && <span className="ic">{r.kind === 'file' ? fileIcon(r.label) : folderIcon(r.rel)}</span>}
          {r.kind === 'root' ? (
            <>
              <span className="lbl">
                <b>{r.label}</b>
              </span>
              <span className="hint">{tildify(root)}</span>
            </>
          ) : (
            <span className="lbl">{r.label}</span>
          )}
        </div>
      ))}
    </div>
  )
}
