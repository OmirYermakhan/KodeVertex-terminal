import type { Settings } from '../settings/settings'
import type { Theme } from './themes'

export function applyTheme(theme: Theme, s: Settings, root: HTMLElement = document.documentElement): void {
  const style = root.style
  for (const [token, value] of Object.entries(theme.tokens)) {
    style.setProperty(`--${token}`, value)
  }
  style.setProperty('--font-text', `'${s.textFont}', sans-serif`)
  style.setProperty('--font-code', `'${s.codeFont}', monospace`)
  style.setProperty('--size-text', `${s.textSize}px`)
  style.setProperty('--size-code', `${s.codeSize}px`)
  style.setProperty('--lh-text', String(s.lineHeight))
  style.setProperty('--liga', s.ligatures ? 'normal' : 'none')
  style.setProperty('color-scheme', theme.dark ? 'dark' : 'light')
}
