// «Копировать» → «Скопировано» на полторы секунды.
import { useEffect, useState } from 'react'

export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => {})
  }
  return [copied, copy]
}
