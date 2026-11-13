export type Action =
  | 'splitRight' | 'splitDown' | 'newTab' | 'closePane'
  | 'focusLeft' | 'focusRight' | 'focusUp' | 'focusDown'
  | 'tab1' | 'tab2' | 'tab3' | 'tab4' | 'tab5' | 'tab6' | 'tab7' | 'tab8' | 'tab9'
  | 'prevTab' | 'nextTab'
  | 'fontBigger' | 'fontSmaller' | 'fontReset' | 'openSettings'
  | 'blockPrev' | 'blockNext' | 'blockCopy' | 'blockAttach' | 'blockRead'
  | 'toggleAgents'

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
  cmd('toggleAgents', 'KeyJ'),
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
