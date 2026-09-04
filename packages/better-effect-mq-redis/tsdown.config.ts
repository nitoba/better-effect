import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  exports: true,
  deps: {
    neverBundle: ['better-effect', 'better-effect-mq', 'better-result', 'redis']
  }
})
