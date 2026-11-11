const FILE_URL = /^file:\/\/[^/]*(\/.*)$/

/** OSC 7 payload ("file://host/path", percent-encoded) -> absolute path, or null. */
export function parseOsc7(data: string): string | null {
  const m = FILE_URL.exec(data.trim())
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}
