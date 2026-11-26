import { describe, expect, it } from 'vitest'
import { authCommand, isAuthLogin, isClaudeExit, isModelCommand, parseClaudeCommand } from './claudeCommand'

describe('parseClaudeCommand', () => {
  it('`claude` без аргументов — режим Claude', () => {
    expect(parseClaudeCommand('claude')).toEqual({ kind: 'enter' })
    expect(parseClaudeCommand('  claude  ')).toEqual({ kind: 'enter' })
  })

  it('`claude <текст>` — вопрос, одна пара кавычек снимается', () => {
    expect(parseClaudeCommand('claude почему упал тест?')).toEqual({ kind: 'ask', text: 'почему упал тест?' })
    expect(parseClaudeCommand('claude "объясни код"')).toEqual({ kind: 'ask', text: 'объясни код' })
    expect(parseClaudeCommand("claude 'a > b?'")).toEqual({ kind: 'ask', text: 'a > b?' })
    expect(parseClaudeCommand('claude "скажи \\"привет\\""')).toEqual({ kind: 'ask', text: 'скажи \\"привет\\"' })
    // Несколько строк в кавычках — как есть.
    expect(parseClaudeCommand('claude "a" "b"')).toEqual({ kind: 'ask', text: '"a" "b"' })
    expect(parseClaudeCommand("claude 'it''s'")).toEqual({ kind: 'ask', text: "'it''s'" })
    expect(parseClaudeCommand('claude "незакрытая')).toEqual({ kind: 'ask', text: '"незакрытая' })
  })

  it('`claude --tui [args]` — настоящий TUI без --tui', () => {
    expect(parseClaudeCommand('claude --tui -c')).toEqual({ kind: 'shell', cmd: 'claude -c' })
    expect(parseClaudeCommand('claude --tui')).toEqual({ kind: 'shell', cmd: 'claude' })
    expect(parseClaudeCommand('claude -c --tui')).toEqual({ kind: 'shell', cmd: 'claude -c' })
    // --tui ищется только среди ведущих флагов.
    expect(parseClaudeCommand('claude -p "x" --tui')).toEqual({ kind: 'shell', cmd: 'claude -p "x" --tui' })
  })

  it('флаги и подкоманды — в оболочку без изменений', () => {
    for (const cmd of ['claude --version', 'claude -p "x"', 'claude mcp list', 'claude config get', 'claude update', 'claude doctor', 'claude plugin list', 'claude agents', 'claude auth login', 'claude auth status']) {
      expect(parseClaudeCommand(cmd)).toEqual({ kind: 'shell', cmd })
    }
  })

  it('конвейеры и перенаправления — в оболочку без изменений', () => {
    for (const cmd of ['claude | tee log', 'claude && ls', 'claude > f', 'claude &', 'claude -p x | jq', 'claude 2>err', 'claude объясни; ls', 'claude a || b']) {
      expect(parseClaudeCommand(cmd)).toEqual({ kind: 'shell', cmd })
    }
  })

  it('прочие команды — в оболочку', () => {
    expect(parseClaudeCommand('ls -la')).toEqual({ kind: 'shell', cmd: 'ls -la' })
    expect(parseClaudeCommand('claudette')).toEqual({ kind: 'shell', cmd: 'claudette' })
    expect(parseClaudeCommand('cl')).toEqual({ kind: 'shell', cmd: 'cl' })
    expect(parseClaudeCommand('echo claude')).toEqual({ kind: 'shell', cmd: 'echo claude' })
  })
})

describe('isClaudeExit', () => {
  it('/exit и exit выходят из режима', () => {
    expect(isClaudeExit('/exit')).toBe(true)
    expect(isClaudeExit(' exit ')).toBe(true)
    expect(isClaudeExit('exit please')).toBe(false)
  })
})

describe('isModelCommand', () => {
  it('только `/model` (с пробелами по краям)', () => {
    expect(isModelCommand('/model')).toBe(true)
    expect(isModelCommand(' /model ')).toBe(true)
    expect(isModelCommand('/model opus')).toBe(false)
    expect(isModelCommand('/models')).toBe(false)
  })
})

describe('authCommand', () => {
  it('`/login` и `/logout` — `claude auth …`, остальное — null', () => {
    expect(authCommand('/login')).toBe('claude auth login')
    expect(authCommand('  /logout ')).toBe('claude auth logout')
    expect(authCommand('/login x')).toBeNull()
    expect(authCommand('login')).toBeNull()
  })
})

describe('isAuthLogin', () => {
  it('`claude auth login` с флагами — да; logout, status и другое — нет', () => {
    expect(isAuthLogin('claude auth login')).toBe(true)
    expect(isAuthLogin('  claude  auth login --console ')).toBe(true)
    expect(isAuthLogin('claude auth logout')).toBe(false)
    expect(isAuthLogin('claude auth status')).toBe(false)
    expect(isAuthLogin('echo claude auth login')).toBe(false)
  })
})
