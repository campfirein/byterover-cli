import type {SlashCommand} from '../../../types/commands.js'

import {connectorsCommand} from './connectors.js'
import {curateCommand} from './curate.js'
import {exitCommand} from './exit.js'
import {hubCommand} from './hub.js'
import {locationsCommand} from './locations.js'
import {loginCommand} from './login.js'
import {logoutCommand} from './logout.js'
import {modelCommand} from './model.js'
import {newCommand} from './new.js'
import {providersCommand} from './providers.js'
import {pullCommand} from './pull.js'
import {pushCommand} from './push.js'
import {queryCommand} from './query.js'
import {resetCommand} from './reset.js'
import {settingsCommand} from './settings.js'
import {sourceCommand} from './source.js'
import {spaceCommand} from './space.js'
import {statusCommand} from './status.js'
import {vcCommand} from './vc.js'
import {worktreeCommand} from './worktree.js'

/**
 * Load all REPL slash commands.
 *
 * IMPORTANT: Order matters - commands are displayed in the UI suggestions
 * in the same order as defined here. Keep grouped by priority/category.
 */
export const load: () => SlashCommand[] = () => [
  // Core workflow - most frequently used
  statusCommand,
  locationsCommand,
  curateCommand,
  queryCommand,

  // Connectors management
  connectorsCommand,

  // Hub - Registry
  hubCommand,

  // Sync operations
  pushCommand,
  pullCommand,

  // Provider management
  providersCommand,
  modelCommand,

  // Space management
  spaceCommand,

  // Git semantic (vc commands)
  vcCommand,

  // Workspace management
  worktreeCommand,

  // Knowledge sources
  sourceCommand,

  // Context tree management
  resetCommand,

  // Operational settings
  settingsCommand,

  // Session management
  newCommand,

  // Auth
  loginCommand,
  logoutCommand,

  // Exit
  exitCommand,
]
