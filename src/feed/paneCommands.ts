// Команды ленты (⌘↑/⌘↓/⌘⇧C/⌘L, ⌘F) идут через общий keymap → runAction → обработчик фокусной панели.
export type BlockAction = 'blockPrev' | 'blockNext' | 'blockCopy' | 'blockAttach' | 'blockRead'
/** Плюс команды палитры ⌘P для строки ввода и ленты фокусной панели. */
export type PaneAction = BlockAction | 'find' | 'clearFeed' | 'claudeToggle' | 'chooseModel'

/** Что палитре нужно знать о панели (подпись «Режим Claude: включить/выключить»). */
export interface PaneInfo {
  claude: boolean
}

type Handler = (a: PaneAction) => void
const handlers = new Map<string, Handler>()
const infos = new Map<string, () => PaneInfo>()

export function registerPaneCommands(paneId: string, h: Handler, info?: () => PaneInfo): () => void {
  handlers.set(paneId, h)
  if (info) infos.set(paneId, info)
  return () => {
    if (handlers.get(paneId) === h) {
      handlers.delete(paneId)
      infos.delete(paneId)
    }
  }
}

export function paneInfo(paneId: string): PaneInfo | null {
  return infos.get(paneId)?.() ?? null
}

export function runPaneCommand(paneId: string, a: PaneAction): void {
  handlers.get(paneId)?.(a)
}
