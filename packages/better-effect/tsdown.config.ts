import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/iti': 'src/adapters/iti.ts',
    node: 'src/node.ts',
    'runtime/explicit': 'src/runtime/explicit.ts',
    'runtime/node': 'src/runtime/node.ts',
    'standard-services': 'src/standard-services/index.ts',
    hono: 'src/hono/index.ts',
    next: 'src/next/index.ts',
    opentelemetry: 'src/opentelemetry/index.ts',
    web: 'src/web/index.ts',
    testing: 'src/testing/index.ts'
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  exports: true
})
