// Правка отправленного сообщения: блок над строкой ввода (в .dock, как очередь и вопросы агента) —
// какое сообщение правится и что сделает ↵, до того как это случится.
import type { EditInfo } from './reducer'
import { EDIT_FILES, EDIT_KEYS, editEffect } from './editText'

export function EditChip({ info }: { info: EditInfo }) {
  return (
    <div className="editdock" role="status" aria-label="Редактирование сообщения">
      <div className="dh">
        <span>
          ✎ Редактирование · сообщение <b>{info.n}</b> из <b>{info.total}</b>
        </span>
        <span className="keys">{EDIT_KEYS}</span>
      </div>
      <div className="ed-line">{editEffect(info)}</div>
      {info.files && <div className="ed-line ed-warn">{EDIT_FILES}</div>}
    </div>
  )
}

export default EditChip
