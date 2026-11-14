// Схема mermaid картинкой: <img src="blob:…">, под ней «Исходник» и «Копировать».
import { useEffect, useState } from 'react'
import { useSettings } from '../../settings/store'
import { useCopied } from './useCopied'
import { cachedDiagram, renderDiagram, type DiagramResult } from './render'

export function Diagram({ source }: { source: string }) {
  const theme = useSettings((s) => s.settings.theme)
  const key = `${theme}\n${source}`
  // Результат хранится вместе с ключом: сменились тема или исходник — старый результат не показываем.
  const [done, setDone] = useState<{ key: string; res: DiagramResult }>()
  const [showSource, setShowSource] = useState(false)
  const [copied, copy] = useCopied()
  const res = done?.key === key ? done.res : cachedDiagram(source, theme)

  useEffect(() => {
    if (cachedDiagram(source, theme)) return
    let alive = true
    void renderDiagram(source, theme).then((r) => {
      if (alive) setDone({ key: `${theme}\n${source}`, res: r })
    })
    return () => {
      alive = false
    }
  }, [source, theme])

  const ok = res?.ok === true
  return (
    <div className="dg">
      {ok ? (
        <div className="dg-pic">
          <img alt="Схема" src={res.url} />
        </div>
      ) : (
        <div className="dg-note">{res ? 'Схему не удалось нарисовать' : 'Схема рисуется…'}</div>
      )}
      {(!ok || showSource) && (
        <pre className="dg-src">
          <code>{source}</code>
        </pre>
      )}
      <div className="dg-bar">
        {ok && (
          <button type="button" className="dg-btn" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
            Исходник
          </button>
        )}
        <button type="button" className="dg-btn" onClick={() => copy(source)}>
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
    </div>
  )
}
