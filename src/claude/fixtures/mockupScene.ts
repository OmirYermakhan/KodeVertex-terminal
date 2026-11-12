// Сцена макета 04-main-window (панель агентов и статус-бар) — для тестов.
import { initialClaude, type Agent, type ClaudeState } from '../reducer'

export const T0 = 1_000_000
export const agent = (a: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent => ({
  parentId: null,
  model: null,
  status: 'running',
  now: '',
  history: [],
  step: null,
  startedAt: T0,
  endedAt: null,
  tokens: 0,
  ...a,
})

export function mockupScene(): ClaudeState {
  return {
    ...initialClaude(),
    model: 'claude-opus-5-5',
    busy: true,
    contextUsed: 84000,
    contextMax: 200000,
    currentAgentId: 'arch',
    agents: [
      agent({
        id: 'arch', name: 'Архитектор', model: 'claude-fable-5-2', now: 'Проектирует модуль оплаты',
        history: ['Читает PaymentApi.kt', 'Пишет PaymentService.kt', 'Проектирует модуль оплаты'],
        step: { n: 2, m: 3 }, startedAt: T0 - 130_000, tokens: 51_000,
      }),
      agent({ id: 'css', parentId: 'arch', name: 'Стили', model: 'claude-sonnet-5-5', now: 'Читает form.css', step: { n: 3, m: 7 }, startedAt: T0 - 41_000, tokens: 12_000 }),
      agent({ id: 'main', name: 'Главный', model: 'claude-opus-5-5', status: 'waiting', now: 'Ждёт вашего ответа: удалить старый API?', startedAt: T0 - 182_000, tokens: 84_000 }),
      agent({ id: 'find', parentId: 'main', name: 'Поиск', model: 'claude-haiku-5-5', status: 'done', now: 'Готово', startedAt: T0 - 60_000, endedAt: T0 - 42_000, tokens: 6_000 }),
    ],
  }
}

