// Команды ленты (⌘↑/⌘↓/⌘⇧C/⌘L, ⌘F) идут через общий keymap → runAction → обработчик фокусной панели.
export type BlockAction = 'blockPrev' | 'blockNext' | 'blockCopy' | 'blockAttach' | 'blockRead'
export type PaneAction = BlockAction | 'find'

type Handler = (a: PaneAction) => void
const handlers = new Map<string, Handler>()

export function registerPaneCommands(paneId: string, h: Handler): () => void {
  handlers.set(paneId, h)
  return () => {
    if (handlers.get(paneId) === h) handlers.delete(paneId)
  }
}

export function runPaneCommand(paneId: string, a: PaneAction): void {
  handlers.get(paneId)?.(a)
}
