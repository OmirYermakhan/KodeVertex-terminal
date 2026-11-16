import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

const { openUrl } = await import('@tauri-apps/plugin-opener')
const { answerLink, askOpenLink, linkHost, misleadingText, useLinkAsk } = await import('./linkAsk')

describe('misleadingText: текст ссылки выдаёт себя за другой адрес', () => {
  it('домен или URL в тексте, ведущие на другой хост, — да', () => {
    expect(misleadingText('github.com', 'https://evil.example')).toBe(true)
    expect(misleadingText('https://github.com/acme/repo', 'https://evil.example/acme')).toBe(true)
    expect(misleadingText('www.paypal.com', 'https://paypal.com.evil.example')).toBe(true)
    // IDN: текст кириллицей, ссылка — на punycode другого домена.
    expect(misleadingText('аpple.com', 'https://apple.com')).toBe(true)
  })

  it('тот же хост, www, поддомен показанного, порт — нет', () => {
    expect(misleadingText('github.com', 'https://github.com/x')).toBe(false)
    expect(misleadingText('www.github.com', 'https://github.com')).toBe(false)
    expect(misleadingText('github.com', 'https://docs.github.com/a')).toBe(false)
    expect(misleadingText('GitHub.com/acme', 'https://github.com:443/acme')).toBe(false)
  })

  it('обычный текст и имена файлов — нет', () => {
    expect(misleadingText('документация', 'https://evil.example')).toBe(false)
    expect(misleadingText('см. тут', 'https://evil.example')).toBe(false)
    expect(misleadingText('README.md', 'https://github.com/a/README.md')).toBe(false)
    expect(misleadingText('package.json', 'https://evil.example')).toBe(false)
    // Со схемой — адрес, даже если зона похожа на расширение.
    expect(misleadingText('https://x.md', 'https://evil.example')).toBe(true)
  })
})

describe('вопрос «Открыть ссылку»', () => {
  beforeEach(() => {
    useLinkAsk.setState({ asks: {} })
    vi.mocked(openUrl).mockClear()
  })

  it('хост; «Открыть» — в браузер, «Отмена» — ничего; повторный ответ — ничего', () => {
    expect(linkHost('https://a.example:8080/x')).toBe('a.example:8080')
    expect(linkHost('mailto:me@x.org')).toBe('me@x.org')
    askOpenLink('p', 'https://a.example/x')
    expect(useLinkAsk.getState().asks.p).toEqual({ url: 'https://a.example/x', host: 'a.example' })
    answerLink('p', false)
    expect(useLinkAsk.getState().asks.p).toBeUndefined()
    expect(openUrl).not.toHaveBeenCalled()
    askOpenLink('p', 'https://a.example/y')
    answerLink('p', true)
    answerLink('p', true)
    expect(vi.mocked(openUrl).mock.calls).toEqual([['https://a.example/y']])
  })
})
