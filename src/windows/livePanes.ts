// Живое состояние панелей для переноса вкладки между окнами: TerminalPane отдаёт его по запросу
// (реестр как setPaneFeed), принятая панель забирает своё при монтировании; панели, которые
// переезжают, при размонтировании не убивают PTY и процесс claude.

/** Живой PTY панели и всё, без чего блок и ввод в новом окне сломались бы. */
export interface LivePane {
  ptyId: string
  /** Метка маркеров OSC 133/7 сессии. */
  mark: string
  /** Хост первого OSC 7 нашей оболочки (этот компьютер). */
  localHost: string | null
  cwd: string | null
  /** Идёт команда (между 133;C и D): блок ленты «идёт» и в новом окне. */
  running: boolean
  /** Интеграция потеряна (`exec zsh`): обычный терминал поверх ленты. */
  raw: boolean
  /** Команда, после которой интеграция потеряна. */
  rawCommand: string
  /** Первое приглашение оболочки уже было (быстрый вход не ждёт его заново). */
  promptSeen: boolean
  /** Активен alt screen (vim, htop). */
  alt: boolean
  /** Команда заходила в alt screen. */
  altUsed: boolean
  /** ZLE во вторичном приглашении (PS2). */
  cont: boolean
  /** Отправленная строка, ждущая 133;I. */
  sent: string | null
  /** Строка, принятая ZLE (133;I), команда ещё не запустилась. */
  accepted: string | null
  /** Строка курсора в момент отправки команды (эхо ZLE). */
  echoRow: number | null
  /** Размер xterm-источника: снимок пишется в нём, потом — подгонка под новое окно. */
  cols: number
  rows: number
  /** SerializeAddon.serialize(): экран и scrollback живого xterm. */
  xterm: string
}

/** Источник живого состояния смонтированной панели: null — PTY нет (ещё не запущен или вышел). */
export type LiveSource = {
  /** Снимок после отсоединения PTY: дождаться разбора уже полученного вывода и сериализовать. */
  capture(): Promise<LivePane | null>
  /** id сессии PTY (для pty_detach до снимка); null — PTY нет. */
  ptyId(): string | null
}

const sources = new Map<string, LiveSource>()

export function setLiveSource(paneId: string, s: LiveSource): void {
  sources.set(paneId, s)
}

export function dropLiveSource(paneId: string, s: LiveSource): void {
  if (sources.get(paneId) === s) sources.delete(paneId)
}

export function liveSource(paneId: string): LiveSource | undefined {
  return sources.get(paneId)
}

/** Панели, уезжающие в другое окно: их размонтирование не убивает PTY и claude. */
const moving = new Set<string>()

export function markMoving(paneId: string): void {
  moving.add(paneId)
}

export function isMoving(paneId: string): boolean {
  return moving.has(paneId)
}

/** Панель снова в этом окне (вкладку вернули) или перенос отменён. */
export function clearMoving(paneId: string): void {
  moving.delete(paneId)
}

/** Принятые живые PTY: панель забирает своё при монтировании. */
const adopted = new Map<string, { live: LivePane; kill?: ReturnType<typeof setTimeout> }>()

export function offerLive(paneId: string, live: LivePane): void {
  const cur = adopted.get(paneId)
  clearTimeout(cur?.kill)
  adopted.set(paneId, { live })
}

/** Забрать принятый PTY панели (один раз): отложенное убийство (см. reofferLive) отменяется. */
export function takeLive(paneId: string): LivePane | null {
  const cur = adopted.get(paneId)
  if (!cur) return null
  clearTimeout(cur.kill)
  adopted.delete(paneId)
  return cur.live
}

/**
 * Принятая панель размонтирована, не переезжая. В StrictMode (dev) это повторный запуск эффекта —
 * панель тут же заберёт PTY снова; иначе панель закрыли — через такт PTY убивается.
 */
export function reofferLive(paneId: string, live: LivePane, kill: () => void): void {
  const t = setTimeout(() => {
    if (adopted.get(paneId)?.kill !== t) return
    adopted.delete(paneId)
    kill()
  }, 0)
  adopted.set(paneId, { live, kill: t })
}

/** Для тестов. */
export function resetLivePanesForTests(): void {
  sources.clear()
  moving.clear()
  for (const v of adopted.values()) clearTimeout(v.kill)
  adopted.clear()
}
