import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { projectName, shortPath } from '../status/useGitInfo'
import StatusBar from './StatusBar'

vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('/Users/me') }))

const git = { root: '/Users/me/shop-app', branch: 'feature/form', dirty: true }

describe('helpers', () => {
  it('projectName uses git root folder', () => {
    expect(projectName('/Users/me/shop-app/src', git)).toBe('shop-app')
  })
  it('projectName falls back to cwd folder', () => {
    expect(projectName('/Users/me/notes', null)).toBe('notes')
  })
  it('shortPath replaces home with ~', () => {
    expect(shortPath('/Users/me/x', '/Users/me')).toBe('~/x')
    expect(shortPath('/Users/me', '/Users/me')).toBe('~')
    expect(shortPath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x')
  })
})

describe('StatusBar', () => {
  it('shows project, branch, dirty marker, path and time', async () => {
    const { container } = render(
      <StatusBar cwd="/Users/me/shop-app/src" git={git} now={new Date(2026, 0, 1, 14, 32)} />,
    )
    expect(container.textContent).toContain('проект shop-app')
    expect(container.textContent).toContain('⎇ feature/form')
    expect(screen.getByLabelText('есть изменения')).toBeInTheDocument()
    expect(await screen.findByText('~/shop-app/src')).toBeInTheDocument()
    expect(screen.getByText('14:32')).toBeInTheDocument()
  })

  it('omits the branch segment without git', () => {
    const { container } = render(<StatusBar cwd="/tmp/x" git={null} now={new Date(2026, 0, 1, 9, 5)} />)
    expect(container.textContent).not.toContain('⎇')
    expect(screen.getByText('09:05')).toBeInTheDocument()
  })

  it('shows ~ as the project in the home folder without git', async () => {
    render(<StatusBar cwd="/Users/me" git={null} now={new Date(2026, 0, 1, 9, 5)} />)
    expect(await screen.findByText('~', { selector: 'b' })).toBeInTheDocument()
    expect(screen.queryByText('me', { selector: 'b' })).toBeNull()
  })
})
