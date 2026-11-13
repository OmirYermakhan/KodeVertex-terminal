// ⌘P — палитра команд по центру вверху окна: рамка, строки и подсказка клавиш — как у выборки
// `claude …` / `/…` (.cp.hp), справа — клавиши (kbd, как в макете 04). Недавние — сверху.
import { useEffect, useMemo, useRef, useState } from 'react'
import { highlight } from '../completion/CompletionPopup'
import { paneInfo } from '../feed/paneCommands'
import { useTabs } from '../layout/tabsStore'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/uiStore'
import { paletteCommands, rankCommands, type PaletteCommand } from './commands'
import { loadRecent, pushRecent } from './recent'

export const PALETTE_TITLE = 'Палитра команд'
export const PALETTE_PLACEHOLDER = 'Команда…'
export const PALETTE_KEYS = '↑↓ выбрать · ↵ выполнить · esc закрыть'
export const PALETTE_EMPTY = 'Нет таких команд'

export interface CommandPaletteProps {
  onClose(): void
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  // Куда вернуть фокус: туда, где он был до ⌘P (строка ввода, xterm, панель агентов).
  const [prev] = useState(() => document.activeElement as HTMLElement | null)
  // Команды — на момент открытия: тема, ⌘J, режим Claude фокусной панели.
  const [cmds] = useState(() => {
    const s = useTabs.getState()
    const focused = s.tabs.find((t) => t.id === s.active)?.focused
    return paletteCommands({
      theme: useSettings.getState().settings.theme,
      agentsHidden: useUi.getState().agentsHidden,
      claude: focused ? (paneInfo(focused)?.claude ?? null) : null,
    })
  })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const rows = useMemo(() => rankCommands(cmds, query, loadRecent()), [cmds, query])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    const row = listRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, rows])

  const close = () => {
    onClose()
    if (prev?.isConnected) prev.focus()
  }
  // Сначала закрыть и вернуть фокус: команда (⌘F, /model) сама переведёт его, куда нужно.
  const run = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return
    pushRecent(cmd.id)
    close()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    if (!plain) return
    const n = rows.length
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(rows[selected])
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n > 0) {
      e.preventDefault()
      setSelected((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Tab') {
      e.preventDefault()
    }
  }

  return (
    // Щелчок мимо палитры закрывает её.
    <div
      className="pal-back"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        close()
      }}
    >
      <div className="cp hp pal" role="dialog" aria-label={PALETTE_TITLE}>
        <input
          ref={inputRef}
          className="pal-in"
          value={query}
          placeholder={PALETTE_PLACEHOLDER}
          aria-label={PALETTE_TITLE}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="hp-list" ref={listRef} role="listbox">
          {rows.length === 0 && <div className="pal-empty">{PALETTE_EMPTY}</div>}
          {rows.map((cmd, i) => (
            <div
              key={cmd.id}
              role="option"
              aria-selected={i === selected}
              className={'hp-row pal-row' + (i === selected ? ' sel' : '')}
              // mousedown, а не click: фокус остаётся в строке палитры.
              onMouseDown={(e) => {
                e.preventDefault()
                run(cmd)
              }}
              onMouseMove={() => i !== selected && setSelected(i)}
            >
              <span className="hp-n">{highlight(query.trim(), cmd.title)}</span>
              <span className="pal-k">
                {cmd.keys?.map((k, j) => (
                  <kbd key={j} className="kbd">
                    {k}
                  </kbd>
                ))}
                {cmd.note && <span className="pal-note">{cmd.note}</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="hp-keys">{PALETTE_KEYS}</div>
      </div>
    </div>
  )
}

export default CommandPalette
