import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dialogOpen = vi.fn()
const invoke = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...a: unknown[]) => dialogOpen(...a) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('./runner', () => ({ openLauncher: vi.fn() }))

import { DEFAULTS, type Settings } from '../settings/settings'
import { useSettings } from '../settings/store'
import LauncherDialog from './LauncherDialog'

let saved: Settings
const update = vi.fn((patch: Partial<Settings>) => {
  saved = { ...saved, ...patch }
  useSettings.setState({ settings: saved })
})

beforeEach(() => {
  dialogOpen.mockReset()
  invoke.mockReset()
  update.mockClear()
  saved = { ...DEFAULTS, launchers: [] }
  useSettings.setState({ settings: saved, update })
})

const saveBtn = () => screen.getByRole('button', { name: 'Сохранить и открыть' }) as HTMLButtonElement

describe('LauncherDialog', () => {
  it('без команды и папки — сохранить нельзя', () => {
    render(<LauncherDialog editId={null} onClose={() => {}} />)
    expect(saveBtn().disabled).toBe(true)
  })

  it('папка без команды — вход сохраняется с именем папки', async () => {
    dialogOpen.mockResolvedValue('/Users/x/proj')
    render(<LauncherDialog editId={null} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать…' }))
    await waitFor(() => expect(saveBtn().disabled).toBe(false))
    expect(dialogOpen).toHaveBeenCalledWith({ directory: true, title: 'Папка проекта' })
    fireEvent.click(saveBtn())
    expect(saved.launchers).toHaveLength(1)
    expect(saved.launchers[0]).toMatchObject({ command: '', cwd: '/Users/x/proj', name: 'proj' })
  })

  it('своя картинка — сохраняется data-URL', async () => {
    dialogOpen.mockResolvedValue('/i.png')
    invoke.mockResolvedValue('data:image/png;base64,AAA')
    render(<LauncherDialog editId={null} onClose={() => {}} />)
    const tile = screen.getByRole('radio', { name: 'Своя картинка' })
    fireEvent.click(tile)
    await waitFor(() => expect(tile.getAttribute('aria-checked')).toBe('true'))
    expect(invoke).toHaveBeenCalledWith('launcher_icon', { path: '/i.png' })
    fireEvent.change(screen.getByLabelText('Команда'), { target: { value: 'ssh a@b' } })
    fireEvent.click(saveBtn())
    expect(saved.launchers[0].image).toBe('data:image/png;base64,AAA')
  })

  it('картинка не прочиталась — показана ошибка, значок прежний', async () => {
    dialogOpen.mockResolvedValue('/i.txt')
    invoke.mockRejectedValue('не картинка')
    render(<LauncherDialog editId={null} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Своя картинка' }))
    expect(await screen.findByText('не картинка')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Своя картинка' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.change(screen.getByLabelText('Команда'), { target: { value: 'ssh a@b' } })
    fireEvent.click(saveBtn())
    expect(saved.launchers[0].image).toBeUndefined()
    expect(saved.launchers[0].icon).toBe('server')
  })
})
