import { useTabs } from '../layout/tabsStore'
import { DEFAULTS, stepSize } from '../settings/settings'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/uiStore'
import { runPaneCommand } from '../feed/paneCommands'
import type { Action } from './keymap'

export function runAction(a: Action): void {
  const tabs = useTabs.getState()
  const settings = useSettings.getState()
  const s = settings.settings
  switch (a) {
    case 'splitRight': return tabs.split('row')
    case 'splitDown': return tabs.split('col')
    case 'newTab': {
      const t = tabs.tabs.find((x) => x.id === tabs.active)
      return tabs.newTab(t?.cwd[t.focused])
    }
    case 'closePane': return tabs.closeFocused()
    case 'focusLeft': return tabs.focusDir('left')
    case 'focusRight': return tabs.focusDir('right')
    case 'focusUp': return tabs.focusDir('up')
    case 'focusDown': return tabs.focusDir('down')
    case 'prevTab':
    case 'nextTab': {
      const n = tabs.tabs.length
      if (n === 0) return
      const i = tabs.tabs.findIndex((t) => t.id === tabs.active)
      return tabs.activate(tabs.tabs[(i + (a === 'nextTab' ? 1 : n - 1)) % n].id)
    }
    case 'fontBigger':
    case 'fontSmaller': {
      const d = a === 'fontBigger' ? 1 : -1
      return settings.update({ textSize: stepSize(s.textSize, d, 'text'), codeSize: stepSize(s.codeSize, d, 'code') })
    }
    case 'fontReset': return settings.update({ textSize: DEFAULTS.textSize, codeSize: DEFAULTS.codeSize })
    case 'openSettings': return useUi.getState().setSettingsOpen(true)
    case 'toggleAgents': return useUi.getState().toggleAgents()
    case 'blockPrev':
    case 'blockNext':
    case 'blockCopy':
    case 'blockAttach':
    case 'blockRead':
    case 'find': {
      const t = tabs.tabs.find((x) => x.id === tabs.active)
      return t && runPaneCommand(t.focused, a)
    }
    default: {
      // tab1..tab9; ⌘9 — последняя вкладка
      const n = Number(a.slice(3))
      return tabs.activateIndex(n === 9 ? tabs.tabs.length - 1 : n - 1)
    }
  }
}
