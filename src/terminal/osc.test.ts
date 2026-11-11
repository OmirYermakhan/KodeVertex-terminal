import { describe, expect, it } from 'vitest'
import { parseOsc7 } from './osc'

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
