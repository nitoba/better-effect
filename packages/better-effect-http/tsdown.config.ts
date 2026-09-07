import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing.ts', opentelemetry: 'src/opentelemetry.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  exports: true
})
