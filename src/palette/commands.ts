// ⌘P — команды палитры: действия приложения (как с клавиш) и строки ввода фокусной панели.
import { fuzzyScore } from '../completion/completion'
import { runPaneCommand, type PaneAction } from '../feed/paneCommands'
import { runAction } from '../keys/actions'
import type { Action } from '../keys/keymap'
import { useTabs } from '../layout/tabsStore'
import { useSettings } from '../settings/store'
import { THEMES, type ThemeId } from '../theme/themes'

export interface PaletteCommand {
  /** Стабильный id: по нему запоминаются недавние. */
  id: string
  title: string
  /** Клавиши подсказки справа (каждая — отдельной клавишей kbd). */
  keys?: string[]
  /** Пояснение справа вместо клавиш (`/model`, «текущая»). */
  note?: string
  run(): void
}

export interface PaletteContext {
  theme: ThemeId
  agentsHidden: boolean
  /** Строка ввода фокусной панели в режиме Claude; null — панели нет. */
  claude: boolean | null
}

const app = (id: Action, title: string, keys?: string[]): PaletteCommand => ({ id, title, keys, run: () => runAction(id) })

function pane(id: PaneAction, title: string, keys?: string[], note?: string): PaletteCommand {
  return {
    id,
    title,
    keys,
    note,
    run: () => {
      const s = useTabs.getState()
      const t = s.tabs.find((x) => x.id === s.active)
      if (t) runPaneCommand(t.focused, id)
    },
  }
}

/** Все команды в порядке по умолчанию. */
export function paletteCommands(ctx: PaletteContext): PaletteCommand[] {
  // Темы — в том же порядке, что в настройках.
  const themes = (Object.keys(THEMES) as ThemeId[]).map(
    (id): PaletteCommand => ({
      id: `theme:${id}`,
      title: `Тема: ${THEMES[id].name}`,
      note: id === ctx.theme ? 'текущая' : undefined,
      run: () => useSettings.getState().update({ theme: id }),
    }),
  )
  const claudeRows: PaletteCommand[] =
    ctx.claude === null
      ? []
      : [
          pane('claudeToggle', ctx.claude ? 'Режим Claude: выключить' : 'Режим Claude: включить'),
          pane('chooseModel', 'Выбрать модель Claude', undefined, '/model'),
        ]
  return [
    app('splitRight', 'Разделить вправо', ['⌘', 'D']),
    app('splitDown', 'Разделить вниз', ['⌘', '⇧', 'D']),
    app('newTab', 'Новая вкладка', ['⌘', 'T']),
    app('closePane', 'Закрыть панель', ['⌘', 'W']),
    ...claudeRows,
    pane('clearFeed', 'Очистить ленту', ['⌃', 'L']),
    pane('find', 'Найти в ленте', ['⌘', 'F']),
    pane('historySearch', 'Поиск по истории', ['⌃', 'R']),
    app('toggleAgents', ctx.agentsHidden ? 'Показать панель агентов' : 'Скрыть панель агентов', ['⌘', 'J']),
    app('fontBigger', 'Крупнее шрифт', ['⌘', '=']),
    app('fontSmaller', 'Мельче шрифт', ['⌘', '−']),
    app('fontReset', 'Обычный размер шрифта', ['⌘', '0']),
    ...themes,
    app('openSettings', 'Настройки', ['⌘', ',']),
  ]
}

/**
 * Пустой запрос — недавние сверху (по свежести), дальше порядок по умолчанию.
 * С запросом — по совпадению (как подсказки путей); при том же роде совпадения — недавние раньше.
 */
export function rankCommands(cmds: PaletteCommand[], query: string, recent: readonly string[]): PaletteCommand[] {
  const rank = (id: string) => {
    const i = recent.indexOf(id)
    return i < 0 ? Infinity : i
  }
  const q = query.trim()
  const scored: { cmd: PaletteCommand; score: number; order: number }[] = []
  cmds.forEach((cmd, order) => {
    const score = q ? fuzzyScore(q, cmd.title) : 0
    if (score !== null) scored.push({ cmd, score, order })
  })
  // Род совпадения (начало / подстрока / вразбивку, см. fuzzyScore) важнее недавности, недавность — длины.
  const tier = (score: number) => Math.floor(score / 1000)
  scored.sort(
    (a, b) => tier(b.score) - tier(a.score) || rank(a.cmd.id) - rank(b.cmd.id) || b.score - a.score || a.order - b.order,
  )
  return scored.map((s) => s.cmd)
}
