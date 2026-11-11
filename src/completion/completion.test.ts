import { describe, expect, it } from 'vitest'
import {
  PATH_COMMANDS,
  applyCompletion,
  completionContext,
  fuzzyScore,
  parseOsc6973,
  rankEntries,
  resolveDir,
  shellEscape,
} from './completion'

const ctxOf = (buffer: string) => {
  const c = completionContext(buffer, [...buffer].length)
  if (!c) throw new Error('нет контекста для ' + buffer)
  return c
}

describe('parseOsc6973', () => {
  it('разбирает курсор и буфер', () => {
    expect(parseOsc6973('5;cd sr')).toEqual({ cursor: 5, buffer: 'cd sr' })
  })
  it('конец строки', () => {
    expect(parseOsc6973('-')).toBe('end')
  })
  it('мусор -> null', () => {
    expect(parseOsc6973('x;y')).toBeNull()
    expect(parseOsc6973('')).toBeNull()
    expect(parseOsc6973('5')).toBeNull()
  })
  it('делит только по первой ;', () => {
    expect(parseOsc6973('3;a;b')).toEqual({ cursor: 3, buffer: 'a;b' })
  })
  it('пустой буфер', () => {
    expect(parseOsc6973('0;')).toEqual({ cursor: 0, buffer: '' })
  })
})

describe('PATH_COMMANDS', () => {
  it('содержит ожидаемые команды', () => {
    expect(PATH_COMMANDS).toEqual([
      'cd', 'ls', 'cat', 'less', 'vim', 'nvim', 'nano', 'code', 'open',
      'cp', 'mv', 'rm', 'mkdir', 'touch', 'tail', 'head', 'bat', 'source',
    ])
  })
})

describe('completionContext', () => {
  it('cd sr', () => {
    expect(completionContext('cd sr', 5)).toMatchObject({
      command: 'cd', token: 'sr', dirPart: '', namePart: 'sr', dirsOnly: true,
      includeHidden: false, tokenStart: 3,
    })
  })
  it('тильда', () => {
    expect(completionContext('cd ~/pro', 8)).toMatchObject({ dirPart: '~/', namePart: 'pro' })
  })
  it('вложенный путь', () => {
    expect(completionContext('cd src/comp', 11)).toMatchObject({ dirPart: 'src/', namePart: 'comp' })
  })
  it('экранированный пробел', () => {
    expect(completionContext('cd my\\ fo', 9)).toMatchObject({ namePart: 'my fo', token: 'my\\ fo' })
  })
  it('незакрытая кавычка', () => {
    expect(completionContext("cd 'my fo", 9)).toMatchObject({ namePart: 'my fo', token: "'my fo" })
    expect(completionContext('ls "my fo', 9)).toMatchObject({ namePart: 'my fo', dirsOnly: false })
  })
  it('не команда путей -> null', () => {
    expect(completionContext('git sr', 6)).toBeNull()
  })
  it('нет пробела после команды -> null', () => {
    expect(completionContext('cd', 2)).toBeNull()
  })
  it('курсор не в конце токена -> null', () => {
    expect(completionContext('cd sr x', 5)).toBeNull()
    expect(completionContext('cd sr', 4)).toBeNull()
  })
  it('флаги не дополняются', () => {
    expect(completionContext('ls -la', 6)).toBeNull()
  })
  it('пустой токен после пробела', () => {
    expect(completionContext('ls ', 3)).toMatchObject({ token: '', namePart: '', dirPart: '' })
  })
  it('второй аргумент', () => {
    expect(completionContext('cp a.txt sr', 11)).toMatchObject({ token: 'sr', command: 'cp', dirsOnly: false })
  })
  it('скрытые файлы', () => {
    expect(completionContext('ls .gi', 6)).toMatchObject({ includeHidden: true })
  })
  it('курсор в code points (эмодзи)', () => {
    const b = 'cd 😀x'
    expect(completionContext(b, 5)).toMatchObject({ token: '😀x', namePart: '😀x' })
  })
})

describe('resolveDir', () => {
  it('пусто -> cwd', () => expect(resolveDir('', '/a/b', '/h')).toBe('/a/b'))
  it('..', () => expect(resolveDir('../', '/a/b', '/h')).toBe('/a'))
  it('~', () => {
    expect(resolveDir('~/x/', '/c', '/h')).toBe('/h/x')
    expect(resolveDir('~/', '/c', '/h')).toBe('/h')
    expect(resolveDir('~', '/c', '/h')).toBe('/h')
  })
  it('абсолютный', () => expect(resolveDir('/usr/lib/', '/c', '/h')).toBe('/usr/lib'))
  it('относительный', () => expect(resolveDir('src/./x/', '/c', '/h')).toBe('/c/src/x'))
  it('выше корня', () => expect(resolveDir('../../', '/a', '/h')).toBe('/'))
})

describe('fuzzyScore', () => {
  it('подпоследовательность', () => expect(fuzzyScore('cmp', 'components')).not.toBeNull())
  it('не подходит', () => expect(fuzzyScore('xyz', 'components')).toBeNull())
  it('пустой запрос', () => expect(fuzzyScore('', 'abc')).toBe(0))
  it('без регистра', () => expect(fuzzyScore('SRC', 'src')).not.toBeNull())
  it('префикс > подстрока > подпоследовательность', () => {
    const p = fuzzyScore('comp', 'components')!
    const s = fuzzyScore('comp', 'mycomp')!
    const q = fuzzyScore('cmp', 'components')!
    expect(p).toBeGreaterThan(s)
    expect(s).toBeGreaterThan(q)
  })
})

