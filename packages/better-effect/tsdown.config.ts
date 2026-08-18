import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/iti': 'src/adapters/iti.ts',
    'runtime/explicit': 'src/runtime/explicit.ts',
    'runtime/node': 'src/runtime/node.ts',
    'standard-services': 'src/standard-services/index.ts',
    testing: 'src/testing/index.ts'
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  exports: true
})
