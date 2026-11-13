import { describe, expect, it } from 'vitest'
import { fileKind } from './fileKind'

describe('fileKind', () => {
  it.each([
    ['src', true, 'dir'],
    ['App.tsx', false, 'code'],
    ['main.RS', false, 'code'],
    ['run.sh', false, 'script'],
    ['index.html', false, 'web'],
    ['data.json', false, 'data'],
    ['logo.PNG', false, 'image'],
    ['a.mp4', false, 'media'],
    ['b.tar.gz', false, 'archive'],
    ['config.toml', false, 'config'],
    ['.env', false, 'config'],
    ['.env.local', false, 'config'],
    ['.environment', false, 'file'],
    ['yarn.lock', false, 'lock'],
    ['.gitignore', false, 'config'],
    ['README.md', false, 'md'],
    ['notes.txt', false, 'doc'],
    ['Cargo.lock', false, 'lock'],
    ['package-lock.json', false, 'lock'],
    ['lib.dylib', false, 'binary'],
    ['Makefile', false, 'config'],
    ['LICENSE', false, 'file'],
    ['.hidden', false, 'file'],
    ['trailing.', false, 'file'],
    ['dir.ts', true, 'dir'],
  ])('%s (dir=%s) -> %s', (name, isDir, kind) => {
    expect(fileKind(name, isDir)).toBe(kind)
  })
})
