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
      <span className="th-k">esc — прервать</span>
    </div>
  )
}

/** «Ждём 1 фонового агента», «Ждём 3 фоновых агентов». */
export function bgWaitText(n: number): string {
  return `Ждём ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'фонового агента' : 'фоновых агентов'}`
}

/**
 * Строка в конце ленты, пока ход главного закончен, а фоновые агенты ещё работают (как «ждёт
 * фоновых агентов» в CLI): вид строки «Думает», без таймера — время каждого агента в панели ⌘J.
 */
export function BackgroundWaitRow({ count }: { count: number }) {
  return (
    <div className="thinking bgwait" role="status" aria-live="polite">
      <span className="spin" aria-hidden="true" />
      <span className="th-l">{bgWaitText(count)}</span>
      <span className="th-k">⌘J — агенты</span>
    </div>
  )
}
