import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/fira-code/400.css'
import '@fontsource/fira-code/500.css'
import '@fontsource/pt-serif/400.css'
import '@fontsource/pt-serif/700.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './global.css'
import App from './App.tsx'
import { ErrorBoundary } from './diag/ErrorBoundary'
import { installGlobalErrorLog } from './diag/log'

import { finalSave, restoreSession } from './persist/session'

installGlobalErrorLog()

// Вкладки, панели и ленты прошлого запуска — до первого рендера (оболочки стартуют в своих каталогах).
void restoreSession().then(() => {
  window.addEventListener('beforeunload', () => void finalSave())
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary name="окно" variant="window">
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})
