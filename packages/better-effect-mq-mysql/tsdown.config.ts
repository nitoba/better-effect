import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  exports: true,
  deps: { neverBundle: ['mysql2', 'mysql2/promise', 'better-result'] }
})
