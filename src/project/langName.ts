/** Расширение → название языка для строки состояния (как в Android Studio). */
const NAMES: Record<string, string> = {
  kt: 'Kotlin',
  kts: 'Kotlin',
  java: 'Java',
  gradle: 'Groovy',
  groovy: 'Groovy',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  rs: 'Rust',
  xml: 'XML',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  md: 'Markdown',
  mdx: 'Markdown',
  json: 'JSON',
  jsonc: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  properties: 'Properties',
  py: 'Python',
  swift: 'Swift',
  go: 'Go',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  hpp: 'C++',
  cs: 'C#',
  rb: 'Ruby',
  php: 'PHP',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  dart: 'Dart',
  vue: 'Vue',
  svelte: 'Svelte',
}

export function languageName(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  return NAMES[ext] ?? 'Текст'
}
