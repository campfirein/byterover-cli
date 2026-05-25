import {defineConfig} from 'tsup'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  external: ['@agentclientprotocol/sdk'],
  format: ['esm'],
  minify: false,
  sourcemap: true,
  splitting: false,
  target: 'es2022',
})
