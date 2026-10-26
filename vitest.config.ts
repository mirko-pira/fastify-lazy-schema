import { defineConfig } from 'vitest/config'

// The tests boot real Fastify instances; coverage measures the plugin's one module.
export default defineConfig({
  test: {
    include: ['src/__tests__/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/lazy-schema.ts'] },
  },
})
