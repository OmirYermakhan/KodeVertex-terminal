import { Component, type ErrorInfo, type ReactNode } from 'react'
import { describeError, logError } from './log'

interface Props {
  /** Что ловим — для журнала и текста заглушки («карточку», «панель вопросов»…). */
  name: string
  /**
   * inline — небольшая заглушка на месте упавшего куска, остальное окно работает;
   * window — последняя линия: всё окно с текстом ошибки и перезагрузкой.
   */
  variant?: 'inline' | 'window'
  /** Сброс ошибки при смене значения (например, новый элемент в том же месте). */
  resetKey?: unknown
  children: ReactNode
}

interface State {
  error: unknown
  stack: string | null
  key: unknown
}

/**
 * Ловушка ошибок отрисовки. Без неё исключение в любом компоненте размонтирует
 * всё дерево React — окно становится пустым.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('неизвестная ошибка') }
  }

  static getDerivedStateFromProps(p: Props, s: State): Partial<State> | null {
    return p.resetKey !== s.key ? { error: null, stack: null, key: p.resetKey } : null
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    logError(this.props.name, error, info.componentStack)
    this.setState({ stack: info.componentStack ?? null })
  }

  private retry = () => this.setState({ error: null, stack: null })

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children
    const text = describeError(error)
    const first = text.split('\n')[0]
    if (this.props.variant === 'window') {
      return (
        <div className="crash" role="alert">
          <p>Интерфейс упал. Ошибка записана в журнал приложения.</p>
          <pre className="crash-text">{describeError(error, stack)}</pre>
          <div className="crash-actions">
            <button type="button" onClick={() => location.reload()}>
              Перезагрузить окно
            </button>
            <button type="button" className="ghost" onClick={this.retry}>
              Попробовать продолжить
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="crash-inline" role="alert" title={text}>
        <span>Не удалось показать {this.props.name}: {first}</span>
        <button type="button" onClick={this.retry}>
          Повторить
        </button>
      </div>
    )
  }
}
