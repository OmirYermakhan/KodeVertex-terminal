import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { stepSize, type Settings } from '../settings/settings'
import { useSettings } from '../settings/store'
import { codeFontStack, textFontStack } from '../theme/fontFamily'
import { THEMES, type ThemeId } from '../theme/themes'

interface SystemFont {
  name: string
  monospace: boolean
}

interface FontEntry {
  css: string
  label: string
  /** В бандле нет кириллицы. */
  noCyrillic?: boolean
}

/** CSS-имя семейства (то, что хранится в Settings) -> подпись в интерфейсе. */
export const FONT_CSS_NAME: Record<string, string> = {
  Inter: 'Inter',
  'Geist Sans': 'Geist',
  'IBM Plex Sans': 'IBM Plex Sans',
  'PT Serif': 'PT Serif',
  'system-ui': 'Системный (SF Pro)',
  'JetBrains Mono': 'JetBrains Mono',
  'Geist Mono': 'Geist Mono',
  'IBM Plex Mono': 'IBM Plex Mono',
  'Fira Code': 'Fira Code',
  'ui-monospace': 'SF Mono',
}

const NO_CYRILLIC = new Set(['Geist Sans'])
const entry = (css: string): FontEntry => ({ css, label: FONT_CSS_NAME[css] ?? css, noCyrillic: NO_CYRILLIC.has(css) })

const BUNDLED_TEXT = ['Inter', 'Geist Sans', 'IBM Plex Sans', 'PT Serif', 'system-ui'].map(entry)
const BUNDLED_CODE = ['JetBrains Mono', 'Geist Mono', 'IBM Plex Mono', 'Fira Code', 'ui-monospace'].map(entry)

const LINE_HEIGHTS: Settings['lineHeight'][] = [1.5, 1.6, 1.7, 1.8]

const PREVIEW_CODE = `fn main() {
    let msg = "Привет, мир";
    println!("{msg} -> {}", 1 != 2);
}`

function FontSelect(p: { label: string; value: string; bundled: FontEntry[]; system: FontEntry[]; onChange(v: string): void }) {
  const known = [...p.bundled, ...p.system].some((e) => e.css === p.value)
  return (
    <label className="st-row">
      <span>{p.label}</span>
      <select aria-label={p.label} value={p.value} onChange={(e) => p.onChange(e.target.value)}>
        {!known && <option value={p.value}>{p.value}</option>}
        {p.bundled.map((e) => (
          <option key={e.css} value={e.css}>{e.label}</option>
        ))}
        {p.system.length > 0 && <option disabled>──────────</option>}
        {p.system.map((e) => (
          <option key={e.css} value={e.css}>{e.label}</option>
        ))}
      </select>
    </label>
  )
}

function Counter(p: { label: string; value: number; onStep(d: 1 | -1): void }) {
  return (
    <div className="st-row">
      <span>{p.label}</span>
      <span className="st-counter">
        <button type="button" aria-label={`Уменьшить ${p.label.toLowerCase()}`} onClick={() => p.onStep(-1)}>−</button>
        <b>{p.value}</b>
        <button type="button" aria-label={`Увеличить ${p.label.toLowerCase()}`} onClick={() => p.onStep(1)}>+</button>
      </span>
    </div>
  )
}

let fontsPromise: Promise<SystemFont[]> | undefined

function loadFonts(): Promise<SystemFont[]> {
  fontsPromise ??= invoke<SystemFont[]>('fonts_list').catch(() => {
    fontsPromise = undefined
    return []
  })
  return fontsPromise
}

