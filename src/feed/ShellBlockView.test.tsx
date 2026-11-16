import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { cleanSerializedHtml } from './blockHtml'
import { applyShell, type ShellBlock } from './feed'
import { ShellBlockView } from './ShellBlockView'

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r))

/** Настоящий вывод SerializeAddon, как его замораживает TerminalPane. */
async function frozen(data: string, lines: number): Promise<string> {
  const t = new Terminal({ cols: 30, rows: 5, allowProposedApi: true })
  const s = new SerializeAddon()
  t.loadAddon(s)
  await write(t, data)
  const raw = s.serializeAsHTML({ includeGlobalBackground: false, range: { startLine: 0, endLine: lines - 1, startCol: 0 } })
  t.dispose()
  return cleanSerializedHtml(raw)
}

const block = (over: Partial<ShellBlock>): ShellBlock => ({
  kind: 'shell', id: 'b', command: 'ls', cwd: '/w', startedAt: 0, durationMs: 1, exitCode: 0, html: null, lines: 1, running: false, ...over,
})

describe('ShellBlockView: HTML блока', () => {
  it('блоки этого запуска помечены live (start и stray)', () => {
    const started = applyShell([], { t: 'start', command: 'ls', cwd: '/w', at: 0 })
    expect(started[0]).toMatchObject({ live: true })
    const stray = applyShell([], { t: 'stray', command: '', cwd: '/w', at: 0, html: '', lines: 0 })
    expect(stray[0]).toMatchObject({ live: true })
  })

  it('late (exec не удался): вывод и код — в закрытый блок exec без вывода; иначе — отдельным блоком', () => {
    let it = applyShell([], { t: 'start', command: 'exec nosuch', cwd: '/w', at: 0 })
    it = applyShell(it, { t: 'end', exitCode: null, at: 1, html: '', lines: 0 })
    const late = applyShell(it, { t: 'late', command: 'exec nosuch', cwd: '/w', exitCode: 127, at: 5, html: '<div><span>err</span></div>', lines: 1 })
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({ command: 'exec nosuch', exitCode: 127, html: '<div><span>err</span></div>', lines: 1, durationMs: 5 })
    const other = applyShell(late, { t: 'late', command: 'exec nosuch', cwd: '/w', exitCode: 1, at: 6, html: '<div><span>x</span></div>', lines: 1 })
    expect(other).toHaveLength(2)
    expect(applyShell(late, { t: 'late', command: 'exec nosuch', cwd: '/w', exitCode: 1, at: 6, html: '', lines: 0 })).toBe(late)
  })

  it('восстановленный блок с настоящим выводом аддона — HTML с цветами', async () => {
    const html = await frozen('\x1b[31mred\x1b[0m <b>&\r\nok', 2)
    const { container } = render(<ShellBlockView block={block({ html, lines: 2 })} selected={false} />)
    expect(container.querySelector('.out span[style]')).not.toBeNull()
    expect(container.querySelector('.out b')).toBeNull()
    expect(container.querySelector('.out')!.textContent).toContain('red <b>&')
  })

  it('восстановленный блок не той формы — только текст; блок этого запуска не проверяется', () => {
    const html = '<div><b>жирный</b></div>'
    const restored = render(<ShellBlockView block={block({ html })} selected={false} />).container
    expect(restored.querySelector('.out b')).toBeNull()
    expect(restored.querySelector('.out')!.textContent).toBe('жирный')
    const live = render(<ShellBlockView block={block({ html, live: true })} selected={false} />).container
    expect(live.querySelector('.out b')!.textContent).toBe('жирный')
  })
})
