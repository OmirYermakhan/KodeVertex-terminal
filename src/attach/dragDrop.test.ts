import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const { DROP_TITLE, dropSubline, handleDragEvent, registerDropTarget, setAttachCount, useAttachCount, useDrop } = await import('./dragDrop')
const { screenshotLabel } = await import('./api')
const { atContext } = await import('../completion/completion')

describe('перетаскивание файлов из Finder', () => {
  beforeEach(() => useDrop.setState({ paneId: null, paths: [] }))

  it('enter — оверлей у панели (под курсором, иначе в фокусе); drop — пути ей; leave — убрать', () => {
    const got = vi.fn()
    const off = registerDropTarget('p1', got)
    const pos = { x: 10, y: 10 }
    handleDragEvent({ type: 'enter', paths: ['/a/mockup.pdf', '/a/b.png'], position: pos }, () => 'p1')
    expect(useDrop.getState()).toEqual({ paneId: 'p1', paths: ['/a/mockup.pdf', '/a/b.png'] })
    handleDragEvent({ type: 'over', position: pos }, () => 'p1')
    handleDragEvent({ type: 'drop', paths: ['/a/mockup.pdf', '/a/b.png'], position: pos }, () => 'p1')
    expect(got).toHaveBeenCalledWith(['/a/mockup.pdf', '/a/b.png'])
    expect(useDrop.getState().paneId).toBeNull()
    handleDragEvent({ type: 'enter', paths: ['/x'], position: pos }, () => 'p1')
    handleDragEvent({ type: 'leave' }, () => 'p1')
    expect(useDrop.getState().paneId).toBeNull()
    off()
    handleDragEvent({ type: 'enter', paths: ['/x'], position: pos }, () => 'p1')
    expect(useDrop.getState().paneId).toBeNull()
  })

  it('подписи оверлея по макету', () => {
    expect(DROP_TITLE).toBe('Отпустите, чтобы вставить в сообщение')
    expect(dropSubline(['/a/mockup.pdf', '/b', '/c'])).toBe('mockup.pdf и ещё 2 · встанут туда, где курсор')
    expect(dropSubline(['/a/styles/'])).toBe('styles · встанет туда, где курсор')
  })

  it('счётчик вложений панели', () => {
    setAttachCount('p', 3)
    expect(useAttachCount.getState().counts.p).toBe(3)
  })
})

describe('скрины и @', () => {
  it('«скрин», затем «скрин 2»…', () => {
    expect(screenshotLabel([])).toBe('скрин')
    const s = { id: '1', kind: 'image' as const, label: 'скрин' }
    expect(screenshotLabel([s, { ...s, id: '2', label: 'скрин 2' }, { ...s, id: '3', label: 'a.png' }])).toBe('скрин 3')
  })
  it('`@путь` у курсора: после пробела, значка или в начале; не внутри слова', () => {
    expect(atContext('см @src/Fo', 10)).toMatchObject({ command: '@', tokenStart: 3, token: '@src/Fo', dirPart: 'src/', namePart: 'Fo' })
    expect(atContext('@', 1)).toMatchObject({ tokenStart: 0, namePart: '' })
    expect(atContext('\ufffc@a', 3)).toMatchObject({ tokenStart: 1 })
    expect(atContext('mail@host', 9)).toBeNull()
    expect(atContext('@ab cd', 2)).toBeNull()
    expect(atContext('нет', 3)).toBeNull()
  })
})
