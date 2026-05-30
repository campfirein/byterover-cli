import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

export default [
  includeIgnoreFile(gitignorePath),
  // The byterover-packages submodule has its own ESLint config and tsconfig
  // (referencing @workspace/* packages) — skip it from the root lint run.
  {ignores: ['packages/**']},
  ...oclif,
  prettier,
  {
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
    },
  },
  // Web UI (browser environment) — allow browser globals and React naming conventions
  {
    files: ['src/webui/**/*.ts', 'src/webui/**/*.tsx'],
    languageOptions: {
      globals: {
        document: 'readonly',
        fetch: 'readonly',
        sessionStorage: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
      // Prevent Web UI from importing server code directly
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/**', '../server/**', '../../server/**', '../../../server/**', '../../../../server/**'],
              message: 'Web UI should not import from server. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/agent/**', '../agent/**', '../../agent/**', '../../../agent/**', '../../../../agent/**'],
              message: 'Web UI should not import from agent. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/oclif/**', '../oclif/**', '../../oclif/**', '../../../oclif/**', '../../../../oclif/**'],
              message: 'Web UI should not import from oclif. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/tui/**', '../tui/**', '../../tui/**', '../../../tui/**', '../../../../tui/**'],
              message: 'Web UI should not import from tui. Use transport events or feature APIs instead.',
            },
          ],
        },
      ],
      'unicorn/filename-case': 'off',
    },
  },
  // Prevent TUI from importing server code directly
  {
    files: ['src/tui/**/*.ts', 'src/tui/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/**', '../server/**', '../../server/**', '../../../server/**', '../../../../server/**'],
              message: 'TUI should not import from server. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/agent/**', '../agent/**', '../../agent/**', '../../../agent/**', '../../../../agent/**'],
              message: 'TUI should not import from agent. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/oclif/**', '../oclif/**', '../../oclif/**', '../../../oclif/**', '../../../../oclif/**'],
              message: 'TUI should not import from oclif. Use transport events or feature APIs instead.',
            },
          ],
        },
      ],
    },
  },
  // Architecture boundary: src/server/core may depend only on abstractions.
  // NOTE: infra is a SIBLING of core under src/server/, so a core→infra relative import
  // (e.g. ../../../infra/foo.js) has NO "server" segment — the sibling-relative ../infra
  // variants below are REQUIRED in addition to the **/server/infra/** form.
  {
    files: ['src/server/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/infra/**', '../infra/**', '../../infra/**', '../../../infra/**', '../../../../infra/**'],
              message:
                'core must not import from server/infra. Depend on an interface in core/interfaces and let infra implement it (dependency inversion).',
            },
            {
              group: ['**/oclif/**', '../oclif/**', '../../oclif/**', '../../../oclif/**', '../../../../oclif/**'],
              message: 'core must not import from oclif. Keep CLI wiring out of the domain/application core.',
            },
            {
              group: ['**/tui/**', '../tui/**', '../../tui/**', '../../../tui/**', '../../../../tui/**'],
              message: 'core must not import from tui. Keep UI out of the domain/application core.',
            },
          ],
        },
      ],
    },
  },
]
