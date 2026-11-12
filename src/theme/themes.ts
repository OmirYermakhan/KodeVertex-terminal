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
  /** Значки вложений (макет 06 .tk): файл, блок (ok/fail), сообщение, неподдерживаемое, значок в пузыре «Вы». */
  tk: string
  tkRule: string
  tkText: string
  tkIco: string
  tkMut: string
  tkMini: string
  tkOk: string
  tkOkRule: string
  tkOkText: string
  tkFail: string
  tkFailRule: string
  tkFailText: string
  tkMsg: string
  tkMsgRule: string
  tkMsgText: string
  tkMsgIco: string
  tkErr: string
  tkErrRule: string
  tkErrText: string
  tkYou: string
  tkYouRule: string
  tkYouText: string
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
      tk: '#1f2a35',
      tkRule: '#314459',
      tkText: '#e3e9ec',
      tkIco: '#aaccef',
      tkMut: '#84a5c9',
      tkMini: '#405975',
      tkOk: '#161e1a',
      tkOkRule: '#314e38',
      tkOkText: '#e0ebdc',
      tkFail: '#23191b',
      tkFailRule: '#4c2d2f',
      tkFailText: '#f1d7d3',
      tkMsg: '#211e2a',
      tkMsgRule: '#423854',
      tkMsgText: '#ebe3ee',
      tkMsgIco: '#d4b6fa',
      tkErr: '#271b1d',
      tkErrRule: '#593435',
      tkErrText: '#f0bfbc',
      tkYou: '#1b1e23',
      tkYouRule: '#45484c',
      tkYouText: '#fefdf7',
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
      tk: '#313436',
      tkRule: '#454c51',
      tkText: '#e5e3dd',
      tkIco: '#bbc8d2',
      tkMut: '#98a2a8',
      tkMini: '#556068',
      tkOk: '#272923',
      tkOkRule: '#46523f',
      tkOkText: '#e2e4d4',
      tkFail: '#2f2724',
      tkFailRule: '#523d37',
      tkFailText: '#ead7cc',
      tkMsg: '#2f2a2c',
      tkMsgRule: '#4d414b',
      tkMsgText: '#e9dedc',
      tkMsgIco: '#d3b4cf',
      tkErr: '#332926',
      tkErrRule: '#5c443d',
      tkErrText: '#e6c5b9',
      tkYou: '#282522',
      tkYouRule: '#4e4b46',
      tkYouText: '#fbf6ec',
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
      tk: '#2a3547',
      tkRule: '#3d4d69',
      tkText: '#e2ebf7',
      tkIco: '#b3cefc',
      tkMut: '#8aa7d5',
      tkMini: '#4c6185',
      tkOk: '#1f2a2c',
      tkOkRule: '#385649',
      tkOkText: '#ddede8',
      tkFail: '#2c262d',
      tkFailRule: '#543b40',
      tkFailText: '#eedcdf',
      tkMsg: '#282a39',
      tkMsgRule: '#44415d',
      tkMsgText: '#e6e5f5',
      tkMsgIco: '#c7b8f2',
      tkErr: '#30292f',
      tkErrRule: '#604146',
      tkErrText: '#efc6c9',
      tkYou: '#202730',
      tkYouRule: '#464d57',
      tkYouText: '#fbffff',
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
      tk: '#d5dfe6',
      tkRule: '#b6cadc',
      tkText: '#101a24',
      tkIco: '#224b76',
      tkMut: '#4b7199',
      tkMini: '#9db9d5',
      tkOk: '#e5ece1',
      tkOkRule: '#b5d1b7',
      tkOkText: '#112017',
      tkFail: '#f1e3de',
      tkFailRule: '#e7c3bd',
      tkFailText: '#331a19',
      tkMsg: '#eae1f1',
      tkMsgRule: '#d7c1f3',
      tkMsgText: '#201635',
      tkMsgIco: '#6832bc',
      tkErr: '#f0e0da',
      tkErrRule: '#e4b9b2',
      tkErrText: '#592522',
      tkYou: '#eae9e2',
      tkYouRule: '#c0bfb9',
      tkYouText: '#000003',
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
      tk: '#2a3346',
      tkRule: '#3a4865',
      tkText: '#cfdcf6',
      tkIco: '#8fb0ee',
      tkMut: '#8a9bc0',
      tkMini: '#4a5a7d',
      tkOk: '#262c25',
      tkOkRule: '#3d4a3b',
      tkOkText: '#cfe3cd',
      tkFail: '#33252a',
      tkFailRule: '#5a3038',
      tkFailText: '#f0c4c9',
      tkMsg: '#2f2a3b',
      tkMsgRule: '#4a4161',
      tkMsgText: '#ddd3f2',
      tkMsgIco: '#b49cf0',
      tkErr: '#3a2226',
      tkErrRule: '#6b2b33',
      tkErrText: '#f3a6ae',
      tkYou: '#243456',
      tkYouRule: '#4b5d82',
      tkYouText: '#e3eaf9',
    },
  },
}

/**
 * ANSI-палитра из токенов. На светлом фоне «чёрный» должен быть тёмным, а «белый» —
 * светлым, поэтому для светлых тем пары меняются местами.
 */
export function ansiFromTokens(t: ThemeTokens, dark: boolean): ITheme {
  const black = dark ? t.panel : t.strong
  const brightBlack = t.muted
  const white = dark ? t.text : t.panel
  const brightWhite = dark ? t.strong : t.bg
  return {
    background: t.bg,
    foreground: t.text,
    cursor: t.accText,
    selectionBackground: `${t.acc}55`,
    black,
    red: t.del,
    green: t.add,
    yellow: t.warn,
    blue: t.info,
    magenta: t.mag,
    cyan: t.num,
    white,
    brightBlack,
    brightRed: t.del,
    brightGreen: t.add,
    brightYellow: t.warn,
    brightBlue: t.info,
    brightMagenta: t.mag,
    brightCyan: t.num,
    brightWhite,
  }
}
