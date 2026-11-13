export type Action =
  | 'splitRight' | 'splitDown' | 'newTab' | 'closePane'
  | 'focusLeft' | 'focusRight' | 'focusUp' | 'focusDown'
  | 'tab1' | 'tab2' | 'tab3' | 'tab4' | 'tab5' | 'tab6' | 'tab7' | 'tab8' | 'tab9'
  | 'prevTab' | 'nextTab'
  | 'fontBigger' | 'fontSmaller' | 'fontReset' | 'openSettings'
  | 'blockPrev' | 'blockNext' | 'blockCopy' | 'blockAttach' | 'blockRead' | 'blockAsk'
  | 'toggleAgents' | 'find' | 'palette'

export interface Binding {
  action: Action
  /** KeyboardEvent.code (физическая клавиша — не зависит от раскладки). */
  key: string
  meta?: boolean
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}

const cmd = (action: Action, key: string, mods: Partial<Binding> = {}): Binding => ({
  action,
  key,
  meta: true,
  ...mods,
})

export const KEYMAP: Binding[] = [
  cmd('splitRight', 'KeyD'),
  cmd('splitDown', 'KeyD', { shift: true }),
  cmd('newTab', 'KeyT'),
  cmd('closePane', 'KeyW'),
  cmd('focusLeft', 'ArrowLeft', { alt: true }),
  cmd('focusRight', 'ArrowRight', { alt: true }),
  cmd('focusUp', 'ArrowUp', { alt: true }),
  cmd('focusDown', 'ArrowDown', { alt: true }),
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => cmd(`tab${n}` as Action, `Digit${n}`)),
  cmd('prevTab', 'BracketLeft', { shift: true }),
  cmd('nextTab', 'BracketRight', { shift: true }),
  cmd('fontBigger', 'Equal'),
  cmd('fontBigger', 'Equal', { shift: true }), // ⌘+
  cmd('fontBigger', 'NumpadAdd'),
  cmd('fontSmaller', 'Minus'),
  cmd('fontSmaller', 'NumpadSubtract'),
  cmd('fontReset', 'Digit0'),
  cmd('openSettings', 'Comma'),
  cmd('blockPrev', 'ArrowUp'),
  cmd('blockNext', 'ArrowDown'),
  cmd('blockCopy', 'KeyC', { shift: true }),
  // ⌘L: выбранный блок или сообщение — значком в строку ввода (макет 06, сцена Г).
  cmd('blockAttach', 'KeyL'),
  // ⌘R: выбранный (или последний) ответ — в режиме чтения.
  cmd('blockRead', 'KeyR'),
  // ⌘⇧A: выбранный упавший блок — «Спросить Claude».
  cmd('blockAsk', 'KeyA', { shift: true }),
  cmd('toggleAgents', 'KeyJ'),
  // ⌘F: поиск в ленте фокусной панели.
  cmd('find', 'KeyF'),
  // ⌘P: палитра команд.
  cmd('palette', 'KeyP'),
]

export function matchKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey'>,
): Action | null {
  const b = KEYMAP.find(
    (k) =>
      k.key === e.code &&
      !!k.meta === e.metaKey &&
      !!k.shift === e.shiftKey &&
      !!k.alt === e.altKey &&
      !!k.ctrl === e.ctrlKey,
  )
  return b ? b.action : null
}

const MOD_ORDER: ['ctrl' | 'alt' | 'meta' | 'shift', string][] = [
  ['ctrl', '⌃'],
  ['alt', '⌥'],
  ['meta', '⌘'],
  ['shift', '⇧'],
]
const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Escape: 'esc',
  Comma: ',',
  Equal: '=',
  Minus: '−',
}

type Keys = Pick<Binding, 'key' | 'meta' | 'shift' | 'alt' | 'ctrl'>

/** Клавиши привязки для подсказок: ['⌘', '⇧', 'D'] (порядок модификаторов — как в меню macOS и макете). */
export function bindingKeys(b: Keys): string[] {
  const mods = MOD_ORDER.filter(([k]) => b[k]).map(([, s]) => s)
  const key = KEY_NAMES[b.key] ?? b.key.replace(/^(Key|Digit)/, '')
  return [...mods, key]
}

/** Клавиши действия из KEYMAP (первая привязка). */
export function actionKeys(action: Action): string[] {
  const b = KEYMAP.find((k) => k.action === action)
  return b ? bindingKeys(b) : []
}

/**
 * Клавиши строки ввода — их обрабатывает InputBar, а не KEYMAP: ↵ — команда оболочке,
 * ⌘↵ — спросить Claude, ⌃R — поиск по истории команд (InputBar сверяет ⌃R с history).
 */
export const INPUT_BINDINGS = {
  run: { key: 'Enter' },
  ask: { key: 'Enter', meta: true },
  history: { key: 'KeyR', ctrl: true },
} as const satisfies Record<string, Keys>

/** Нажатие — ровно эта привязка (по физической клавише, модификаторы все совпадают). */
export function isBinding(b: Keys, e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey'>): boolean {
  return b.key === e.code && !!b.meta === e.metaKey && !!b.shift === e.shiftKey && !!b.alt === e.altKey && !!b.ctrl === e.ctrlKey
}
