import {discoverDaemon} from '@campfirein/brv-transport-client'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import {existsSync, readFileSync, realpathSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vite'
import {VitePWA} from 'vite-plugin-pwa'

const currentDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDir, '../..')
const submoduleSharedUiSrc = resolve(repoRoot, 'packages/byterover-packages/ui/src')
const installedSharedUiSrc = resolve(repoRoot, 'node_modules/@campfirein/byterover-packages/ui/src')
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {version?: string}
const cliVersion = packageJson.version ?? 'unknown'

type SharedUiSourceMode = 'auto' | 'package' | 'submodule'

function normalizeSharedUiSourceMode(mode: string | undefined): SharedUiSourceMode {
  switch (mode) {
    case 'lib':
    case 'package': {
      return 'package'
    }

    case 'local':
    case 'submodule': {
      return 'submodule'
    }

    default: {
      return 'auto'
    }
  }
}

function resolveSharedUiSource(mode: SharedUiSourceMode): {
  label: string
  mode: Exclude<SharedUiSourceMode, 'auto'>
  path: string
} {
  const hasSubmoduleSource = existsSync(submoduleSharedUiSrc)
  const hasInstalledSource = existsSync(installedSharedUiSrc)

  if (mode === 'submodule' || (mode === 'auto' && hasSubmoduleSource)) {
    if (!hasSubmoduleSource) {
      throw new Error(
        'Shared UI submodule not found at packages/byterover-packages. Run `git submodule update --init --recursive`.',
      )
    }

    const resolvedPath = realpathSync(submoduleSharedUiSrc)
    return {
      label: `git submodule (${resolvedPath})`,
      mode: 'submodule',
      path: resolvedPath,
    }
  }

  if (!hasInstalledSource) {
    throw new Error(
      'Installed shared UI package source not found in node_modules. Run `npm install` to restore `@campfirein/byterover-packages`.',
    )
  }

  const resolvedPath = realpathSync(installedSharedUiSrc)
  return {
    label: `installed package (${resolvedPath})`,
    mode: 'package',
    path: resolvedPath,
  }
}

export default defineConfig(({command, mode}) => {
  const sharedUiSource = resolveSharedUiSource(normalizeSharedUiSourceMode(process.env.BRV_UI_SOURCE ?? mode))

  if (command === 'serve') {
    try {
      const status = discoverDaemon()
      if (status.running) {
        console.log(`\n  Daemon found on port ${status.port}\n`)
      } else {
        console.log('\n  Daemon is not running. Make daemon alive before continue.\n')
      }
    } catch {
      console.log('\n  Daemon is not running. Make daemon alive before continue.\n')
    }

    console.log(`\n  Shared UI source: ${sharedUiSource.label}\n`)
  }

  return {
    base: '/',
    build: {
      emptyOutDir: true,
      outDir: '../../dist/webui',
    },
    optimizeDeps:
      sharedUiSource.mode === 'submodule'
        ? {
            exclude: ['@campfirein/byterover-packages'],
          }
        : undefined,
    plugins: [
      react(),
      tailwindcss(),
      // eslint-disable-next-line new-cap
      VitePWA({
        manifest: {
          description: 'ByteRover local development environment',
          display: 'standalone',
          name: 'ByteRover',
          // eslint-disable-next-line camelcase
          short_name: 'ByteRover',
          // eslint-disable-next-line camelcase
          start_url: '/',
          // eslint-disable-next-line camelcase
          theme_color: '#0a0a0a',
        },
        registerType: 'autoUpdate',
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          // The main bundle exceeds the default 2 MiB once CodeMirror + mermaid are bundled.
          // PWA only serves the offline fallback, not the full app — so dropping the main chunk
          // from the precache is fine, but the warning is noisy. Raise the cap to keep build clean.
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: '/index.html',
        },
      }),
      {
        configureServer(server) {
          server.middlewares.use('/api/ui/config', (_req, res) => {
            const status = discoverDaemon()

            if (!status.running) {
              res.statusCode = 503
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({error: 'Daemon is not running'}))
              return
            }

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                daemonPort: status.port,
                projectCwd: repoRoot,
                version: cliVersion,
              }),
            )
          })
        },
        name: 'brv-ui-dev-config-endpoint',
      },
    ],
    resolve: {
      alias: {
        '@campfirein/byterover-packages': sharedUiSource.path,
        '@workspace/ui': sharedUiSource.path,
        // Force linked packages (npm link) to use this project's React instance.
        // Without this, npm-linked packages resolve react from their own
        // node_modules, causing "Invalid hook call" due to duplicate React.
        react: resolve(repoRoot, 'node_modules/react'),
        'react-dom': resolve(repoRoot, 'node_modules/react-dom'),
      },
    },
    server: {
      fs: {
        allow: [repoRoot],
      },
      // Proxy review surfaces to the daemon so dev mirrors production: a single
      // origin serves both the localweb (via Vite) and the review page (via
      // the daemon's Express server).
      proxy: {
        '/api/review': {
          changeOrigin: true,
          router: () => daemonOrigin(),
          target: 'http://127.0.0.1',
        },
        '^/review(?:\\?.*)?$': {
          changeOrigin: true,
          router: () => daemonOrigin(),
          target: 'http://127.0.0.1',
        },
      },
    },
  }
})

function daemonOrigin(): string {
  try {
    const status = discoverDaemon()
    if (status.running) return `http://127.0.0.1:${status.port}`
  } catch {
    /* daemon down — proxy will surface a 502 */
  }

  return 'http://127.0.0.1:0'
}