export default function SettingsPanel(p: { open: boolean; onClose: () => void }) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const [fonts, setFonts] = useState<SystemFont[]>([])

  useEffect(() => {
    if (!p.open) return
    let alive = true
    loadFonts().then((f) => alive && setFonts(f))
    return () => {
      alive = false
    }
  }, [p.open])

  const dialogRef = useRef<HTMLDivElement>(null)
  // onClose из App пересоздаётся на каждый рендер; эффект ниже не должен перезапускаться
  // (иначе он снова фокусирует окно и выбивает фокус из открытого списка).
  const onClose = useRef(p.onClose)
  useEffect(() => {
    onClose.current = p.onClose
  })

  // Модальность: фокус внутри окна, Esc закрывает его и не доходит до терминала.
  useEffect(() => {
    if (!p.open) return
    const dialog = dialogRef.current
    dialog?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose.current()
    }
    const onFocusIn = (e: FocusEvent) => {
      if (dialog && !dialog.contains(e.target as Node)) dialog.focus()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [p.open])

  if (!p.open) return null

  const taken = new Set([...BUNDLED_TEXT, ...BUNDLED_CODE].map((e) => e.css))
  const systemText = fonts.filter((f) => !taken.has(f.name)).map((f) => entry(f.name))
  const systemCode = fonts.filter((f) => f.monospace && !taken.has(f.name)).map((f) => entry(f.name))
  const hint = (name: string) => (NO_CYRILLIC.has(name) ? <small className="st-hint">без кириллицы</small> : null)

  return (
    <div className="st-overlay" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Настройки" tabIndex={-1} className="st-panel">
        <header className="st-head">
          <h2>Настройки</h2>
          <button type="button" aria-label="Закрыть" onClick={p.onClose}>×</button>
        </header>
        <div className="st-body">
          <div className="st-controls">
            <h3>Тема</h3>
            <div className="st-themes">
              {(Object.keys(THEMES) as ThemeId[]).map((id) => {
                const t = THEMES[id]
                return (
                  <button
                    key={id}
                    type="button"
                    className={'st-theme' + (settings.theme === id ? ' on' : '')}
                    aria-pressed={settings.theme === id}
                    onClick={() => update({ theme: id })}
                  >
                    <span className="st-sw">
                      <i style={{ background: t.tokens.bg }} />
                      <i style={{ background: t.tokens.panel }} />
                      <i style={{ background: t.tokens.acc }} />
                    </span>
                    {t.name}
                  </button>
                )
              })}
            </div>

            <h3>Шрифты</h3>
            <FontSelect label="Шрифт текста" value={settings.textFont} bundled={BUNDLED_TEXT} system={systemText} onChange={(v) => update({ textFont: v })} />
            {hint(settings.textFont)}
            <FontSelect label="Шрифт кода" value={settings.codeFont} bundled={BUNDLED_CODE} system={systemCode} onChange={(v) => update({ codeFont: v })} />
            {hint(settings.codeFont)}
            <Counter label="Размер текста" value={settings.textSize} onStep={(d) => update({ textSize: stepSize(settings.textSize, d, 'text') })} />
            <Counter label="Размер кода" value={settings.codeSize} onStep={(d) => update({ codeSize: stepSize(settings.codeSize, d, 'code') })} />
            <div className="st-row">
              <span>Интервал</span>
              <span className="st-lh">
                {LINE_HEIGHTS.map((lh) => (
                  <button key={lh} type="button" className={settings.lineHeight === lh ? 'on' : ''} aria-pressed={settings.lineHeight === lh} onClick={() => update({ lineHeight: lh })}>
                    {lh.toFixed(1)}
                  </button>
                ))}
              </span>
            </div>
            <label className="st-row">
              <span>Лигатуры в коде</span>
              <input type="checkbox" checked={settings.ligatures} onChange={(e) => update({ ligatures: e.target.checked })} />
            </label>
            <small className="st-hint">Влияют на блоки кода в карточках; в терминале лигатуры не поддерживаются.</small>

            <h3>Терминал</h3>
            <label className="st-row">
              <span>Подсказки путей</span>
              <input type="checkbox" checked={settings.pathCompletions} onChange={(e) => update({ pathCompletions: e.target.checked })} />
            </label>

            <h3>Уведомления</h3>
            <label className="st-row">
              <span>Системные уведомления</span>
              <input type="checkbox" checked={settings.notifySystem} onChange={(e) => update({ notifySystem: e.target.checked })} />
            </label>
            <label className="st-row">
              <span>Звук</span>
              <input type="checkbox" checked={settings.notifySound} onChange={(e) => update({ notifySound: e.target.checked })} />
            </label>
            <label className="st-row">
              <span>Субагенты</span>
              <input type="checkbox" checked={settings.notifySubagents} onChange={(e) => update({ notifySubagents: e.target.checked })} />
            </label>
            <label className="st-row">
              <span>Долгие команды (&gt; 10 с)</span>
              <input type="checkbox" checked={settings.notifyLongCommands} onChange={(e) => update({ notifyLongCommands: e.target.checked })} />
            </label>
          </div>

          <div className="st-preview" data-testid="preview" style={{ fontFamily: textFontStack(settings.textFont), fontSize: settings.textSize, lineHeight: settings.lineHeight }}>
            <h4>Предпросмотр</h4>
            <p>Съешь же ещё этих мягких французских булок, да выпей чаю. The quick brown fox jumps over the lazy dog.</p>
            <pre style={{ fontFamily: codeFontStack(settings.codeFont), fontSize: settings.codeSize, fontVariantLigatures: settings.ligatures ? 'normal' : 'none' }}>{PREVIEW_CODE}</pre>
          </div>
        </div>
      </div>
    </div>
  )
}
