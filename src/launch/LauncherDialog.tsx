// Окно «Новый вход» / «Изменить вход»: команда, имя, значок, цвет. ↵ — сохранить и открыть, esc — закрыть.
import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../settings/store'
import { LAUNCHER_COLORS, LAUNCHER_ICONS, MAX_LAUNCHERS, suggestName, type Launcher, type LauncherIcon as IconId } from './launchers'
import { ICON_LABELS, LauncherIcon } from './LauncherIcon'
import { openLauncher } from './runner'

export const LAUNCHER_COMMAND_HINT = 'Выполняется в новой вкладке при каждом входе: ssh, docker exec, kubectl exec…'

export interface LauncherDialogProps {
  /** null — новый вход. */
  editId: string | null
  onClose(): void
}

export default function LauncherDialog({ editId, onClose }: LauncherDialogProps) {
  const [prev] = useState(() => document.activeElement as HTMLElement | null)
  const existing = useSettings((s) => (editId ? s.settings.launchers.find((l) => l.id === editId) : undefined))
  const count = useSettings((s) => s.settings.launchers.length)
  const [command, setCommand] = useState(existing?.command ?? 'ssh ')
  const [name, setName] = useState(existing?.name ?? '')
  const [icon, setIcon] = useState<IconId>(existing?.icon ?? 'server')
  const [color, setColor] = useState<string>(existing?.color ?? LAUNCHER_COLORS[count % LAUNCHER_COLORS.length])
  const cmdRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = cmdRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const close = () => {
    onClose()
    if (prev?.isConnected) prev.focus()
  }

  const full = !existing && count >= MAX_LAUNCHERS
  const canSave = command.trim() !== '' && !full

  const save = () => {
    if (!canSave) return
    const all = useSettings.getState().settings.launchers
    const l: Launcher = {
      id: existing?.id ?? crypto.randomUUID(),
      name: name.trim() || suggestName(command),
      command: command.trim(),
      icon,
      color,
    }
    const launchers = existing ? all.map((x) => (x.id === l.id ? l : x)) : [...all, l]
    useSettings.getState().update({ launchers })
    onClose()
    // Новый вход сразу открывается своей вкладкой; правка — без запуска.
    if (!existing) openLauncher(l)
    else if (prev?.isConnected) prev.focus()
  }

  const remove = () => {
    if (!existing) return
    const all = useSettings.getState().settings.launchers
    useSettings.getState().update({ launchers: all.filter((x) => x.id !== existing.id) })
    close()
  }

  return (
    <div
      className="st-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={existing ? 'Изменить вход' : 'Новый вход'}
        className="st-panel ld"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault()
            save()
          }
        }}
      >
        <div className="st-head">
          <h2>{existing ? 'Изменить вход' : 'Новый вход'}</h2>
          <button type="button" aria-label="Закрыть" onClick={close}>
            ✕
          </button>
        </div>
        <div className="ld-body">
          <label className="ld-field">
            <span>Команда</span>
            <input
              ref={cmdRef}
              className="ld-cmd"
              value={command}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="ssh deploy@203.0.113.10"
              onChange={(e) => setCommand(e.target.value)}
            />
            <small className="st-hint">{LAUNCHER_COMMAND_HINT}</small>
          </label>
          <label className="ld-field">
            <span>Название</span>
            <input value={name} placeholder={suggestName(command) || 'prod-api'} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="ld-field">
            <span>Значок</span>
            <div className="ld-icons" role="radiogroup" aria-label="Значок">
              {LAUNCHER_ICONS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={icon === id}
                  aria-label={ICON_LABELS[id]}
                  title={ICON_LABELS[id]}
                  className={icon === id ? 'ld-icon on' : 'ld-icon'}
                  style={{ color }}
                  onClick={() => setIcon(id)}
                >
                  <LauncherIcon icon={id} />
                </button>
              ))}
            </div>
          </div>
          <div className="ld-field">
            <span>Цвет</span>
            <div className="ld-colors" role="radiogroup" aria-label="Цвет">
              {LAUNCHER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={c}
                  className={color === c ? 'ld-color on' : 'ld-color'}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          {full && <small className="st-hint">Не больше {MAX_LAUNCHERS} входов.</small>}
        </div>
        <div className="ld-foot">
          {existing && (
            <button type="button" className="ld-del" onClick={remove}>
              Удалить
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={close}>
            Отмена
          </button>
          <button type="button" className="ld-save" disabled={!canSave} onClick={save}>
            {existing ? 'Сохранить' : 'Сохранить и открыть'}
          </button>
        </div>
      </div>
    </div>
  )
}
