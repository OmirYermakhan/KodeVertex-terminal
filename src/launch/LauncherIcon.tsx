import type { LauncherIcon as IconId } from './launchers'

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const PATHS: Record<IconId, React.ReactNode> = {
  server: (
    <>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
      <path d="M4.5 4.75h.01M4.5 11.25h.01M8 4.75h3.5M8 11.25h3.5" />
    </>
  ),
  cloud: <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 6.6 3 3 0 0 0 4.5 12.5z" />,
  database: (
    <>
      <ellipse cx="8" cy="3.8" rx="5" ry="1.8" />
      <path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
    </>
  ),
  box: (
    <>
      <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" />
      <path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2z" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
      <path d="M4.5 6l2 2-2 2M8 10.5h3.5" />
    </>
  ),
  key: (
    <>
      <circle cx="5.2" cy="10.8" r="2.7" />
      <path d="M7.2 8.9L13 3.1M11 5.1l1.6 1.6M9.6 6.5l1.2 1.2" />
    </>
  ),
  rocket: (
    <>
      <path d="M9.5 2.2c2.2-.6 4.3-.4 4.3-.4s.2 2.1-.4 4.3c-.6 2.1-2.6 4-4.6 5.2L6.7 9.2C7.9 7.2 7.4 2.8 9.5 2.2z" />
      <path d="M6.7 9.2L4 8.5l1.8-2.6 2.4-.3M8.8 11.3l.7 2.7 2.6-1.8.3-2.4M4.2 11.8c-.8.3-1.4 1.6-1.4 1.6s1.3-.6 1.6-1.4" />
    </>
  ),
  shield: <path d="M8 1.8l5 2v4c0 3.2-2.2 5.3-5 6.4C5.2 13.1 3 11 3 7.8v-4z" />,
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <rect x="6.5" y="6.5" width="3" height="3" />
      <path d="M6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2" />
    </>
  ),
  flame: <path d="M8 14.2c2.8 0 4.5-1.9 4.5-4.4 0-3-2.6-4.4-3.2-7.6C7.2 3.6 6.5 5.6 6.8 7.2 5.8 6.8 5.2 5.9 5.1 5 4 6.2 3.5 7.6 3.5 9.8c0 2.5 1.7 4.4 4.5 4.4z" />,
  git: (
    <>
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="5.5" r="1.7" />
      <path d="M4 5.2v5.6M12 7.2c0 3-4 2.5-7.4 4" />
    </>
  ),
}

export const ICON_LABELS: Record<IconId, string> = {
  server: 'Сервер',
  cloud: 'Облако',
  database: 'База данных',
  box: 'Контейнер',
  globe: 'Сайт',
  terminal: 'Терминал',
  key: 'Ключ',
  rocket: 'Деплой',
  shield: 'Защищённый',
  cpu: 'Машина',
  flame: 'Прод',
  git: 'Git',
}

export function LauncherIcon({ icon, size = 16 }: { icon: IconId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...STROKE} aria-hidden="true">
      {PATHS[icon]}
    </svg>
  )
}
