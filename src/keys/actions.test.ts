import { beforeEach, describe, expect, it } from 'vitest'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/uiStore'
import { useProject } from '../project/store'
import { leaves } from '../layout/paneTree'
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
    expect(useSettings.getState().settings.codeSize).toBe(14)
    runAction('fontReset')
    expect(useSettings.getState().settings.textSize).toBe(16)
    expect(useSettings.getState().settings.codeSize).toBe(13)
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
    runAction('blockPrev'); runAction('blockNext'); runAction('blockCopy'); runAction('blockAsk')
    off()
    runAction('blockPrev')
    expect(got).toEqual(['blockPrev', 'blockNext', 'blockCopy', 'blockAsk'])
  })
})

describe('окна инструментов и ⌘W в просмотре', () => {
  beforeEach(() => {
    useProject.setState({ tool: null, tabs: [], active: 0 })
    document.body.innerHTML = ''
  })
  it('toolProject / toolChanges / toolGit переключают, повтор — скрывает', () => {
    runAction('toolProject')
    expect(useProject.getState().tool).toBe('project')
    runAction('toolChanges')
    expect(useProject.getState().tool).toBe('changes')
    runAction('toolGit')
    expect(useProject.getState().tool).toBe('git')
    runAction('toolGit')
    expect(useProject.getState().tool).toBeNull()
  })
  it('⌘W при фокусе в просмотре закрывает вкладку файла, а не панель', () => {
    useTabs.getState().split('row')
    const count = () => leaves(useTabs.getState().tabs[0].tree).length
    expect(count()).toBe(2)
    useProject.setState({ tabs: [{ kind: 'file', rel: 'a.kt' }, { kind: 'file', rel: 'b.kt' }], active: 1 })
    const ed = document.createElement('div')
    ed.setAttribute('data-viewer', '')
    ed.tabIndex = -1
    const inner = document.createElement('button')
    ed.appendChild(inner)
    document.body.appendChild(ed)
    inner.focus()
    runAction('closePane')
    expect(useProject.getState().tabs).toEqual([{ kind: 'file', rel: 'a.kt' }])
    expect(count()).toBe(2)
    inner.blur()
    runAction('closePane')
    expect(count()).toBe(1)
    expect(useProject.getState().tabs).toHaveLength(1)
  })
  it('вкладка изменений активна (панели скрыты) — ⌘W закрывает её при любом фокусе', () => {
    useTabs.getState().split('row')
    const count = () => leaves(useTabs.getState().tabs[0].tree).length
    useProject.setState({ tabs: [{ kind: 'file', rel: 'a.kt' }, { kind: 'diff', rel: 'a.kt', rev: null }], active: 1 })
    ;(document.activeElement as HTMLElement | null)?.blur()
    runAction('closePane')
    expect(useProject.getState().tabs).toEqual([{ kind: 'file', rel: 'a.kt' }])
    expect(count()).toBe(2)
  })
})
