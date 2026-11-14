import { useEffect, useMemo, useRef, useState } from 'react'
import type { Change } from './api'
import { ChangeRow, filesWord, sumStat } from './changeRow'
import { useProject } from './store'

type Group = { id: 'tracked' | 'untracked'; title: string; items: Change[] }

/** Окно инструмента открылось с фокусом на себе — фокус в список, чтобы стрелки работали сразу. */
export function useTakeFocus(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement === el.closest('.tw')) el.focus()
  }, [ref])
}

/**
 * Локальные изменения (макет 07, окно 2): группы «Изменения N файлов» (M/A/D/R) и «Не отслеживаются N файл»,
 * подвал «+A −D · N файлов» и «Claude менял K из N». Клик / ↵ — изменения файла справа, ⌘↓ — сам файл.
 */
export default function ChangesView() {
  const host = useRef<HTMLDivElement>(null)
  useTakeFocus(host)
  const changes = useProject((s) => s.changes)
  const notGit = useProject((s) => s.notGit)
  const gitError = useProject((s) => s.gitError)
  const touched = useProject((s) => s.claudeTouched)
  const [sel, setSel] = useState<string | null>(null)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())

  const groups = useMemo(() => {
    const all = changes ?? []
    const tracked = all.filter((c) => c.status !== '?')
    const untracked = all.filter((c) => c.status === '?')
    const out: Group[] = []
    if (tracked.length) out.push({ id: 'tracked', title: 'Изменения', items: tracked })
    if (untracked.length) out.push({ id: 'untracked', title: 'Не отслеживаются', items: untracked })
    return out
  }, [changes])
  const nav = groups.flatMap((g) => (closed.has(g.id) ? [] : g.items))

  // Выбранная строка — в видимой области.
  useEffect(() => {
    if (sel === null) return
    const el = [...(host.current?.querySelectorAll<HTMLElement>('.ch') ?? [])].find((x) => x.dataset.path === sel)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [sel])

  const openDiff = (c: Change) => useProject.getState().openDiff(c.path, null)

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.altKey) return
    const i = nav.findIndex((c) => c.path === sel)
    const cur = i >= 0 ? nav[i] : null
    if (e.metaKey) {
      // ⌘↓ — открыть сам файл (как в AS «Jump to Source»).
      if (e.key !== 'ArrowDown' || !cur) return
      e.preventDefault()
      useProject.getState().openFile(cur.path)
      return
    }
    const go = (c: Change | undefined) => c && setSel(c.path)
    if (e.key === 'ArrowDown') go(nav[i < 0 ? 0 : Math.min(nav.length - 1, i + 1)])
    else if (e.key === 'ArrowUp') go(nav[i < 0 ? nav.length - 1 : Math.max(0, i - 1)])
    else if (e.key === 'Home') go(nav[0])
    else if (e.key === 'End') go(nav[nav.length - 1])
    else if (e.key === 'Enter') {
      if (cur) openDiff(cur)
    } else return
    e.preventDefault()
  }

  const all = changes ?? []
  const msg = notGit
    ? 'Не git-репозиторий'
    : changes === null
      ? gitError
      : all.length === 0
        ? 'Изменений нет'
        : null
  const { add, del } = sumStat(all)
  const byClaude = all.filter((c) => touched.has(c.path)).length

  return (
    <>
      <div
        ref={host}
        className="tree"
        data-testid="changes-view"
        tabIndex={0}
        role="listbox"
        aria-label="Изменения"
        onKeyDown={onKeyDown}
      >
        {msg && <div className="tree-hint">{msg}</div>}
        {!notGit &&
          groups.map((g, gi) => {
            const open = !closed.has(g.id)
            return (
              <div key={g.id} role="group">
                <div
                  className={gi > 0 ? 'grp next' : 'grp'}
                  onClick={() =>
                    setClosed((s) => {
                      const n = new Set(s)
                      if (open) n.add(g.id)
                      else n.delete(g.id)
                      return n
                    })
                  }
                >
                  <span className="tw-a">{open ? '▾' : '▸'}</span>
                  {g.title} <span className="cnt">{`${g.items.length} ${filesWord(g.items.length)}`}</span>
                </div>
                {open &&
                  g.items.map((c) => (
                    <ChangeRow
                      key={c.path}
                      c={c}
                      sel={c.path === sel}
                      onClick={() => {
                        setSel(c.path)
                        openDiff(c)
                      }}
                    />
                  ))}
              </div>
            )
          })}
      </div>
      {!notGit && all.length > 0 && (
        <div className="twf">
          <span>{`+${add} −${del} · ${all.length} ${filesWord(all.length)}`}</span>
          {byClaude > 0 && <span>{`Claude менял ${byClaude} из ${all.length}`}</span>}
        </div>
      )}
    </>
  )
}
