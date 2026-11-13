import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: false,
    // Рабочие копии веток (git worktree) лежат внутри репозитория — их тесты не наши.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
