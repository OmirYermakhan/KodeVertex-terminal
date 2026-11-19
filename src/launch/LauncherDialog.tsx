// Окно «Новый вход» / «Изменить вход»: команда, папка, имя, значок (или своя картинка), цвет. ↵ — сохранить и открыть, esc — закрыть.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { pickPaths } from '../ui/pickPaths'
import { useSettings } from '../settings/store'
import { LAUNCHER_COLORS, LAUNCHER_ICONS, MAX_LAUNCHERS, folderName, suggestName, type Launcher, type LauncherIcon as IconId } from './launchers'
import { ICON_LABELS, LauncherIcon } from './LauncherIcon'
import { openLauncher } from './runner'

export const LAUNCHER_COMMAND_HINT = 'Необязательно. Выполняется в новой вкладке при каждом входе: ssh, docker exec…'

export interface LauncherDialogProps {
  /** null — новый вход. */
  editId: string | null
  onClose(): void
}

export default function LauncherDialog({ editId, onClose }: LauncherDialogProps) {
  const [prev] = useState(() => document.activeElement as HTMLElement | null)
  const existing = useSettings((s) => (editId ? s.settings.launchers.find((l) => l.id === editId) : undefined))
  const count = useSettings((s) => s.settings.launchers.length)
  const [command, setCommand] = useState(existing?.command ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [icon, setIcon] = useState<IconId>(existing?.icon ?? 'server')
  const [color, setColor] = useState<string>(existing?.color ?? LAUNCHER_COLORS[count % LAUNCHER_COLORS.length])
  const [cwd, setCwd] = useState<string | undefined>(existing?.cwd)
  const [image, setImage] = useState<string | undefined>(existing?.image)
  const [imageError, setImageError] = useState<string | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const cmdRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    // StrictMode монтирует дважды: флаг ставится заново при каждом монтировании.
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

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
  const canSave = (command.trim() !== '' || !!cwd) && !full
  const defaultName = suggestName(command) || (cwd ? folderName(cwd) : '')

  const pickFolder = async () => {
    try {
      const [dir] = await pickPaths({ directory: true, title: 'Папка проекта' })
      if (!alive.current) return
      setFolderError(null)
      if (dir) setCwd(dir)
    } catch (e) {
      // invoke отклоняется строкой из pick.rs — она объясняет, что делать.
      if (alive.current) setFolderError(typeof e === 'string' ? e : 'Не удалось открыть выбор папки')
    }
  }

  const pickImage = async () => {
    try {
      const [path] = await pickPaths({
        filters: [{ name: 'Картинка', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      })
      if (!alive.current) return
      if (!path) {
        setImageError(null)
        return
      }
      const url = await invoke<string>('launcher_icon', { path })
      if (!alive.current) return
      setImage(url)
      setImageError(null)
    } catch (e) {
      if (alive.current) setImageError(String(e))
    }
  }

  const save = () => {
    if (!canSave) return
    const all = useSettings.getState().settings.launchers
    const l: Launcher = {
      id: existing?.id ?? crypto.randomUUID(),
      name: name.trim() || defaultName,
      command: command.trim(),
      icon,
      color,
      ...(cwd ? { cwd } : {}),
      ...(image ? { image } : {}),
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
              aria-label="Команда"
              className="ld-cmd"
              value={command}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="ssh deploy@203.0.113.10 — или пусто"
              onChange={(e) => setCommand(e.target.value)}
            />
            <small className="st-hint">{LAUNCHER_COMMAND_HINT}</small>
          </label>
          <div className="ld-field">
            <span>Папка</span>
            <div className="ld-dir">
              <code className={cwd ? 'ld-path' : 'ld-path none'} title={cwd}>
                {cwd ?? 'не выбрана'}
              </code>
              <button type="button" onClick={pickFolder}>
                Выбрать…
              </button>
              {cwd && (
                <button type="button" aria-label="Убрать папку" title="Убрать папку" onClick={() => setCwd(undefined)}>
                  ✕
                </button>
              )}
            </div>
            {folderError && <small className="st-hint ld-err">{folderError}</small>}
          </div>
          <label className="ld-field">
            <span>Название</span>
            <input value={name} placeholder={defaultName || 'prod-api'} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="ld-field">
            <span>Значок</span>
            <div className="ld-icons" role="radiogroup" aria-label="Значок">
              <button
                type="button"
                role="radio"
                aria-checked={!!image}
                aria-label="Своя картинка"
                title="Своя картинка"
                className={image ? 'ld-icon ld-img on' : 'ld-icon ld-img'}
                style={{ color }}
                onClick={pickImage}
              >
                {image ? (
                  <img src={image} alt="" />
                ) : (
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1.5" y="3.5" width="10" height="9" rx="1.5" />
                    <path d="M1.5 10.5l3-3 3 3M8 9l1.5-1.5 2 2" />
                    <path d="M13.5 1v4M11.5 3h4" />
                  </svg>
                )}
              </button>
              {LAUNCHER_ICONS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={!image && icon === id}
                  aria-label={ICON_LABELS[id]}
                  title={ICON_LABELS[id]}
                  className={!image && icon === id ? 'ld-icon on' : 'ld-icon'}
                  style={{ color }}
                  onClick={() => {
                    setIcon(id)
                    setImage(undefined)
                    setImageError(null)
                  }}
                >
                  <LauncherIcon icon={id} />
                </button>
              ))}
            </div>
            {imageError && <small className="st-hint ld-err">{imageError}</small>}
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
