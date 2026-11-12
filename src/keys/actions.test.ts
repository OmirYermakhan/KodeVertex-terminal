import { beforeEach, describe, expect, it } from 'vitest'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/uiStore'
import { runAction } from './actions'

beforeEach(() => {
  useTabs.setState(initialTabsState())
})

describe('runAction', () => {
  it('newTab inherits focused cwd', () => {
    const t = useTabs.getState().tabs[0]
    useTabs.getState().setCwd(t.focused, '/tmp/x')
    runAction('newTab')
    const s = useTabs.getState()
    expect(s.tabs).toHaveLength(2)
    const nt = s.tabs[1]
    expect(nt.cwd[nt.focused]).toBe('/tmp/x')
  })
  it('tab9 is last, prev/next wrap', () => {
    runAction('newTab'); runAction('newTab')
    runAction('tab1')
    const ids = useTabs.getState().tabs.map((t) => t.id)
    expect(useTabs.getState().active).toBe(ids[0])
    runAction('prevTab')
    expect(useTabs.getState().active).toBe(ids[2])
    runAction('nextTab')
    expect(useTabs.getState().active).toBe(ids[0])
    runAction('tab9')
    expect(useTabs.getState().active).toBe(ids[2])
  })
  it('font actions change both sizes; reset restores defaults', () => {
    runAction('fontBigger')
    expect(useSettings.getState().settings.textSize).toBe(17)
    expect(useSettings.getState().settings.codeSize).toBe(15)
    runAction('fontReset')
    expect(useSettings.getState().settings.textSize).toBe(16)
    expect(useSettings.getState().settings.codeSize).toBe(14)
  })
  it('openSettings sets the flag', () => {
    runAction('openSettings')
    expect(useUi.getState().settingsOpen).toBe(true)
  })
})

describe('block actions', () => {
  it('уходят в фокусную панель', async () => {
    const { registerPaneCommands } = await import('../feed/paneCommands')
    const t = useTabs.getState().tabs[0]
    const got: string[] = []
    const off = registerPaneCommands(t.focused, (a) => got.push(a))
    runAction('blockPrev'); runAction('blockNext'); runAction('blockCopy')
    off()
    runAction('blockPrev')
    expect(got).toEqual(['blockPrev', 'blockNext', 'blockCopy'])
  })
})
