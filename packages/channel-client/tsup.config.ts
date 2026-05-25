import {defineConfig} from 'tsup'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  external: ['socket.io-client'],
  format: ['esm'],
  minify: false,
  sourcemap: true,
  splitting: false,
  target: 'es2022',
})
