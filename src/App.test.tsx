import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders tabbar, panes and statusbar zones', () => {
    render(<App />)
    expect(screen.getByTestId('tabbar')).toBeInTheDocument()
    expect(screen.getByTestId('panes')).toBeInTheDocument()
    expect(screen.getByTestId('statusbar')).toBeInTheDocument()
  })
})
