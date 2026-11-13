import { describe, expect, it } from 'vitest'
import { isLocalHost, parseOsc7, parseOsc7Url, unmark } from './osc'

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

describe('unmark', () => {
  const M = '0123456789abcdef0123456789abcdef'
  it('верная метка — нагрузка без неё', () => {
    expect(unmark(`A;kv=${M}`, M)).toBe('A')
    expect(unmark(`A;k=s;kv=${M}`, M)).toBe('A;k=s')
    expect(unmark(`C;ZWNobyBoaQ==;kv=${M}`, M)).toBe('C;ZWNobyBoaQ==')
    expect(unmark(`D;0;kv=${M}`, M)).toBe('D;0')
    expect(unmark(`file://mac/a%3Bb;kv=${M}`, M)).toBe('file://mac/a%3Bb')
  })
  it('без метки — подделка, null', () => {
    for (const d of ['A', 'D;0', 'C;ZWNobyBoaQ==', 'I', 'file:///etc', '']) expect(unmark(d, M)).toBeNull()
  })
  it('чужая, неполная или лишняя метка — null', () => {
    expect(unmark('D;0;kv=deadbeef', M)).toBeNull()
    expect(unmark(`D;0;kv=${M.slice(1)}`, M)).toBeNull()
    expect(unmark(`D;0;kv=${M}0`, M)).toBeNull()
    expect(unmark(`D;0;kv=${M.toUpperCase()}`, M)).toBeNull()
    // Метка не последним параметром: после неё подставили своё.
    expect(unmark(`D;0;kv=${M};kv=x`, M)).toBeNull()
    expect(unmark('D;0;kv=', M)).toBeNull()
  })
  it('сессия ещё не запущена (метки нет) — всё игнорируется', () => {
    expect(unmark(`A;kv=${M}`, null)).toBeNull()
    expect(unmark('A;kv=', '')).toBeNull()
  })
})
