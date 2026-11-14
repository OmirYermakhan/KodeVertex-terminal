import { create } from 'zustand'
import { gitStatus, projectRoot, type Change } from './api'

export type Tool = 'project' | 'changes' | 'git'
export type ViewerTab =
  | { kind: 'file'; rel: string }
  /** oldPath — прежний путь переименованного файла. */
  | { kind: 'diff'; rel: string; rev: string | null; oldPath?: string }

export const WIDTH_MIN = 200
export const WIDTH_MAX = 600
const WIDTH_DEFAULT = 290
const WIDTH_KEY = 'kv.projectWidth'
export const REFRESH_THROTTLE_MS = 500

const clampWidth = (px: number) => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(px)))

function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : WIDTH_DEFAULT
  } catch {
    return WIDTH_DEFAULT
  }
}

/** Состояние панели, своё у каждого корня: при возврате к проекту восстанавливается. */
export interface RootView {
  tabs: ViewerTab[]
  active: number
  focusLine: number | null
  cursors: Record<string, number>
  claudeTouched: Set<string>
  /** Дерево проекта: раскрытые папки и выбранная строка (окно инструмента размонтируется при смене). */
  treeExpanded: ReadonlySet<string>
  treeSel: string | null
  /** «Изменения»: выбранный файл и свёрнутые группы. */
  changesSel: string | null
  changesClosed: ReadonlySet<string>
}

const freshView = (): RootView => ({
  tabs: [],
  active: 0,
  focusLine: null,
  cursors: {},
  claudeTouched: new Set(),
  treeExpanded: new Set(['']),
  treeSel: null,
  changesSel: null,
  changesClosed: new Set(),
})

const viewOf = (s: RootView): RootView => ({
  tabs: s.tabs,
  active: s.active,
  focusLine: s.focusLine,
  cursors: s.cursors,
  claudeTouched: s.claudeTouched,
  treeExpanded: s.treeExpanded,
  treeSel: s.treeSel,
  changesSel: s.changesSel,
  changesClosed: s.changesClosed,
})

/** Подпись списка изменений: тот же список — та же ссылка, потребители не перечитывают файл и лог. */
const signature = (changes: Change[]) =>
  changes.map((c) => `${c.status}\0${c.path}\0${c.oldPath ?? ''}\0${c.add ?? ''}\0${c.del ?? ''}`).join('\n')

const baseOf = (root: string) => (root.endsWith('/') ? root : root + '/')

interface ProjectState extends RootView {
  tool: Tool | null
  width: number
  root: string | null
  /** null — ещё не загружено. */
  changes: Change[] | null
  /** Неотслеживаемых сверх потолка бэкенда (в changes их нет). */
  moreUntracked: number
  notGit: boolean
  /** Счётчик ответов git_status: вне git дерево по нему перечитывает раскрытые папки. */
  tick: number
  /** Ошибка git_status (кроме «не git»): при changes === null — показать её вместо загрузки. */
  gitError: string | null
  /** Строка состояния окна «Git»: «хэш · N файла · +a −d» выбранного коммита. */
  commitStat: string | null
  /** Сохранённое состояние других корней (текущий — в полях стора). */
  saved: Map<string, RootView>
  /** Повторное нажатие на активный инструмент закрывает панель. */
  toggle(tool: Tool): void
  close(): void
  setWidth(px: number): void
  setRoot(cwd: string): void
  refresh(): void
  openFile(rel: string, line?: number): void
  openDiff(rel: string, rev: string | null, oldPath?: string | null): void
  closeTab(i: number): void
  setCursor(rel: string, line: number): void
  markClaudeTouched(absPath: string): void
  /** Новая сессия Claude: «Claude менял» начинается заново. */
  clearClaudeTouched(): void
}

let lastRefresh = 0
let pending: ReturnType<typeof setTimeout> | null = null
/** Номер запроса: ответ устаревшего (после смены корня или более нового refresh) отбрасываем. */
let seq = 0
/** Номер запроса корня: применяется только ответ на последний setRoot. */
let rootSeq = 0
/** Номер запроса git_status в работе (null — нет): одновременно идёт один, новые ждут одним повтором. */
let busy: number | null = null
let queued = false

const sameTab = (a: ViewerTab, b: ViewerTab) =>
  a.kind === b.kind && a.rel === b.rel && (a.kind === 'file' || (b.kind === 'diff' && a.rev === b.rev))

function openTab(s: ProjectState, tab: ViewerTab, line: number | null) {
  const i = s.tabs.findIndex((t) => sameTab(t, tab))
  if (i >= 0) return { active: i, focusLine: line }
  return { tabs: [...s.tabs, tab], active: s.tabs.length, focusLine: line }
}

