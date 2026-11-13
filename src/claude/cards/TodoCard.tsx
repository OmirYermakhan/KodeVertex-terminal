import { memo } from 'react'
import type { Todo } from '../reducer'

const BOX = { pending: '☐', in_progress: '◐', completed: '☑' } as const

/** План агента (TodoWrite): «ПЛАН · n из m», пункты с ☐/◐/☑; текущий — --accText, сделанные — зачёркнуты. */
export const TodoCard = memo(function TodoCard({ id, todos }: { id?: string; todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="plan" data-item-id={id}>
      <div className="who">
        План · {done} из {todos.length}
      </div>
      <ul className="plan-list">
        {todos.map((t, i) => (
          <li key={i} className={'plan-i ' + t.status}>
            <span className="plan-box" aria-hidden="true">
              {BOX[t.status]}
            </span>
            <span className="plan-t">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
})
