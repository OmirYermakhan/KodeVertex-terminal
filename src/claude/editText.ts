// Тексты блока правки сообщения (EditChip): что сделает ↵, до того как это случится.
import { messagesLabel, type EditInfo } from './reducer'

export const EDIT_KEYS = 'esc отменить — черновик вернётся'
export const EDIT_BUSY = '↵ остановит текущий ответ и отправит исправленный'
export const EDIT_LAST = '↵ заменит последний вопрос и ответ'
export const EDIT_FILES = 'Изменения файлов, сделанные после этого сообщения, не откатываются'

/** Что сделает ↵: зависит от того, последнее ли сообщение и идёт ли ответ. */
export function editEffect(info: EditInfo): string {
  if (info.after > 0) {
    const rest = info.after === 1 ? 'следующее сообщение уйдёт в историю' : `следующие ${messagesLabel(info.after)} уйдут в историю`
    return `↵ продолжит разговор с этого места; ${rest}`
  }
  return info.busy ? EDIT_BUSY : EDIT_LAST
}
