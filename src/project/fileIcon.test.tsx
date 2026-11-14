import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fileIcon, folderKind } from './fileIcon'

const icon = (name: string) => {
  const { container } = render(<>{fileIcon(name)}</>)
  const el = container.querySelector('.fi')!
  return [el.className.replace(/^fi pfi /, ''), el.textContent]
}

describe('fileIcon', () => {
  it('значки как в макете: K, G, X, M, ≡', () => {
    expect(icon('PaymentApi.kt')).toEqual(['kt', 'K'])
    expect(icon('build.gradle.kts')).toEqual(['gr', 'G'])
    expect(icon('build.gradle')).toEqual(['gr', 'G'])
    expect(icon('AndroidManifest.xml')).toEqual(['xml', 'X'])
    expect(icon('README.md')).toEqual(['md', 'M'])
    expect(icon('.gitignore')).toEqual(['txt', '≡'])
    expect(icon('Makefile')).toEqual(['txt', '≡'])
  })
  it('языки — своим цветом, буква — первая буква расширения', () => {
    expect(icon('main.ts')).toEqual(['ts', 'T'])
    expect(icon('App.tsx')).toEqual(['ts', 'T'])
    expect(icon('lib.rs')).toEqual(['rs', 'R'])
    expect(icon('package.json')).toEqual(['json', 'J'])
    expect(icon('run.py')).toEqual(['py', 'P'])
    expect(icon('index.JS')).toEqual(['js', 'J'])
  })
  it('папки: исходники — синие, ресурсы — жёлтые, прочие — серые', () => {
    expect(folderKind('app/src/main/java')).toBe('src')
    expect(folderKind('app/src/test/kotlin')).toBe('src')
    expect(folderKind('src')).toBe('src')
    expect(folderKind('app/src/main/res')).toBe('res')
    expect(folderKind('app/src/main/resources')).toBe('res')
    expect(folderKind('app')).toBe('')
    expect(folderKind('app/src/main/java/com')).toBe('')
  })
})
