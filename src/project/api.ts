import { invoke } from '@tauri-apps/api/core'

export type Status = 'M' | 'A' | 'D' | 'R' | '?'

export interface Change {
  path: string
  oldPath?: string | null
  status: Status
  add?: number | null
  del?: number | null
}

export interface Commit {
  hash: string
  short: string
  subject: string
  author: string
  /** Unix-секунды. */
  time: number
  refs: string[]
  head: boolean
}

export interface DirEntry {
  name: string
  isDir: boolean
}

export interface DirList {
  entries: DirEntry[]
  more: number
}

export type FileText =
  | { kind: 'text'; lines: string[]; truncated: boolean; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

export const projectRoot = (cwd: string) => invoke<string>('project_root', { cwd })
export const projectList = (root: string, rel: string) => invoke<DirList>('project_list', { root, rel })
export const projectRead = (root: string, rel: string) => invoke<FileText>('project_read', { root, rel })
/** Отказ с текстом «not-git» — каталог не в git-репозитории. */
export const gitStatus = (root: string) => invoke<Change[]>('git_status', { root })
export const gitLog = (root: string, skip: number, limit: number) => invoke<Commit[]>('git_log', { root, skip, limit })
export const gitCommitFiles = (root: string, hash: string) => invoke<Change[]>('git_commit_files', { root, hash })
/** rev = null — изменения рабочего дерева. */
export const gitDiff = (root: string, rel: string, rev: string | null) => invoke<string>('git_diff', { root, rel, rev })
