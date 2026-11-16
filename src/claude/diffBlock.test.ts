import { describe, expect, it } from 'vitest'
import { diffToHast, looksLikeDiff, parseDiff } from './diffBlock'

type N = { type: string; value?: string; properties?: { className?: string[] }; children?: N[] }
const text = (n: N): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(text).join(''))
const cls = (n: N) => n.properties?.className ?? []
const has = (n: N, c: string): boolean => cls(n).includes(c) || (n.children ?? []).some((k) => has(k, c))

const DIFF = `@@ -1,3 +1,4 @@ object RemoteConfig {
     return result
-    val a = "x"
+    fun isTrusted(host: String?): Boolean {
+        return false`

describe('блок diff в ответе', () => {
  it('строки по видам: кусок, контекст, удалена, добавлена', () => {
    expect(parseDiff(DIFF).map((l) => l.kind)).toEqual(['h', 'c', 'd', 'a', 'a'])
    expect(parseDiff('diff --git a/x.kt b/x.kt\n--- a/x.kt\n+++ b/x.kt\n@@ -1 +1 @@\n--- sql comment').map((l) => l.kind)).toEqual(['m', 'm', 'm', 'h', 'd'])
  })

  it('узнаёт diff без пометки языка', () => {
    expect(looksLikeDiff('@@ -1,2 +1,2 @@\n x')).toBe(true)
    expect(looksLikeDiff('diff --git a/a b/a')).toBe(true)
    expect(looksLikeDiff('ls -la\n+ total')).toBe(false)
  })

  it('текст при копировании тот же, что был; код подсвечен языком из подсказки, а не весь зелёным', () => {
    const lines = diffToHast(DIFF, 'kotlin') as N[]
    expect(lines.map(text).join('')).toBe(DIFF + '\n')
    expect(lines.map((l) => cls(l)[1])).toEqual(['h', 'c', 'd', 'a', 'a'])
    expect(has(lines[3], 'hljs-keyword')).toBe(true)
    expect(has(lines[2], 'hljs-string')).toBe(true)
    expect(has(lines[3], 'hljs-addition')).toBe(false)
  })

  it('язык — из заголовка +++ своего файла', () => {
    const d = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n+def f(): return None'
    const lines = diffToHast(d, 'kotlin') as N[]
    expect(has(lines[4], 'hljs-keyword')).toBe(true)
  })
})
