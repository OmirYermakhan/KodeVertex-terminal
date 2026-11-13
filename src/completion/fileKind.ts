// Вид файла для значка в подсказках путей: чистая функция по имени и признаку каталога.
export type FileKind =
  | 'dir' | 'code' | 'script' | 'web' | 'data' | 'image' | 'media' | 'archive'
  | 'config' | 'md' | 'doc' | 'lock' | 'binary' | 'file'

const EXT: Record<string, FileKind> = {}
const add = (kind: FileKind, list: string) => list.split(' ').forEach((e) => (EXT[e] = kind))
add('code', 'ts tsx js jsx mjs cjs rs py go rb java kt swift c h cc cpp hpp cs php lua dart ex exs erl hs ml scala r jl vue svelte gradle')
add('script', 'sh zsh bash fish ps1 bat')
add('web', 'html htm css scss less xml svg')
add('data', 'json csv tsv sql db sqlite ndjson')
add('image', 'png jpg jpeg gif webp bmp ico icns tiff avif heic')
add('media', 'mp3 wav flac ogg m4a mp4 mov mkv avi webm')
add('archive', 'zip tar gz tgz bz2 xz 7z rar zst dmg')
add('config', 'yml yaml toml ini cfg conf env plist properties')
add('md', 'md mdx markdown rst')
add('doc', 'txt pdf doc docx rtf log')
add('lock', 'lock')
add('binary', 'exe dll so dylib o a bin class wasm pyc')

const CONFIG_NAMES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.prettierrc', '.eslintrc', '.dockerignore', 'dockerfile', 'makefile'])

export function fileKind(name: string, isDir: boolean): FileKind {
  if (isDir) return 'dir'
  const n = name.toLowerCase()
  if (n.startsWith('.env')) return 'config'
  if (CONFIG_NAMES.has(n)) return 'config'
  if (n.endsWith('-lock.json') || n === 'yarn.lock') return 'lock'
  const dot = n.lastIndexOf('.')
  if (dot <= 0 || dot === n.length - 1) return 'file'
  return EXT[n.slice(dot + 1)] ?? 'file'
}