describe('rankEntries', () => {
  const e = (name: string, isDir = false) => ({ name, isDir })
  it('сортирует по счёту', () => {
    const r = rankEntries('comp', [e('mycomp'), e('components'), e('cxoxmxp')])
    expect(r.map((x) => x.name)).toEqual(['components', 'mycomp', 'cxoxmxp'])
  })
  it('при равенстве каталоги выше, затем имя', () => {
    const r = rankEntries('', [e('b'), e('a'), e('z', true), e('c', true)])
    expect(r.map((x) => x.name)).toEqual(['c', 'z', 'a', 'b'])
  })
  it('отбрасывает не подходящие и учитывает limit', () => {
    expect(rankEntries('q', [e('a')])).toEqual([])
    const many = Array.from({ length: 80 }, (_, i) => e('f' + String(i).padStart(2, '0')))
    expect(rankEntries('', many)).toHaveLength(50)
    expect(rankEntries('', many, 5)).toHaveLength(5)
  })
})

describe('shellEscape', () => {
  it('экранирует спецсимволы', () => {
    expect(shellEscape("my folder's $x")).toBe("my\\ folder\\'s\\ \\$x")
  })
  it('кириллица как есть', () => expect(shellEscape('Документы')).toBe('Документы'))
  it('безопасные символы как есть', () => {
    expect(shellEscape('a.b_c-d/e+f,g@h%i=j:k')).toBe('a.b_c-d/e+f,g@h%i=j:k')
  })
})

describe('applyCompletion', () => {
  it('кириллица и каталог', () => {
    expect(applyCompletion(ctxOf('cd Док'), { name: 'Документы', isDir: true }))
      .toBe('\x7f'.repeat(3) + 'Документы/')
  })
  it('тильда сохраняется', () => {
    expect(applyCompletion(ctxOf('cd ~/pro'), { name: 'projects', isDir: true }))
      .toBe('\x7f'.repeat(5) + '~/projects/')
  })
  it('файл без слэша, пробел экранируется', () => {
    expect(applyCompletion(ctxOf('cat my'), { name: 'my file.txt', isDir: false }))
      .toBe('\x7f'.repeat(2) + 'my\\ file.txt')
  })
  it('dirPart сохраняется', () => {
    expect(applyCompletion(ctxOf('cd src/co'), { name: 'components', isDir: true }))
      .toBe('\x7f'.repeat(6) + 'src/components/')
  })
  it('стирает сырой токен с эмодзи по code points', () => {
    expect(applyCompletion(ctxOf('cd 😀'), { name: 'ab', isDir: false }))
      .toBe('\x7f' + 'ab')
  })
  it('ведущие - + = получают ./', () => {
    expect(applyCompletion(ctxOf('rm fo'), { name: '-foo', isDir: false })).toBe('\x7f\x7f./-foo')
    expect(applyCompletion(ctxOf('cd 1'), { name: '+1', isDir: true })).toBe('\x7f./+1/')
    expect(applyCompletion(ctxOf('ls fo'), { name: '=foo', isDir: false })).toBe('\x7f\x7f./=foo')
    expect(applyCompletion(ctxOf('rm src/f'), { name: '-f', isDir: false })).toBe('\x7f'.repeat(5) + 'src/-f')
  })
  it('~ в имени без dirPart экранируется', () => {
    expect(applyCompletion(ctxOf('ls ~'), { name: '~x', isDir: false })).toBe('\x7f' + '\\~x')
  })
  it('~ как домашний каталог не экранируется', () => {
    expect(applyCompletion(ctxOf('ls ~/a'), { name: 'a b', isDir: false })).toBe('\x7f'.repeat(3) + '~/a\\ b')
  })
  it('квотированные токены', () => {
    expect(applyCompletion(ctxOf("cd 'my fo"), { name: 'my folder', isDir: true }))
      .toBe('\x7f'.repeat(6) + 'my\\ folder/')
    expect(applyCompletion(ctxOf('cd "my fo'), { name: "it's", isDir: false }))
      .toBe('\x7f'.repeat(6) + "it\\'s")
  })
})

describe('shellEscape =', () => {
  it('= в начале слова экранируется, внутри нет', () => {
    expect(shellEscape('=a')).toBe('\\=a')
    expect(shellEscape('a=b')).toBe('a=b')
  })
})

describe('rankEntries управляющие символы', () => {
  it('отбрасывает имена с управляющими символами', () => {
    const names = ['a\nb', 'a\rb', 'a\tb', 'a\x03b', 'a\x1bb', 'a\x7fb', 'ab']
    const r = rankEntries('a', names.map((name) => ({ name, isDir: false })))
    expect(r.map((x) => x.name)).toEqual(['ab'])
  })
})

describe('completionContext многокомандные строки и табы', () => {
  it('; | & до курсора -> null', () => {
    expect(completionContext('echo 1; cd sr', 13)).toBeNull()
    expect(completionContext('ls | cat sr', 11)).toBeNull()
    expect(completionContext('make && cd sr', 13)).toBeNull()
  })
  it('экранированный/квотированный ; не мешает', () => {
    expect(completionContext('cd a\\;b', 7)).not.toBeNull()
    expect(completionContext("cd 'a;b", 7)).not.toBeNull()
  })
  it('таб — разделитель', () => {
    expect(completionContext('cd\tsr', 5)).toMatchObject({ command: 'cd', token: 'sr' })
  })
})
