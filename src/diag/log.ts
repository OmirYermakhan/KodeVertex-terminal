import { invoke } from '@tauri-apps/api/core'

/** Текст ошибки со стеком (и стеком компонентов React, если он есть). */
export function describeError(err: unknown, componentStack?: string | null): string {
  let s: string
  if (err instanceof Error) s = `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
  else {
    try {
      s = typeof err === 'string' ? err : JSON.stringify(err)
    } catch {
      s = String(err)
    }
  }
  return componentStack ? `${s}\nКомпоненты:${componentStack}` : s
}

/** Ошибка интерфейса — в журнал приложения; сбой самой записи не должен ронять ничего ещё. */
export function logError(where: string, err: unknown, componentStack?: string | null): void {
  const message = `[${where}] ${describeError(err, componentStack)}`
  console.error(message)
  try {
    invoke('frontend_log', { level: 'error', message }).catch(() => {})
  } catch {
    // вне Tauri (тесты, браузер) invoke недоступен
  }
}

/** Необработанные ошибки и отклонённые промисы — в журнал. Возвращает отписку. */
export function installGlobalErrorLog(): () => void {
  const onError = (e: ErrorEvent) => logError('window', e.error ?? e.message)
  const onRejection = (e: PromiseRejectionEvent) => logError('promise', e.reason)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
