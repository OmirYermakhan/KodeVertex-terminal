import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { matchKey } from '../../keys/keymap'
import { AssistantCard } from '../cards/AssistantCard'
import { isLongAnswer, loadReaderSize, READER_DEFAULT, ReaderView, stepReaderSize } from './ReaderView'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

const doc = '# Путь кода\n\nтекст\n\n## DevOps\n\nещё\n\n### Kubernetes\n\nподы\n\n## Backend\n\nконец'

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* нет хранилища */
  }
})

describe('ReaderView', () => {
  it('оглавление из заголовков h1–h3, текущий — первый', () => {
    render(<ReaderView title="Главный · Opus 5.5" text={doc} streaming={false} onClose={() => {}} />)
    const items = Array.from(document.querySelectorAll('.rd-toc-i')).map((b) => b.textContent)
    expect(items).toEqual(['Путь кода', 'DevOps', 'Kubernetes', 'Backend'])
    expect(document.querySelector('.rd-toc-i.on')?.textContent).toBe('Путь кода')
    expect(document.querySelector('.rd-toc-i.l3')?.textContent).toBe('Kubernetes')
  })

  it('без заголовков оглавления нет', () => {
    render(<ReaderView title="x" text="просто текст" streaming={false} onClose={() => {}} />)
    expect(document.querySelector('.rd-toc')).toBeNull()
  })

  it('⎋ и «Закрыть» закрывают', () => {
    const onClose = vi.fn()
    render(<ReaderView title="x" text={doc} streaming={false} onClose={onClose} />)
    fireEvent.keyDown(document.querySelector('.rd-scroll')!, { key: 'Escape' })
    fireEvent.click(screen.getByText(/Закрыть/))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('A+/A− меняют размер текста и запоминают его', () => {
    render(<ReaderView title="x" text={doc} streaming={false} onClose={() => {}} />)
    const body = document.querySelector<HTMLElement>('.rd-body')!
    expect(body.style.getPropertyValue('--rd-size')).toBe(`${READER_DEFAULT}px`)
    fireEvent.click(screen.getByLabelText('Крупнее'))
    expect(body.style.getPropertyValue('--rd-size')).toBe('18px')
    expect(loadReaderSize()).toBe(18)
  })

  it('шаги размера в пределах', () => {
    expect(stepReaderSize(17, 1)).toBe(18)
    expect(stepReaderSize(14, -1)).toBe(14)
    expect(stepReaderSize(24, 1)).toBe(24)
    expect(stepReaderSize(99, 1)).toBe(18)
  })
})

describe('кнопка «Читать» и ⌘R', () => {
  it('длинный ответ или с заголовками — кнопка в шапке карточки', () => {
    expect(isLongAnswer('коротко')).toBe(false)
    expect(isLongAnswer('## Раздел\nтекст')).toBe(true)
    expect(isLongAnswer('a'.repeat(1300))).toBe(true)
    const onRead = vi.fn()
    render(<AssistantCard id="c1" agent={undefined} text={doc} streaming={false} onRead={onRead} />)
    fireEvent.click(document.querySelector('.read-btn')!)
    expect(onRead).toHaveBeenCalledWith('c1')
  })

  it('короткий ответ — без кнопки в шапке', () => {
    render(<AssistantCard id="c1" agent={undefined} text="да" streaming={false} onRead={() => {}} />)
    expect(document.querySelector('.read-btn')).toBeNull()
  })

  it('⌘R — действие blockRead', () => {
    expect(matchKey(new KeyboardEvent('keydown', { code: 'KeyR', metaKey: true }))).toBe('blockRead')
  })
})
