import type { ITheme } from '@xterm/xterm'

export type ThemeId = 'kv' | 'warm' | 'cold' | 'light' | 'as'

export interface ThemeTokens {
  bg: string
  panel: string
  panel2: string
  rule: string
  text: string
  strong: string
  muted: string
  you: string
  acc: string
  accText: string
  onAcc: string
  info: string
  add: string
  del: string
  warn: string
  mag: string
  sumBg: string
  sumRule: string
  kw: string
  str: string
  fn: string
  num: string
  com: string
}

export interface Theme {
  id: ThemeId
  name: string
  dark: boolean
  tokens: ThemeTokens
}

export const THEMES: Record<ThemeId, Theme> = {
  kv: {
    id: 'kv',
    name: 'KodeVertex',
    dark: true,
    tokens: {
      bg: '#0c0e10',
      panel: '#16191d',
      panel2: '#0f1113',
      rule: '#262a2f',
      text: '#e4e3dd',
      strong: '#f1f0eb',
      muted: '#8a9199',
      you: '#23272d',
      acc: '#c6f24e',
      accText: '#c6f24e',
      onAcc: '#0c0e10',
      info: '#7fb6f2',
      add: '#7fd18b',
      del: '#ef7d7d',
      warn: '#f2c46b',
      mag: '#c9a0ff',
      sumBg: '#1a2010',
      sumRule: '#3a4a1a',
      kw: '#c6f24e',
      str: '#7fd18b',
      fn: '#7fb6f2',
      num: '#f2c46b',
      com: '#636972',
    },
  },
  warm: {
    id: 'warm',
    name: 'Тёплый графит',
    dark: true,
    tokens: {
      bg: '#1c1b19',
      panel: '#252321',
      panel2: '#201f1d',
      rule: '#34312d',
      text: '#dcd7cd',
      strong: '#efeae0',
      muted: '#948d82',
      you: '#2e2b27',
      acc: '#b5cf6a',
      accText: '#c3d985',
      onAcc: '#1c1b19',
      info: '#9bb4c9',
      add: '#9cc58f',
      del: '#d99484',
      warn: '#d7a86e',
      mag: '#c9a0c9',
      sumBg: '#262a1e',
      sumRule: '#3f4630',
      kw: '#d7a86e',
      str: '#9cc58f',
      fn: '#9bb4c9',
      num: '#c9a0c9',
      com: '#7a746a',
    },
  },
  cold: {
    id: 'cold',
    name: 'Сине-серый',
    dark: true,
    tokens: {
      bg: '#161b22',
      panel: '#1d232c',
      panel2: '#191e26',
      rule: '#2b333e',
      text: '#d3dae3',
      strong: '#eef2f6',
      muted: '#8592a3',
      you: '#252d38',
      acc: '#8fb8ff',
      accText: '#a5c6ff',
      onAcc: '#10151b',
      info: '#b9a2f0',
      add: '#7fcf9a',
      del: '#f08c8c',
      warn: '#f2c46b',
      mag: '#b9a2f0',
      sumBg: '#1a2534',
      sumRule: '#2f425c',
      kw: '#ff8f70',
      str: '#a5d6a7',
      fn: '#8fb8ff',
      num: '#79d0e0',
      com: '#66727f',
    },
  },
  light: {
    id: 'light',
    name: 'Светлая бумага',
    dark: false,
    tokens: {
      bg: '#f6f5f0',
      panel: '#ecebe4',
      panel2: '#f0efe9',
      rule: '#dcdad1',
      text: '#2a2d31',
      strong: '#0c0e10',
      muted: '#6d737b',
      you: '#e3e2da',
      acc: '#5f7d12',
      accText: '#4b6608',
      onAcc: '#f6f5f0',
      info: '#2f6fb3',
      add: '#2e8540',
      del: '#c0443b',
      warn: '#b5641a',
      mag: '#8a3ffc',
      sumBg: '#e9efd9',
      sumRule: '#c8d6a3',
      kw: '#8a3ffc',
      str: '#2e8540',
      fn: '#2f6fb3',
      num: '#b5641a',
      com: '#9a9ea4',
    },
  },
  as: {
    id: 'as',
    name: 'Android Studio',
    dark: true,
    tokens: {
      bg: '#1e1f22',
      panel: '#2b2d30',
      panel2: '#26282b',
      rule: '#393b40',
      text: '#bcbec4',
      strong: '#dfe1e5',
      muted: '#6f737a',
      you: '#2e436e',
      acc: '#3574f0',
      accText: '#548af7',
      onAcc: '#ffffff',
      info: '#56a8f5',
      add: '#6aab73',
      del: '#f75464',
      warn: '#e0b05a',
      mag: '#c77dff',
      sumBg: '#25324d',
      sumRule: '#35538f',
      kw: '#cf8e6d',
      str: '#6aab73',
      fn: '#56a8f5',
      num: '#2aacb8',
      com: '#7a7e85',
    },
  },
}

export function ansiFromTokens(t: ThemeTokens): ITheme {
  return {
    background: t.bg,
    foreground: t.text,
    cursor: t.accText,
    selectionBackground: `${t.acc}55`,
    black: t.panel,
    red: t.del,
    green: t.add,
    yellow: t.warn,
    blue: t.info,
    magenta: t.mag,
    cyan: t.num,
    white: t.text,
    brightBlack: t.muted,
    brightRed: t.del,
    brightGreen: t.add,
    brightYellow: t.warn,
    brightBlue: t.info,
    brightMagenta: t.mag,
    brightCyan: t.num,
    brightWhite: t.strong,
  }
}
