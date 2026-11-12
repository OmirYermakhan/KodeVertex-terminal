import { memo } from 'react'
import { shortPath, useHome } from '../../status/useGitInfo'

/** Подсказка после входа в режим Claude командой `claude`. */
export const MODE_HINT = ' — пишите вопрос, /exit — выйти'

/** Начало новой сессии Claude (или вход в режим Claude): тихая моноширинная строка с её каталогом. */
export const SessionNote = memo(function SessionNote({ cwd, id, mode }: { cwd: string; id?: string; mode?: boolean }) {
  const home = useHome()
  return (
    <div className="cl-note" data-item-id={id}>
      Claude · {shortPath(cwd, home)}
      {mode && MODE_HINT}
    </div>
  )
})
