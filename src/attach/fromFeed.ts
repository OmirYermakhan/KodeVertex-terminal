// Значки из ленты (⌘L, перетаскивание): снимок блока терминала или ответа Claude в момент вставки.
import { blockText } from '../feed/blockHtml'
import type { FeedItem, ShellBlock } from '../feed/feed'
import type { Agent } from '../claude/reducer'
import { tailOutput } from './serialize'
import { attachmentId, type Attachment } from './types'

/** Подпись значка не длиннее (команда, начало сообщения). */
export const LABEL_MAX = 28
const SNIPPET_MAX = 18

function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : s
}

export function blockAttachment(b: ShellBlock): Attachment {
  return {
    id: attachmentId(),
    kind: 'block',
    label: clip(b.command.replace(/\s+/g, ' ').trim() || 'блок', LABEL_MAX),
    block: {
      command: b.command,
      exitCode: b.exitCode,
      cwd: b.cwd,
      output: b.html ? tailOutput(blockText(b.html)) : '',
      durationMs: b.durationMs,
      at: b.startedAt,
    },
  }
}

/** Markdown → строка для подписи: без разметки и переводов строк. */
function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function messageAttachment(text: string, agent: Agent | undefined): Attachment {
  const author = agent?.name ?? 'Claude'
  return {
    id: attachmentId(),
    kind: 'message',
    label: `${author}: «${clip(plain(text), SNIPPET_MAX)}»`,
    message: { author, model: agent?.model ?? null, text },
  }
}

/** Значок для элемента ленты (блок или ответ Claude); null — такой не вкладывается. */
export function feedAttachment(it: FeedItem | undefined, agents: readonly Agent[] = []): Attachment | null {
  if (!it) return null
  if (it.kind === 'shell') return it.running ? null : blockAttachment(it)
  const x = it.item
  if (x.type !== 'assistant' || x.streaming || !x.text.trim()) return null
  return messageAttachment(x.text, agents.find((a) => a.id === x.agentId))
}
