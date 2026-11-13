// Команды ленты (⌘↑/⌘↓/⌘⇧C/⌘L) идут через общий keymap → runAction → обработчик фокусной панели.
export type BlockAction = 'blockPrev' | 'blockNext' | 'blockCopy' | 'blockAttach' | 'blockRead'

type Handler = (a: BlockAction) => void
const handlers = new Map<string, Handler>()

export function registerPaneCommands(paneId: string, h: Handler): () => void {
  handlers.set(paneId, h)
  return () => {
    if (handlers.get(paneId) === h) handlers.delete(paneId)
  }
}

export function runPaneCommand(paneId: string, a: BlockAction): void {
  handlers.get(paneId)?.(a)
}
