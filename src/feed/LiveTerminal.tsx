import { useLayoutEffect, useRef, type RefObject } from 'react'

export interface LiveTerminalProps {
  /** Общий для панели элемент, в котором открыт xterm. */
  host: HTMLElement
  /** Куда вернуть host, когда живой терминал больше не показан. */
  parkRef: RefObject<HTMLElement | null>
  /** block — внутри running-блока, overlay — вся панель (alt screen). */
  mode: 'block' | 'overlay'
  /** Высота host в режиме block (по ней FitAddon считает rows). */
  hostHeight: number
  /** Видимая высота в режиме block: по содержимому, не больше hostHeight. */
  height: number
  /** host перенесён в слот: подогнать размер, перерисовать, отдать фокус. */
  onAttach: () => void
}

/**
 * Слот живого xterm. Сам терминал один на панель: его host-элемент переносится в слот
 * (running-блок или оверлей) и обратно в «парковку», которая держит ширину текста блока,
 * поэтому cols совпадают с шириной ленты и замороженный вывод переносится так же.
 */
export function LiveTerminal({ host, parkRef, mode, hostHeight, height, onAttach }: LiveTerminalProps) {
  const slotRef = useRef<HTMLDivElement>(null)
  const attachRef = useRef(onAttach)
  useLayoutEffect(() => {
    attachRef.current = onAttach
  })

  useLayoutEffect(() => {
    const slot = slotRef.current
    const park = parkRef.current
    if (!slot) return
    host.style.height = mode === 'overlay' ? '100%' : `${hostHeight}px`
    slot.appendChild(host)
    attachRef.current()
    return () => {
      if (host.parentElement !== slot) return
      host.style.height = `${hostHeight}px`
      park?.appendChild(host)
    }
  }, [host, parkRef, mode, hostHeight])

  return (
    <div
      ref={slotRef}
      className={mode === 'overlay' ? 'live live-overlay' : 'live'}
      data-testid={`live-${mode}`}
      style={mode === 'block' ? { height } : undefined}
    />
  )
}
