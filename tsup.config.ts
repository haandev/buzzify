import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/buzzify.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist'
})
