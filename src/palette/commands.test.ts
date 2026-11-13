import { afterEach, describe, expect, it, vi } from 'vitest'
import { paletteCommands, rankCommands, type PaletteContext } from './commands'
import { loadRecent, pushRecent, RECENT_MAX, resetRecent } from './recent'

const ctx = (o: Partial<PaletteContext> = {}): PaletteContext => ({ theme: 'as', agentsHidden: false, claude: false, ...o })
const titles = (q: string, recent: string[] = [], c = ctx()) => rankCommands(paletteCommands(c), q, recent).map((x) => x.title)

describe('paletteCommands', () => {
  it('все темы, текущая помечена; ⌘J и режим Claude — по состоянию', () => {
    const cmds = paletteCommands(ctx({ agentsHidden: true, claude: true }))
    const themes = cmds.filter((c) => c.id.startsWith('theme:'))
    expect(themes).toHaveLength(5)
    expect(themes.find((c) => c.id === 'theme:as')!.note).toBe('текущая')
    expect(cmds.map((c) => c.title)).toEqual(expect.arrayContaining(['Показать панель агентов', 'Режим Claude: выключить', 'Выбрать модель Claude']))
    expect(cmds.find((c) => c.id === 'closePane')!.keys).toEqual(['⌘', 'W'])
  })

  it('без фокусной панели — без строк режима Claude', () => {
    expect(paletteCommands(ctx({ claude: null })).some((c) => c.id === 'claudeToggle' || c.id === 'chooseModel')).toBe(false)
  })
})

describe('rankCommands', () => {
  it('пустой запрос: недавние сверху по свежести, дальше порядок по умолчанию', () => {
    const t = titles('', ['openSettings', 'newTab'])
    expect(t.slice(0, 3)).toEqual(['Настройки', 'Новая вкладка', 'Разделить вправо'])
  })

  it('нечёткий поиск; при том же роде совпадения — недавние раньше', () => {
    expect(new Set(titles('шрифт'))).toEqual(new Set(['Крупнее шрифт', 'Мельче шрифт', 'Обычный размер шрифта']))
    expect(titles('шрифт', ['fontReset'])[0]).toBe('Обычный размер шрифта')
    // Совпадение с начала названия важнее недавности.
    expect(titles('кр', ['fontReset'])[0]).toBe('Крупнее шрифт')
    expect(titles('разд вниз')[0]).toBe('Разделить вниз')
    expect(titles('zzz')).toEqual([])
  })
})

describe('recent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    resetRecent()
  })

  it('новые — в начало, без повторов, не больше RECENT_MAX; переживает перезапуск', () => {
    for (let i = 0; i < RECENT_MAX + 2; i++) pushRecent(`c${i}`)
    pushRecent('c3')
    expect(loadRecent()[0]).toBe('c3')
    expect(loadRecent()).toHaveLength(RECENT_MAX)
    resetRecent()
    expect(loadRecent()[0]).toBe('c3')
  })

  it('хранилище недоступно или испорчено — работает в памяти', () => {
    localStorage.setItem('kv.palette.recent', '{oops')
    expect(loadRecent()).toEqual([])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => pushRecent('newTab')).not.toThrow()
    expect(loadRecent()).toEqual(['newTab'])
  })
})
