import { describe, expect, it } from 'vitest'
import { isLocalHost, parseOsc7, parseOsc7Url } from './osc'

describe('parseOsc7', () => {
  it('decodes host-qualified file URL', () => {
    expect(parseOsc7('file://mac/Users/me/a%20b')).toBe('/Users/me/a b')
  })
  it('accepts empty host', () => {
    expect(parseOsc7('file:///tmp')).toBe('/tmp')
  })
  it('decodes UTF-8 percent-encoding', () => {
    expect(parseOsc7('file://h/%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82')).toBe('/Привет')
  })
  it('rejects non-file URLs', () => {
    expect(parseOsc7('http://x/y')).toBeNull()
  })
  it('rejects empty string', () => {
    expect(parseOsc7('')).toBeNull()
  })
})

describe('parseOsc7Url / isLocalHost', () => {
  it('возвращает хост', () => {
    expect(parseOsc7Url('file://mac.local/a%20b')).toEqual({ host: 'mac.local', path: '/a b' })
    expect(parseOsc7Url('file:///x')).toEqual({ host: '', path: '/x' })
  })
  it('пустой, localhost и свой хост — локальные; чужой — нет', () => {
    expect(isLocalHost('', 'mac')).toBe(true)
    expect(isLocalHost('localhost', 'mac')).toBe(true)
    expect(isLocalHost('MAC', 'mac')).toBe(true)
    expect(isLocalHost('server', 'mac')).toBe(false)
    expect(isLocalHost('mac', null)).toBe(true)
  })
})
