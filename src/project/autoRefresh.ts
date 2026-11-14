// Панель проекта обновляется сама: после действий Claude, меняющих файлы, и при фокусе окна
// (конец команды оболочки — в TerminalPane). Частоту ограничивает refresh стора (500 мс).
import { onClaudeEvent } from '../claude/toolEvents'
import { useProject } from './store'

export function installAutoRefresh(): () => void {
  const offClaude = onClaudeEvent((e) => {
    const p = useProject.getState()
    if (e.kind === 'cleared') {
      p.clearClaudeTouched()
      return
    }
    for (const t of e.tools) if (t.ok && t.path) p.markClaudeTouched(t.path)
    p.refresh()
  })
  const onFocus = () => useProject.getState().refresh()
  window.addEventListener('focus', onFocus)
  return () => {
    offClaude()
    window.removeEventListener('focus', onFocus)
  }
}
