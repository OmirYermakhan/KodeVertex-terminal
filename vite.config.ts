import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * @fontsource даёт в src каждого @font-face woff2 и запасной woff. WKWebView всегда берёт woff2,
 * так что woff в сборке — мёртвый груз (~1.4 МБ, 94 файла). Убираем ссылку на него из CSS —
 * файл не попадает в dist. Начертания, подмножества и unicode-range остаются как были.
 */
function dropWoffFallback(): Plugin {
  return {
    name: 'drop-woff-fallback',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/].*\.css$/.test(id)) return null
      return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, ''), map: null }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [dropWoffFallback(), react()],
})
