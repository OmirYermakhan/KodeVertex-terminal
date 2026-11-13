const FILE_URL = /^file:\/\/([^/]*)(\/.*)$/

/** OSC 7 payload ("file://host/path", percent-encoded) -> host and absolute path, or null. */
export function parseOsc7Url(data: string): { host: string; path: string } | null {
  const m = FILE_URL.exec(data.trim())
  if (!m) return null
  try {
    return { host: m[1], path: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/** OSC 7 payload -> absolute path, or null. */
export function parseOsc7(data: string): string | null {
  return parseOsc7Url(data)?.path ?? null
}

/**
 * Хост из OSC 7 — этот компьютер? Пустой и localhost — да; иначе он должен совпасть с хостом
 * из первого OSC 7 нашей оболочки (`known`; null — ещё не было, тогда этот хост и есть свой).
 */
export function isLocalHost(host: string, known: string | null): boolean {
  const h = host.toLowerCase()
  if (h === '' || h === 'localhost') return true
  return known === null || h === known.toLowerCase()
}

/**
 * Маркер OSC 133/7 от нашей оболочки? Интеграция zsh дописывает последним параметром
 * `;kv=<метка сессии>` (метку выдаёт pty_spawn, командам она не видна). Совпала — полезная
 * нагрузка без метки; нет метки, чужая или сессия ещё не запущена (`mark` null) — null:
 * такой маркер мог напечатать кто угодно (`cat` файла, программа, ssh), его игнорируем.
 */
export function unmark(data: string, mark: string | null): string | null {
  if (!mark) return null
  const i = data.lastIndexOf(';kv=')
  if (i < 0 || data.slice(i + 4) !== mark) return null
  return data.slice(0, i)
}
