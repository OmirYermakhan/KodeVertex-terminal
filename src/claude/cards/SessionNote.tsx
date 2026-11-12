import { memo } from 'react'
import { shortPath, useHome } from '../../status/useGitInfo'

/** Начало новой сессии Claude: тихая моноширинная строка с её каталогом. */
export const SessionNote = memo(function SessionNote({ cwd, id }: { cwd: string; id?: string }) {
  const home = useHome()
  return (
    <div className="cl-note" data-item-id={id}>
      Claude · {shortPath(cwd, home)}
    </div>
  )
})
