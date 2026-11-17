import { Channel, invoke } from '@tauri-apps/api/core'

export interface PtyHandle {
  id: string
  /** Метка маркеров OSC 133/7 этой сессии: маркеры без неё — не от нашей оболочки. */
  mark: string
  write(s: string): void
  resize(c: number, r: number): void
  kill(): void
  /** Приостановить чтение вывода PTY (xterm не успевает разбирать): программа упрётся в полный буфер. */
  pause?(): void
  /** Продолжить чтение после pause. */
  resume?(): void
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

function makeHandle(id: string, mark: string): PtyHandle {
  // pty_write is an async command: concurrent invokes may be reordered on the Rust side,
  // so each write waits for the previous one.
  let writes: Promise<unknown> = Promise.resolve()
  return {
    id,
    mark,
    write(data) {
      writes = writes.then(() => invoke('pty_write', { id, data })).catch(report('pty_write'))
    },
    resize(cols, rows) {
      invoke('pty_resize', { id, cols, rows }).catch(report('pty_resize'))
    },
    kill() {
      // После отсоединения/подключения (перенос вкладки) — по порядку с ними.
      void after(id, () => invoke('pty_kill', { id })).catch(report('pty_kill'))
    },
    // Сбой (например, старая сборка без этих команд) безвреден: вывод просто не придерживается.
    pause() {
      invoke('pty_pause', { id }).catch(report('pty_pause'))
    },
    resume() {
      invoke('pty_resume', { id }).catch(report('pty_resume'))
    },
  }
}

/**
 * pty_detach / pty_attach / pty_kill одной сессии — по порядку: это async-команды, и attach,
 * обогнавший detach (StrictMode перемонтирует принятую панель), оставил бы сессию на паузе.
 */
const ops = new Map<string, Promise<unknown>>()

function after<T>(id: string, f: () => Promise<T>): Promise<T> {
  const prev = ops.get(id)
  // Без идущих операций — сразу (синхронно, как остальные команды).
  const next = prev ? prev.catch(() => {}).then(f) : Promise.resolve(f())
  ops.set(id, next)
  const done = () => {
    if (ops.get(id) === next) ops.delete(id)
  }
  next.then(done, done)
  return next
}

/**
 * Маркер конца при pty_detach: Rust шлёт в старый канал пустой кусок последним сообщением (настоящий
 * вывод пустым не бывает). Большие куски канал Tauri отдаёт отдельным запросом, и ответ pty_detach
 * может их обогнать — снимок экрана для переноса делается только после маркера.
 */
export const DETACH_END_WAIT_MS = 2000
const endWaiters = new Map<string, () => void>()

/** Кусок из канала вывода: пустой — маркер конца (не в onData). */
function deliverChunk(id: string | null, b: Uint8Array, onData: (b: Uint8Array) => void): void {
  if (b.length > 0) {
    onData(b)
    return
  }
  const f = id === null ? undefined : endWaiters.get(id)
  if (f) {
    endWaiters.delete(id!)
    f()
  }
}

/** Убить сессию по id (без дескриптора: принятая панель закрыта до pty_attach). */
export function killPty(id: string): void {
  void after(id, () => invoke('pty_kill', { id })).catch(report('pty_kill'))
}

/**
 * Отсоединить сессию от этого окна (перенос вкладки): вывод копится в Rust до pty_attach. Промис
 * разрешается, когда весь вывод до отсоединения уже отдан onData (пришёл маркер конца; не дольше
 * DETACH_END_WAIT_MS). Ждёт идущих pty_attach / pty_detach этой сессии.
 */
export function detachPty(id: string): Promise<void> {
  return after(id, async () => {
    let done!: () => void
    const ended = new Promise<void>((r) => (done = r))
    // До invoke: маркер может прийти раньше ответа.
    endWaiters.set(id, done)
    try {
      const marked = await invoke<boolean | null>('pty_detach', { id })
      if (marked !== true) return
      let t: ReturnType<typeof setTimeout> | undefined
      await Promise.race([ended, new Promise<void>((r) => (t = setTimeout(r, DETACH_END_WAIT_MS)))])
      clearTimeout(t)
    } finally {
      if (endWaiters.get(id) === done) endWaiters.delete(id)
    }
  })
}

export interface AttachOptions {
  id: string
  mark: string
  onData: (b: Uint8Array) => void
  onExit: (code: number | null) => void
}

/**
 * Подключить отсоединённую сессию к этому окну (новые каналы): накопленный вывод придёт первым;
 * оболочка уже вышла — сразу onExit. Неизвестный id — ошибка.
 */
export async function attachPty(o: AttachOptions): Promise<PtyHandle> {
  const onData = new Channel<unknown>((m) => deliverChunk(o.id, toBytes(m), o.onData))
  const onExit = new Channel<number | null>((code) => o.onExit(code ?? null))
  await after(o.id, () => invoke('pty_attach', { id: o.id, onData, onExit }))
  return makeHandle(o.id, o.mark)
}

export async function spawnPty(o: SpawnOptions): Promise<PtyHandle> {
  // До ответа pty_spawn вывод и выход копятся по порядку и отдаются после onSpawn.
  let pending: (() => void)[] | null = []
  const deliver = (f: () => void) => (pending ? pending.push(f) : f())
  // id сессии — из ответа pty_spawn (маркер конца приходит только после него: pty_detach).
  let sid: string | null = null
  const onData = new Channel<unknown>((m) => {
    const b = toBytes(m)
    deliver(() => deliverChunk(sid, b, o.onData))
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
  sid = res.id
  const handle = makeHandle(res.id, res.mark)
  o.onSpawn?.(handle)
  const queued = pending
  pending = null
  for (const f of queued) f()
  return handle
}
