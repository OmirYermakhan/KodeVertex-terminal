// Мини-просмотр значка (макет 06, сцены Б и Д): один на панель. Открывается наведением (с задержкой,
// держится, пока мышь над значком или над карточкой) или ␣ у значка в строке ввода; esc или уход
// мыши закрывают. Клавиши сюда передаёт строка ввода (только активная: выключенная клавиш не берёт).
import { createContext, useContext, useEffect, useState } from 'react'
import type { Attachment } from '../types'
import { keyAction, type KeyLikePv, type PreviewAction, type PreviewFrom } from './actions'
import { loadPreview, type PreviewData } from './api'

/** Задержка наведения до показа. */
export const HOVER_MS = 250
/** Мышь ушла со значка: столько ждём, не перейдёт ли она на карточку. */
export const LEAVE_MS = 160

export interface PreviewTarget {
  token: Attachment
  from: PreviewFrom
  /** Элемент значка (якорь). Строка ввода перерисовывает значки: тогда ищем по data-tk в root. */
  el: HTMLElement
  root: HTMLElement | null
  /** hover — наведением; key — ␣ в строке ввода. */
  via: 'hover' | 'key'
  /** Просмотр забирает ↵/⌫/esc. Наведённый отдаёт их, как только пользователь начал печатать. */
  keys: boolean
}

export interface PreviewState {
  target: PreviewTarget | null
  data: PreviewData | null
  page: number
  /** ↵ на картинке: полный размер поверх панели. */
  overlay: { path: string; label: string } | null
}

export interface PreviewApi {
  hover(token: Attachment, el: HTMLElement, from: PreviewFrom): void
  leave(): void
  enterCard(): void
  leaveCard(): void
  /** ␣: открыть сразу; тот же значок уже открыт — закрыть. */
  toggle(token: Attachment, el: HTMLElement, from: PreviewFrom): void
  /** Клавиша из строки ввода; true — съедена просмотром. */
  key(e: KeyLikePv): boolean
  close(): void
  /** Закрыть, если просмотр открыт со значка оттуда (строка ввода выключилась). */
  closeFrom(from: PreviewFrom): void
  closeOverlay(): void
  isOpen(id?: string): boolean
  /** Действие из карточки (клик по подсказке). */
  act(a: PreviewAction): void
}

export interface PreviewHandlers {
  /** open / jump / remove — их выполняет панель; overlay, page, close — сам просмотр. */
  onAction(a: PreviewAction, token: Attachment): void
}

const CLOSED: PreviewState = { target: null, data: null, page: 1, overlay: null }

export function createPreview(publish: (s: PreviewState) => void, handlers: () => PreviewHandlers): PreviewApi {
  let cur = CLOSED
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  /** Значок, наведение на который ждёт задержки. */
  let pending: string | null = null
  const set = (s: PreviewState) => {
    cur = s
    publish(s)
  }
  const stopTimers = () => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    pending = null
  }
  const load = (token: Attachment, page: number) => {
    const n = ++seq
    const p = loadPreview(token, page)
    if (!p) return
    void p.then((data) => {
      if (n === seq && cur.target?.token.id === token.id) set({ ...cur, data, page: data.kind === 'pdf' ? data.page : page })
    })
  }
  const open = (token: Attachment, el: HTMLElement, from: PreviewFrom, via: 'hover' | 'key') => {
    stopTimers()
    const root = el.closest<HTMLElement>('.in-ta, .feed')
    set({ ...cur, target: { token, el, root, from, via, keys: true }, data: null, page: 1 })
    load(token, 1)
  }
  const close = () => {
    stopTimers()
    seq++
    if (cur.target) set({ ...cur, target: null, data: null, page: 1 })
  }
  const scheduleClose = () => {
    clearTimeout(closeTimer)
    if (cur.target?.via === 'hover') closeTimer = setTimeout(close, LEAVE_MS)
  }
  const run = (a: PreviewAction) => {
    const t = cur.target?.token
    if (!t) return
    switch (a.type) {
      case 'close':
        return close()
      case 'overlay':
        close()
        return set({ ...cur, overlay: { path: a.path, label: a.label } })
      case 'page': {
        const d = cur.data
        if (d?.kind !== 'pdf') return
        const page = Math.min(Math.max(1, cur.page + a.delta), d.pages)
        if (page === cur.page) return
        set({ ...cur, page })
        return load(t, page)
      }
      default:
        close()
        handlers().onAction(a, t)
    }
  }
  return {
    hover(token, el, from) {
      clearTimeout(closeTimer)
      if (cur.target?.token.id === token.id || pending === token.id) return
      clearTimeout(openTimer)
      pending = token.id
      openTimer = setTimeout(() => {
        pending = null
        open(token, el, from, 'hover')
      }, HOVER_MS)
    },
    leave() {
      clearTimeout(openTimer)
      pending = null
      scheduleClose()
    },
    enterCard: () => clearTimeout(closeTimer),
    leaveCard: scheduleClose,
    toggle(token, el, from) {
      if (cur.target?.token.id === token.id) return close()
      open(token, el, from, 'key')
    },
    key(e) {
      const t = cur.target
      if (!t || !t.keys) return false
      const a = keyAction(t.token, cur.data, t.from, e)
      if (a) {
        run(a)
        return true
      }
      if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return false
      // Открытый ␣ просмотр закрывается любой другой клавишей; наведённый — перестаёт брать клавиши.
      if (t.via === 'key') close()
      else set({ ...cur, target: { ...t, keys: false } })
      return false
    },
    close,
    closeFrom(from) {
      if (cur.target?.from === from) close()
    },
    closeOverlay() {
      if (cur.overlay) set({ ...cur, overlay: null })
    },
    isOpen: (id) => !!cur.target && (id === undefined || cur.target.token.id === id),
    act: run,
  }
}

export function usePreview(handlers: PreviewHandlers): { state: PreviewState; api: PreviewApi } {
  const [state, setState] = useState<PreviewState>(CLOSED)
  const [box] = useState(() => {
    let current = handlers
    return { api: createPreview(setState, () => current), set: (h: PreviewHandlers) => void (current = h) }
  })
  useEffect(() => box.set(handlers))
  const api = box.api
  useEffect(() => () => api.close(), [api])
  return { state, api }
}

/** Просмотр для значков в ленте (пузырь «Вы»): без провайдера значки просмотра не показывают. */
export const PreviewContext = createContext<PreviewApi | null>(null)
export const usePreviewApi = () => useContext(PreviewContext)