export const useProject = create<ProjectState>((set, get) => {
  const run = () => {
    const root = get().root
    if (!root) return
    // Большой репозиторий: status дольше паузы троттла — не копим процессы, повторяем один раз после ответа.
    if (busy === seq) {
      queued = true
      return
    }
    lastRefresh = Date.now()
    const id = ++seq
    busy = id
    const keep = (next: Change[]) => {
      const prev = get().changes
      return prev && signature(prev) === signature(next) ? prev : next
    }
    gitStatus(root)
      .then(
        ({ changes, moreUntracked }) => {
          if (id === seq) set((s) => ({ changes: keep(changes), moreUntracked, notGit: false, gitError: null, tick: s.tick + 1 }))
        },
        (e) => {
          if (id !== seq) return
          if (String(e).includes('not-git'))
            set((s) => ({ changes: keep([]), moreUntracked: 0, notGit: true, gitError: null, tick: s.tick + 1 }))
          else set((s) => ({ gitError: String(e), tick: s.tick + 1 }))
        },
      )
      .finally(() => {
        if (busy !== id) return
        busy = null
        if (queued) {
          queued = false
          run()
        }
      })
  }
  return {
    tool: null,
    width: loadWidth(),
    root: null,
    changes: null,
    moreUntracked: 0,
    notGit: false,
    tick: 0,
    gitError: null,
    commitStat: null,
    ...freshView(),
    saved: new Map(),
    toggle: (tool) => set((s) => ({ tool: s.tool === tool ? null : tool })),
    close: () => set({ tool: null }),
    setWidth: (px) => {
      const width = clampWidth(px)
      set({ width })
      try {
        localStorage.setItem(WIDTH_KEY, String(width))
      } catch {
        /* хранилище недоступно — ширина живёт до перезапуска */
      }
    },
    setRoot: (cwd) => {
      const id = ++rootSeq
      projectRoot(cwd).then(
        (root) => {
          // Ответ на прежний cwd пришёл позже нового — не перебивает его.
          if (id !== rootSeq || root === get().root) return
          seq++
          busy = null
          queued = false
          set((s) => {
            // Уходящий корень запоминаем, свой — достаём (или начинаем с чистого).
            const saved = new Map(s.saved)
            if (s.root) saved.set(s.root, viewOf(s))
            const view = saved.get(root) ?? freshView()
            saved.delete(root)
            return { root, changes: null, moreUntracked: 0, notGit: false, gitError: null, commitStat: null, ...view, saved }
          })
          run()
        },
        () => {},
      )
    },
    refresh: () => {
      if (pending) return
      const wait = lastRefresh + REFRESH_THROTTLE_MS - Date.now()
      if (wait <= 0) run()
      else
        pending = setTimeout(() => {
          pending = null
          run()
        }, wait)
    },
    openFile: (rel, line) =>
      set((s) => ({
        ...openTab(s, { kind: 'file', rel }, line ?? null),
        ...(line ? { cursors: { ...s.cursors, [rel]: line } } : {}),
      })),
    openDiff: (rel, rev, oldPath) =>
      set((s) => openTab(s, oldPath ? { kind: 'diff', rel, rev, oldPath } : { kind: 'diff', rel, rev }, null)),
    closeTab: (i) =>
      set((s) => {
        if (i < 0 || i >= s.tabs.length) return {}
        const tabs = s.tabs.filter((_, j) => j !== i)
        const active = i < s.active || (i === s.active && i >= tabs.length) ? Math.max(0, s.active - 1) : s.active
        return { tabs, active: Math.min(active, Math.max(0, tabs.length - 1)) }
      }),
    setCursor: (rel, line) => set((s) => (s.cursors[rel] === line ? {} : { cursors: { ...s.cursors, [rel]: line } })),
    markClaudeTouched: (absPath) => {
      const s = get()
      // Файл относим к самому глубокому известному корню: текущему или запомненному (Claude в другой вкладке).
      let best: string | null = null
      for (const r of [...(s.root ? [s.root] : []), ...s.saved.keys()])
        if (absPath.startsWith(baseOf(r)) && (best === null || r.length > best.length)) best = r
      if (best === null) return
      const rel = absPath.slice(baseOf(best).length)
      if (best === s.root) {
        if (!s.claudeTouched.has(rel)) set({ claudeTouched: new Set(s.claudeTouched).add(rel) })
        return
      }
      const v = s.saved.get(best)!
      if (v.claudeTouched.has(rel)) return
      set({ saved: new Map(s.saved).set(best, { ...v, claudeTouched: new Set(v.claudeTouched).add(rel) }) })
    },
    clearClaudeTouched: () => {
      if (get().claudeTouched.size > 0) set({ claudeTouched: new Set() })
    },
  }
})

/** Код git-статуса → класс строки (макет 07 `.n.mod/.add/.new/.del`). */
export const STATUS = { M: 'mod', R: 'mod', A: 'add', '?': 'new', D: 'del' } as const
export type VcsClass = (typeof STATUS)[keyof typeof STATUS]

export function statusOf(changes: Change[] | null, rel: string): VcsClass | null {
  const c = changes?.find((x) => x.path === rel)
  return c ? STATUS[c.status] : null
}

/** Есть ли изменённые файлы внутри каталога (relDir '' — корень). */
export function dirHasChanges(changes: Change[] | null, relDir: string): boolean {
  if (!changes) return false
  if (relDir === '') return changes.length > 0
  const p = relDir.endsWith('/') ? relDir : relDir + '/'
  return changes.some((c) => c.path.startsWith(p))
}
