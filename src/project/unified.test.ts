import { describe, expect, it } from 'vitest'
import { parseUnified } from './unified'

describe('parseUnified', () => {
  it('несколько ханков, счётчики и номера', () => {
    const t = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@ fn
 ten
+eleven
 twelve
`
    const r = parseUnified(t)
    expect(r.hunks).toHaveLength(2)
    expect(r.hunks[0]).toEqual({ oldStart: 1, newStart: 1, lines: [' one', '-two', '+TWO', ' three'] })
    expect(r.hunks[1].oldStart).toBe(10)
    expect([r.add, r.del, r.truncated]).toEqual([2, 1, false])
  })
  it('пропускает «\\ No newline»', () => {
    const r = parseUnified('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n')
    expect(r.hunks[0].lines).toEqual(['-a', '+b'])
    expect([r.add, r.del]).toEqual([1, 1])
  })
  it('новый файл', () => {
    const r = parseUnified('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n')
    expect(r.hunks).toEqual([{ oldStart: 0, newStart: 1, lines: ['+a', '+b', '+c'] }])
    expect(r.add).toBe(3)
  })
  it('метка урезания выставляет truncated и не попадает в строки', () => {
    const r = parseUnified('@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ Изменения урезаны: больше 4 МБ\n')
    expect(r.truncated).toBe(true)
    expect(r.hunks[0].lines).toEqual([' a', '-b', '+c'])
  })
  it('строка «-- x» внутри ханка — удаление, пустая — контекст', () => {
    const r = parseUnified('@@ -1,3 +1,2 @@\n--- x\n\n z\n')
    expect(r.hunks[0].lines).toEqual(['--- x', ' ', ' z'])
    expect(r.del).toBe(1)
  })
  it('метка «Файл усечён» (большой неотслеживаемый) — fileCut, не truncated, не строка', () => {
    const r = parseUnified('--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ Файл усечён\n')
    expect(r.fileCut).toBe(true)
    expect(r.truncated).toBe(false)
    expect(r.hunks[0].lines).toEqual(['+a', '+b'])
  })
  it('пустой текст', () => {
    expect(parseUnified('')).toEqual({ hunks: [], add: 0, del: 0, truncated: false, fileCut: false })
  })
})
