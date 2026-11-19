import { invoke } from '@tauri-apps/api/core'

export interface PickOptions {
  directory?: boolean
  multiple?: boolean
  title?: string
  filters?: { name: string; extensions: string[] }[]
}

/**
 * Системный диалог выбора (src-tauri/src/pick.rs). Отмена — [].
 * Если macOS не дал создать панель, промис отклоняется строкой, которую можно показать человеку.
 */
export function pickPaths(o: PickOptions = {}): Promise<string[]> {
  return invoke<string[]>('pick_paths', {
    directory: !!o.directory,
    multiple: !!o.multiple,
    title: o.title ?? null,
    filters: o.filters ?? null,
  })
}
