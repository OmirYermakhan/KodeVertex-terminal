import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === 'fonts_list'
      ? [
          { name: 'Menlo', monospace: true },
          { name: 'Helvetica', monospace: false },
        ]
      : null,
  ),
}))

import { invoke } from '@tauri-apps/api/core'
import { DEFAULTS } from '../settings/settings'
import { useSettings } from '../settings/store'
import { THEMES } from '../theme/themes'
import SettingsPanel from './SettingsPanel'

const update = vi.fn()

beforeEach(() => {
  update.mockClear()
  vi.mocked(invoke).mockClear()
  useSettings.setState({ settings: { ...DEFAULTS }, update })
})

const opts = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent)

describe('SettingsPanel', () => {
  it('renders nothing when closed', () => {
    render(<SettingsPanel open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows all themes and selects one', () => {
    render(<SettingsPanel open onClose={() => {}} />)
    for (const t of Object.values(THEMES)) expect(screen.getByRole('button', { name: new RegExp(t.name) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /KodeVertex/ }))
    expect(update).toHaveBeenCalledWith({ theme: 'kv' })
  })

  it('steps sizes and line height', () => {
    render(<SettingsPanel open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Увеличить размер текста' }))
    expect(update).toHaveBeenCalledWith({ textSize: 17 })
    fireEvent.click(screen.getByRole('button', { name: 'Уменьшить размер кода' }))
    expect(update).toHaveBeenCalledWith({ codeSize: 13 })
    fireEvent.click(screen.getByRole('button', { name: '1.8' }))
    expect(update).toHaveBeenCalledWith({ lineHeight: 1.8 })
  })

  it('lists bundled and system fonts, code list only monospace', async () => {
    render(<SettingsPanel open onClose={() => {}} />)
    await waitFor(() => expect(opts(screen.getByLabelText('Шрифт текста'))).toContain('Helvetica'))
    const text = opts(screen.getByLabelText('Шрифт текста'))
    for (const n of ['Inter', 'Geist', 'IBM Plex Sans', 'PT Serif', 'Системный (SF Pro)', 'Helvetica']) expect(text).toContain(n)
    const code = opts(screen.getByLabelText('Шрифт кода'))
    for (const n of ['JetBrains Mono', 'Geist Mono', 'IBM Plex Mono', 'Fira Code', 'SF Mono', 'Menlo']) expect(code).toContain(n)
    expect(code).not.toContain('Helvetica')
  })

  it('stores CSS family name for Geist', () => {
    render(<SettingsPanel open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Шрифт текста'), { target: { value: 'Geist Sans' } })
    expect(update).toHaveBeenCalledWith({ textFont: 'Geist Sans' })
  })

  it('toggles ligatures and closes on Esc', () => {
    const onClose = vi.fn()
    render(<SettingsPanel open onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Лигатуры в коде'))
    expect(update).toHaveBeenCalledWith({ ligatures: false })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('toggles path completions', () => {
    render(<SettingsPanel open onClose={vi.fn()} />)
    const box = screen.getByLabelText('Подсказки путей')
    expect(box).toBeChecked()
    fireEvent.click(box)
    expect(update).toHaveBeenCalledWith({ pathCompletions: false })
  })

  it('stores ui-monospace for SF Mono and previews it with Menlo fallback', () => {
    render(<SettingsPanel open onClose={() => {}} />)
    const select = screen.getByLabelText('Шрифт кода') as HTMLSelectElement
    const sf = within(select).getByRole('option', { name: 'SF Mono' }) as HTMLOptionElement
    expect(sf.value).toBe('ui-monospace')
    fireEvent.change(select, { target: { value: 'ui-monospace' } })
    expect(update).toHaveBeenCalledWith({ codeFont: 'ui-monospace' })
    act(() => useSettings.setState({ settings: { ...DEFAULTS, codeFont: 'ui-monospace' } }))
    expect(screen.getByTestId('preview').querySelector('pre')!.style.fontFamily).toContain('Menlo')
  })

  it('is a modal dialog that takes focus and keeps it', () => {
    const outside = document.createElement('textarea')
    document.body.appendChild(outside)
    try {
      render(<SettingsPanel open onClose={() => {}} />)
      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(document.activeElement).toBe(dialog)
      outside.focus()
      expect(document.activeElement).toBe(dialog)
    } finally {
      outside.remove()
    }
  })

  it('Esc closes the panel without reaching the terminal', () => {
    const outside = document.createElement('textarea')
    const reached = vi.fn()
    outside.addEventListener('keydown', reached)
    document.body.appendChild(outside)
    try {
      const onClose = vi.fn()
      render(<SettingsPanel open onClose={onClose} />)
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      outside.dispatchEvent(ev)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(reached).not.toHaveBeenCalled()
      expect(ev.defaultPrevented).toBe(true)
    } finally {
      outside.remove()
    }
  })
})
