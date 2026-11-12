import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const { createHints, hintEnterAction } = await import('./useHints')
type HintsState = import('./useHints').HintsState

function setup(mode: 'shell' | 'claude' = 'shell') {
  let state: HintsState | null = null
  const replace = vi.fn()
  const h = createHints({ mode: () => mode, cwd: () => '/p', replace }, (s) => (state = s))
  const key = (k: string, o: Record<string, unknown> = {}) =>
    h.onKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o })
  const type = (v: string) => h.update(v, v.length)
  return { h, replace, key, type, s: () => state! }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createHints', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
  })

  it('ровно claude: весь список без выбора, ↵ не съедается', () => {
    const { s, key, type, replace } = setup()
    type('claude')
    expect(s().open).toBe(true)
    expect(s().selected).toBe(-1)
    expect(hintEnterAction(s())).toBeNull()
    expect(key('Enter')).toBe(false)
    expect(s().open).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('↓ выбирает, ↵ подставляет и выполняет', () => {
    const { s, key, type, replace } = setup()
    type('claude')
    key('ArrowDown')
    expect(s().selected).toBe(0)
    key('ArrowDown')
    expect(hintEnterAction(s())).toBe('run')
    expect(key('Enter')).toBe(true)
    expect(replace).toHaveBeenCalledWith('claude --tui', 12, true)
  })

  it('строка «открыть режим» по ↵ выполняет строку как есть', () => {
    const { key, type, replace } = setup()
    type('claude')
    key('ArrowDown')
    key('Enter')
    expect(replace).toHaveBeenCalledWith('claude', 6, true)
  })

  it('с набором первая строка выбрана: ↵ выполняет её, ↓ — вторая, ↑ — по кругу', () => {
    const { s, key, type, replace } = setup()
    type('claude -')
    expect(s().selected).toBe(0)
    expect(hintEnterAction(s())).toBe('run')
    key('ArrowDown')
    expect(s().rows[s().selected].item.aliases).toEqual(['-r', '--resume'])
    key('ArrowUp')
    key('ArrowUp')
    expect(s().selected).toBe(s().rows.length - 1)
    type('claude --c')
    expect(key('Enter')).toBe(true)
    expect(replace).toHaveBeenCalledWith('claude --continue', 17, true)
  })

  it('Tab подставляет выбранное', () => {
    const { key, type, replace } = setup()
    type('claude --co')
    expect(key('Tab')).toBe(true)
    expect(replace).toHaveBeenCalledWith('claude --continue ', 18, false)
  })

  it('Tab без выбора выбирает первую строку; → без выбора не съедается', () => {
    const { s, key, type } = setup()
    type('claude')
    expect(key('ArrowRight')).toBe(false)
    expect(key('Tab')).toBe(true)
    expect(s().selected).toBe(0)
    expect(s().navigated).toBe(true)
  })

  it('нет совпадений — закрыт; esc закрывает до изменения строки', () => {
    const { s, key, type } = setup()
    type('claude привет')
    expect(s()?.open ?? false).toBe(false)
    type('claude ')
    expect(s().open).toBe(true)
    expect(key('Escape')).toBe(true)
    expect(s().open).toBe(false)
    type('claude ')
    expect(s().open).toBe(false)
    type('claude m')
    expect(s().open).toBe(true)
  })

  it('режим Claude: встроенные сразу, пользовательские — когда пришли', async () => {
    invoke.mockResolvedValue([{ name: 'deploy', description: 'Выкатить', source: 'project' }])
    const { s, type, key, replace } = setup('claude')
    type('/')
    expect(invoke).toHaveBeenCalledWith('claude_slash_commands', { cwd: '/p' })
    expect(s().rows.every((r) => r.item.group === 'builtin')).toBe(true)
    await flush()
    expect(s().rows.at(-1)!.item.aliases).toEqual(['/deploy'])
    type('/dep')
    key('Tab')
    expect(replace).toHaveBeenCalledWith('/deploy ', 8, false)
    // Кэш по каталогу: повторно не запрашивается.
    type('/')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('история (typed=false) не открывает', () => {
    const { s, h } = setup()
    h.update('claude', 6, false)
    expect(s()?.open ?? false).toBe(false)
  })
})
