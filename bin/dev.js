#!/usr/bin/env -S node --import tsx --no-warnings

import {execute} from '@oclif/core'
import {config as loadEnv} from 'dotenv'
import {resolve} from 'node:path'

process.env.BRV_ENV = 'development'

// eslint-disable-next-line n/no-unsupported-features/node-builtins
const root = resolve(import.meta.dirname, '..')
loadEnv({path: resolve(root, '.env.development'), quiet: true})


// Inject default command 'main' (represents logic of a single 'brv' run) when no args provided
// process.argv = ['node', 'bin/dev.js', ...userArgs]
const userArgs = process.argv.slice(2)
if (userArgs.length === 0) {
  process.argv.push('main')
}

await execute({development: true, dir: import.meta.url})
