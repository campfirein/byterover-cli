import {defineConfig} from 'tsup'

export default defineConfig({
  // The bundle is self-contained — Pi copies `dist/extension.js` to
  // `~/.pi/agent/extensions/`, where it has no node_modules. We inline
  // @brv/channel-client + socket.io-client; the latter transitively
  // pulls in CommonJS modules (xmlhttprequest-ssl), so we inject a real
  // `createRequire` shim — tsup's auto-`require` stub throws in ESM.
  banner: {
    js: [
      "import {createRequire as __brvCreateRequire} from 'node:module';",
      "const require = __brvCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  clean: true,
  dts: true,
  entry: ['src/extension.ts'],
  format: ['esm'],
  minify: false,
  noExternal: ['@brv/channel-client', 'socket.io-client'],
  sourcemap: true,
  splitting: false,
  target: 'es2022',
})
