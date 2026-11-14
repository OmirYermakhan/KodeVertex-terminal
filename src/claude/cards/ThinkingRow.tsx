import { useEffect, useState } from 'react'

/** «12 с», «1 мин 05 с». */
export function elapsedLabel(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec} с`
  return `${Math.floor(sec / 60)} мин ${String(sec % 60).padStart(2, '0')} с`
}

/** Строка в конце ленты, пока Claude думает: спиннер, «Думает», время хода и как прервать. */
export function ThinkingRow({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="thinking" role="status" aria-live="polite">
      <span className="spin" aria-hidden="true" />
      <span className="th-l">Думает</span>
      <span className="th-t">· {elapsedLabel(now - since)}</span>
      <span className="th-k">⌃C — прервать</span>
    </div>
  )
}
