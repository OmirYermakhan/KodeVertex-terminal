import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'

export interface GitInfo {
  root: string | null
  branch: string | null
  dirty: boolean
}

const POLL_MS = 5000

const parts = (p: string) => p.split(/[\\/]/).filter(Boolean)
const trimSep = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)

/** Имя папки корня репозитория, иначе имя папки cwd; для домашней папки — `~`. */
export function projectName(cwd: string, git: GitInfo | null, home = ''): string {
  if (git?.root) return parts(git.root).pop() ?? git.root
  if (home && trimSep(cwd) === trimSep(home)) return '~'
  return parts(cwd).pop() ?? '/'
}

/** `/Users/me/x` → `~/x` (без привязки к POSIX-разделителю). */
export function shortPath(cwd: string, home: string): string {
  const c = trimSep(cwd)
  const h = trimSep(home)
  if (!h) return cwd
  if (c === h) return '~'
  if (c.startsWith(h) && /[\\/]/.test(c[h.length])) return '~' + c.slice(h.length)
  return cwd
}

let homeCache = ''
let homePromise: Promise<string> | null = null

function loadHome(): Promise<string> {
  homePromise ??= homeDir()
    .then((h) => (homeCache = h))
    .catch(() => {
      homePromise = null
      return ''
    })
  return homePromise
}

/** $HOME (кэшируется); до загрузки — пустая строка. */
export function useHome(): string {
  const [home, setHome] = useState(homeCache)
  useEffect(() => {
    let alive = true
    loadHome().then((h) => alive && h && setHome(h))
    return () => {
      alive = false
    }
  }, [])
  return home
}

/** Git-состояние папки: при смене cwd, по фокусу окна и раз в 5 с, пока окно в фокусе. */
export function useGitInfo(cwd: string | undefined): GitInfo | null {
  const [state, setState] = useState<{ cwd: string; info: GitInfo } | null>(null)

  useEffect(() => {
    if (!cwd) return
    let alive = true
    let inFlight = false
    let issued = 0
    let applied = 0
    const refresh = () => {
      if (inFlight) return
      inFlight = true
      const id = ++issued
      const done = () => {
        inFlight = false
      }
      try {
        invoke<GitInfo>('git_info', { cwd }).then(
          (info) => {
            done()
            if (alive && id > applied) {
              applied = id
              setState({ cwd, info })
            }
          },
          done,
        )
      } catch {
        done() // вне Tauri (тесты)
      }
    }
    refresh()
    const timer = setInterval(() => document.hasFocus() && refresh(), POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [cwd])

  return cwd && state?.cwd === cwd ? state.info : null
}
