// Pi extension entry — registers `/channel <sub> ...` with the Pi REPL.
//
// Pi loads this module via Jiti from `~/.pi/agent/extensions/` and calls
// the default export with its ExtensionAPI instance.

import {channelSubcommands, dispatchChannelCommand} from './commands.js'
import type {PiAutocompleteItem, PiExtensionAPI} from './pi-api.js'

const channelExtension = (pi: PiExtensionAPI): void => {
  pi.registerCommand('channel', {
    description: 'Drive a brv channel from Pi (new, list, invite, mention, approve, deny, show, doctor).',
    getArgumentCompletions: (prefix: string): PiAutocompleteItem[] | null => {
      // Only suggest subcommands when no whitespace yet — once the user
      // moved on to subcommand arguments, completions stay quiet.
      if (prefix.includes(' ')) return null
      const filtered = channelSubcommands.filter((s) => s.startsWith(prefix))
      if (filtered.length === 0) return null
      return filtered.map((value) => ({label: value, value}))
    },
    handler: async (args, ctx) => {
      await dispatchChannelCommand(args, ctx)
    },
  })
}

export default channelExtension
export {channelExtension}
