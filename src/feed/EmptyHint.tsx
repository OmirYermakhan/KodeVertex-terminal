// Пустая лента: по центру — карточка с главными клавишами (как .ks макета 04, в токенах темы).
// Клавиши — из настоящих привязок (KEYMAP и клавиши строки ввода), не текстом.
import { actionKeys, bindingKeys, INPUT_BINDINGS } from '../keys/keymap'

export const EMPTY_TITLE = 'С чего начать'

export interface HintRow {
  label: string
  /** Клавиши (каждая — отдельной .kbd) или команда (code). */
  keys?: string[]
  command?: string
}

/** claude — режим Claude панели (↵ уже спрашивает Claude): свои строки, без «Команда ↵». */
export function emptyHintRows(claude = false): HintRow[] {
  if (claude)
    return [
      { label: 'Спросить Claude', keys: bindingKeys(INPUT_BINDINGS.run) },
      { label: 'Файл или блок в сообщение', command: '@' },
      { label: 'Сменить модель', command: '/model' },
      { label: 'История сообщений', keys: bindingKeys(INPUT_BINDINGS.history) },
      { label: 'Палитра команд', keys: actionKeys('palette') },
      { label: 'Назад в оболочку', command: '/exit' },
    ]
  return [
    { label: 'Команда', keys: bindingKeys(INPUT_BINDINGS.run) },
    { label: 'Спросить Claude', keys: bindingKeys(INPUT_BINDINGS.ask) },
    { label: 'Режим карточек Claude', command: 'claude' },
    { label: 'Палитра команд', keys: actionKeys('palette') },
    { label: 'История команд', keys: bindingKeys(INPUT_BINDINGS.history) },
    { label: 'Разделить панель', keys: actionKeys('splitRight') },
  ]
}

export function EmptyHint({ claude = false }: { claude?: boolean }) {
  return (
    <div className="feed-empty">
      <div className="ks" role="note" aria-label={EMPTY_TITLE}>
        <h3>{EMPTY_TITLE}</h3>
        <ul>
          {emptyHintRows(claude).map((r) => (
            <li key={r.label}>
              <span>{r.label}</span>
              <span className="ks-k">
                {r.command ? (
                  <code className="kbd">{r.command}</code>
                ) : (
                  r.keys!.map((k, i) => (
                    <span key={i} className="kbd">
                      {k}
                    </span>
                  ))
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
