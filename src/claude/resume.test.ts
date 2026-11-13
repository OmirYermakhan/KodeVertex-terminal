import { describe, expect, it } from 'vitest'
import { ago, historyItems, initialResume, resumeKey, sessionDetail, type SessionInfo } from './resume'

const row = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: `t-${id}`, modified: 0, messages: 3, partial: false, ...over })

describe('resumeKey', () => {
  const s = { ...initialResume(), rows: [row('a'), row('b'), row('c')] }

  it('↑↓ по кругу, цифры — сразу на строку, ↵ — выбранный, esc — отмена', () => {
    expect(resumeKey(s, 'ArrowDown').state.selected).toBe(1)
    expect(resumeKey(s, 'ArrowUp').state.selected).toBe(2)
    expect(resumeKey(s, '3').state.selected).toBe(2)
    expect(resumeKey(s, '4').handled).toBe(false)
    expect(resumeKey({ ...s, selected: 1 }, 'Enter').action).toEqual({ kind: 'choose', session: s.rows[1] })
    expect(resumeKey(s, 'Escape').action).toEqual({ kind: 'cancel' })
    expect(resumeKey(s, 'x').handled).toBe(false)
  })

  it('пока список читается или пуст — ↵ ничего не выбирает, стрелки не ломаются', () => {
    const loading = initialResume()
    expect(resumeKey(loading, 'Enter')).toMatchObject({ action: null, handled: true })
    expect(resumeKey(loading, 'ArrowDown').state.selected).toBe(0)
    expect(resumeKey({ ...loading, rows: [] }, 'ArrowUp').state.selected).toBe(0)
  })
})

describe('ago / sessionDetail', () => {
  const now = new Date(2026, 10, 13, 12, 0).getTime()
  it('относительное время', () => {
    expect(ago(now - 10_000, now)).toBe('только что')
    expect(ago(now - 5 * 60_000, now)).toBe('5 мин назад')
    expect(ago(now - 3 * 3600_000, now)).toBe('3 ч назад')
    expect(ago(now - 30 * 3600_000, now)).toBe('вчера')
    expect(ago(now - 4 * 86400_000, now)).toBe('4 дн назад')
    expect(ago(new Date(2026, 0, 2).getTime(), now)).toMatch(/^2 янв/)
    expect(ago(new Date(2024, 0, 2).getTime(), now)).toMatch(/2024/)
  })

  it('«когда · сколько сообщений»; файл не дочитан — «N+»', () => {
    expect(sessionDetail(row('a', { modified: now - 120_000, messages: 14 }), now)).toBe('2 мин назад · 14 сообщений')
    expect(sessionDetail(row('a', { modified: now, messages: 21, partial: true }), now)).toBe('только что · 21+ сообщение')
  })
})

describe('historyItems', () => {
  it('заметка, «раньше ещё», затем «Вы» и ответы главного агента (не стрим)', () => {
    const items = historyItems('Заголовок', {
      skipped: 5,
      messages: [
        { role: 'user', text: 'вопрос' },
        { role: 'assistant', text: 'ответ' },
      ],
    })
    expect(items).toEqual([
      { type: 'note', text: 'Разговор продолжен · Заголовок' },
      { type: 'note', text: '… раньше ещё 5 сообщений' },
      { type: 'user', text: 'вопрос' },
      { type: 'assistant', agentId: 'main', text: 'ответ', streaming: false },
    ])
    expect(historyItems('x', { skipped: 0, messages: [] })).toEqual([{ type: 'note', text: 'Разговор продолжен · x' }])
  })
})
