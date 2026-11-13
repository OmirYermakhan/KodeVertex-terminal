import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const channels: MockChannel[] = []

class MockChannel {
  onmessage: (m: unknown) => void = () => {}
  constructor(onmessage?: (m: unknown) => void) {
    if (onmessage) this.onmessage = onmessage
    channels.push(this)
  }
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: MockChannel,
}))

const { spawnPty } = await import('./ptyClient')

describe('spawnPty', () => {
  beforeEach(() => {
    invoke.mockReset()
    channels.length = 0
    invoke.mockImplementation(async (cmd: string) => (cmd === 'pty_spawn' ? { id: 'sess-1', mark: 'm1' } : undefined))
  })

  it('passes cwd/cols/rows and both channels to pty_spawn', async () => {
    const h = await spawnPty({ cwd: '/tmp', cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    expect(h.id).toBe('sess-1')
    expect(h.mark).toBe('m1')
    expect(invoke).toHaveBeenCalledWith('pty_spawn', {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      onData: channels[0],
      onExit: channels[1],
    })
  })

  it('delivers ArrayBuffer from the data channel as Uint8Array', async () => {
    const onData = vi.fn()
    await spawnPty({ cols: 80, rows: 24, onData, onExit: () => {} })
    channels[0].onmessage(new Uint8Array([104, 105]).buffer)
    expect(onData).toHaveBeenCalledTimes(1)
    const got = onData.mock.calls[0][0]
    expect(got).toBeInstanceOf(Uint8Array)
    expect(Array.from(got as Uint8Array)).toEqual([104, 105])
  })

  it('вывод и выход до ответа pty_spawn придерживаются до onSpawn и идут по порядку', async () => {
    const log: string[] = []
    let answer: (v: unknown) => void = () => {}
    invoke.mockImplementation((cmd: string) => (cmd === 'pty_spawn' ? new Promise((r) => (answer = r)) : Promise.resolve()))
    const p = spawnPty({
      cols: 80,
      rows: 24,
      onData: (b) => log.push(`data:${String.fromCharCode(...b)}`),
      onExit: (c) => log.push(`exit:${c}`),
      onSpawn: (h) => log.push(`spawn:${h.mark}`),
    })
    await Promise.resolve()
    channels[0].onmessage(new Uint8Array([97]).buffer)
    channels[0].onmessage(new Uint8Array([98]).buffer)
    channels[1].onmessage(0)
    expect(log).toEqual([])
    answer({ id: 's', mark: 'm2' })
    await p
    expect(log).toEqual(['spawn:m2', 'data:a', 'data:b', 'exit:0'])
    channels[0].onmessage(new Uint8Array([99]).buffer)
    expect(log.at(-1)).toBe('data:c')
  })

  it('forwards exit code', async () => {
    const onExit = vi.fn()
    await spawnPty({ cols: 80, rows: 24, onData: () => {}, onExit })
    channels[1].onmessage(0)
    channels[1].onmessage(null)
    expect(onExit.mock.calls).toEqual([[0], [null]])
  })

  it('write/resize/kill call the matching commands with the session id', async () => {
    const h = await spawnPty({ cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    h.write('ls\n')
    h.resize(100, 30)
    h.kill()
    await new Promise((r) => setTimeout(r, 0)) // writes are chained on a promise
    expect(invoke).toHaveBeenCalledWith('pty_write', { id: 'sess-1', data: 'ls\n' })
    expect(invoke).toHaveBeenCalledWith('pty_resize', { id: 'sess-1', cols: 100, rows: 30 })
    expect(invoke).toHaveBeenCalledWith('pty_kill', { id: 'sess-1' })
  })
})

describe('spawnPty write ordering', () => {
  beforeEach(() => {
    invoke.mockReset()
    channels.length = 0
  })

  it('serializes writes: the second waits for the first even if the first resolves later', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    invoke.mockImplementation(async (cmd: string, args?: { data?: string }) => {
      if (cmd === 'pty_spawn') return { id: 'sess-1', mark: 'm1' }
      if (cmd === 'pty_write') {
        order.push(`start:${args?.data}`)
        if (args?.data === 'paste') await new Promise<void>((r) => (releaseFirst = r))
        order.push(`end:${args?.data}`)
      }
    })
    const h = await spawnPty({ cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    h.write('paste')
    h.write('\r')
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['start:paste'])
    releaseFirst()
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['start:paste', 'end:paste', 'start:\r', 'end:\r'])
  })

  it('a failed write does not block later writes', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockImplementation(async (cmd: string, args?: { data?: string }) => {
      if (cmd === 'pty_spawn') return { id: 'sess-1', mark: 'm1' }
      if (args?.data === 'bad') throw new Error('boom')
    })
    const h = await spawnPty({ cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    h.write('bad')
    h.write('ok')
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).toHaveBeenCalledWith('pty_write', { id: 'sess-1', data: 'ok' })
    errSpy.mockRestore()
  })
})
