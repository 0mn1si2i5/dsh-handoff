import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.{spec,e2e}.ts'], pool: 'forks' },
})
