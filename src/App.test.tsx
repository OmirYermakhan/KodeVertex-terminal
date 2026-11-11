import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

// xterm needs a real canvas/layout; the pane itself is checked manually in the app.
vi.mock('./terminal/TerminalPane', () => ({ TerminalPane: () => null }))

describe('App', () => {
  it('renders tabbar, panes and statusbar zones', () => {
    render(<App />)
    expect(screen.getByTestId('tabbar')).toBeInTheDocument()
    expect(screen.getByTestId('panes')).toBeInTheDocument()
    expect(screen.getByTestId('statusbar')).toBeInTheDocument()
  })
})
