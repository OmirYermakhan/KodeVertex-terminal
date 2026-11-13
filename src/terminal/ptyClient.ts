import { Channel, invoke } from '@tauri-apps/api/core'

export interface PtyHandle {
  id: string
  /** Метка маркеров OSC 133/7 этой сессии: маркеры без неё — не от нашей оболочки. */
  mark: string
  write(s: string): void
  resize(c: number, r: number): void
  kill(): void
}

export interface SpawnOptions {
  cwd?: string
  cols: number
  rows: number
  onData: (b: Uint8Array) => void
  onExit: (code: number | null) => void
  /**
   * Сессия запущена, метка известна. Вызывается до первого onData: вывод, пришедший раньше
   * ответа pty_spawn, придерживается до этого момента — иначе первые маркеры (приглашение,
   * OSC 7) пришли бы, когда метку ещё не с чем сравнить.
   */
  onSpawn?: (h: PtyHandle) => void
}

interface SpawnResult {
  id: string
  mark: string
}

// Raw InvokeResponseBody arrives as ArrayBuffer; tolerate typed arrays and JSON arrays too.
function toBytes(m: unknown): Uint8Array {
  if (m instanceof Uint8Array) return m
  if (m instanceof ArrayBuffer) return new Uint8Array(m)
  if (ArrayBuffer.isView(m)) return new Uint8Array(m.buffer, m.byteOffset, m.byteLength)
  if (Array.isArray(m)) return Uint8Array.from(m as number[])
  return new Uint8Array()
}

function report(cmd: string) {
  return (e: unknown) => console.error(`${cmd} failed:`, e)
}

export async function spawnPty(o: SpawnOptions): Promise<PtyHandle> {
  // До ответа pty_spawn вывод и выход копятся по порядку и отдаются после onSpawn.
  let pending: (() => void)[] | null = []
  const deliver = (f: () => void) => (pending ? pending.push(f) : f())
  const onData = new Channel<unknown>((m) => {
    const b = toBytes(m)
    deliver(() => o.onData(b))
  })
  const onExit = new Channel<number | null>((code) => deliver(() => o.onExit(code ?? null)))
  let res: SpawnResult
  try {
    res = await invoke<SpawnResult>('pty_spawn', {
      cwd: o.cwd,
      cols: o.cols,
      rows: o.rows,
      onData,
      onExit,
    })
  } catch (e) {
    pending = null
    throw e
  }
  const { id, mark } = res
  // pty_write is an async command: concurrent invokes may be reordered on the Rust side,
  // so each write waits for the previous one.
  let writes: Promise<unknown> = Promise.resolve()
  const handle: PtyHandle = {
    id,
    mark,
    write(data) {
      writes = writes.then(() => invoke('pty_write', { id, data })).catch(report('pty_write'))
    },
    resize(cols, rows) {
      invoke('pty_resize', { id, cols, rows }).catch(report('pty_resize'))
    },
    kill() {
      invoke('pty_kill', { id }).catch(report('pty_kill'))
    },
  }
  o.onSpawn?.(handle)
  const queued = pending
  pending = null
  for (const f of queued) f()
  return handle
}
