import { Channel, invoke } from '@tauri-apps/api/core'

export interface PtyHandle {
  id: string
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
  const onData = new Channel<unknown>((m) => o.onData(toBytes(m)))
  const onExit = new Channel<number | null>((code) => o.onExit(code ?? null))
  const id = await invoke<string>('pty_spawn', {
    cwd: o.cwd,
    cols: o.cols,
    rows: o.rows,
    onData,
    onExit,
  })
  return {
    id,
    write(data) {
      invoke('pty_write', { id, data }).catch(report('pty_write'))
    },
    resize(cols, rows) {
      invoke('pty_resize', { id, cols, rows }).catch(report('pty_resize'))
    },
    kill() {
      invoke('pty_kill', { id }).catch(report('pty_kill'))
    },
  }
}
