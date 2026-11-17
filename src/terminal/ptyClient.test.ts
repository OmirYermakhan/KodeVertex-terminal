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

  it('pause/resume — pty_pause/pty_resume; сбой команды не бросает', async () => {
    const h = await spawnPty({ cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    invoke.mockImplementation((cmd: string) => (cmd === 'pty_pause' ? Promise.reject(new Error('unknown command')) : Promise.resolve()))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.pause!()
    h.resume!()
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).toHaveBeenCalledWith('pty_pause', { id: 'sess-1' })
    expect(invoke).toHaveBeenCalledWith('pty_resume', { id: 'sess-1' })
    err.mockRestore()
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

describe('detachPty / attachPty', () => {
  beforeEach(() => {
    invoke.mockReset()
    channels.length = 0
  })

  it('attach — новые каналы; вывод и выход приходят в новые обработчики', async () => {
    invoke.mockResolvedValue(undefined)
    const { attachPty } = await import('./ptyClient')
    const onData = vi.fn()
    const onExit = vi.fn()
    const h = await attachPty({ id: 'sess-1', mark: 'm1', onData, onExit })
    expect(invoke).toHaveBeenCalledWith('pty_attach', { id: 'sess-1', onData: channels[0], onExit: channels[1] })
    expect(h.id).toBe('sess-1')
    expect(h.mark).toBe('m1')
    channels[0].onmessage(new Uint8Array([1, 2]).buffer)
    expect(Array.from(onData.mock.calls[0][0] as Uint8Array)).toEqual([1, 2])
    channels[1].onmessage(7)
    expect(onExit).toHaveBeenCalledWith(7)
    h.write('x')
    await Promise.resolve()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('pty_write', { id: 'sess-1', data: 'x' })
  })

  it('attach ждёт идущего detach той же сессии (порядок async-команд)', async () => {
    const { attachPty, detachPty } = await import('./ptyClient')
    let release!: () => void
    invoke.mockImplementation((cmd: string) => (cmd === 'pty_detach' ? new Promise<void>((r) => (release = r)) : Promise.resolve()))
    const d = detachPty('s9')
    const a = attachPty({ id: 's9', mark: 'm', onData: () => {}, onExit: () => {} })
    await Promise.resolve()
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['pty_detach'])
    release()
    await d
    await a
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['pty_detach', 'pty_attach'])
  })

  it('attach неизвестной сессии — ошибка', async () => {
    const { attachPty } = await import('./ptyClient')
    invoke.mockRejectedValue('unknown pty')
    await expect(attachPty({ id: 'zz', mark: 'm', onData: () => {}, onExit: () => {} })).rejects.toBe('unknown pty')
  })
})
