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
    invoke.mockImplementation(async (cmd: string) => (cmd === 'pty_spawn' ? 'sess-1' : undefined))
  })

  it('passes cwd/cols/rows and both channels to pty_spawn', async () => {
    const h = await spawnPty({ cwd: '/tmp', cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    expect(h.id).toBe('sess-1')
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
    expect(invoke).toHaveBeenCalledWith('pty_write', { id: 'sess-1', data: 'ls\n' })
    expect(invoke).toHaveBeenCalledWith('pty_resize', { id: 'sess-1', cols: 100, rows: 30 })
    expect(invoke).toHaveBeenCalledWith('pty_kill', { id: 'sess-1' })
  })
})
