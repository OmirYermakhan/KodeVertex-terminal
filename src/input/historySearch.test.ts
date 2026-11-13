import { describe, expect, it } from 'vitest'
import { ghostSuggestion, nextWord, searchHistory } from './historySearch'

describe('ghostSuggestion', () => {
  const list = ['git status', 'git commit -m x', 'ls -la', 'git checkout main']
  it('берёт самую свежую запись с таким началом', () => {
    expect(ghostSuggestion(list, 'git c')).toBe('heckout main')
    expect(ghostSuggestion(list, 'git s')).toBe('tatus')
  })
  it('нет подсказки на пустой строке, при полном совпадении и без совпадений', () => {
    expect(ghostSuggestion(list, '')).toBeNull()
    expect(ghostSuggestion(list, 'ls -la')).toBeNull()
    expect(ghostSuggestion(list, 'npm')).toBeNull()
  })
  it('многострочные строки и записи не подсказываются', () => {
    expect(ghostSuggestion(['echo a\necho b'], 'echo')).toBeNull()
    expect(ghostSuggestion(list, 'git\n')).toBeNull()
  })
})

describe('nextWord', () => {
  it('слово с пробелами перед ним', () => {
    expect(nextWord('heckout main')).toBe('heckout')
    expect(nextWord(' main')).toBe(' main')
  })
  it('путь — по одному каталогу', () => {
    expect(nextWord('src/input/x.ts')).toBe('src/')
  })
})

describe('searchHistory', () => {
  const list = ['make test', 'git status', 'make build', 'git status', 'npm run dev']
  it('новые первыми, без повторов', () => {
    expect(searchHistory(list, '')).toEqual(['npm run dev', 'git status', 'make build', 'make test'])
  })
  it('нечёткое совпадение', () => {
    expect(searchHistory(list, 'mkb')).toEqual(['make build'])
    expect(searchHistory(list, 'gst')).toEqual(['git status'])
  })
})
