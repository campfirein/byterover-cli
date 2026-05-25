// Minimal subset of Pi's ExtensionAPI surface that this extension uses.
// Re-declared here so the package builds without depending on Pi itself
// (Pi imports the extension at runtime via Jiti from
// ~/.pi/agent/extensions/). Keep in sync with
// `pi/packages/coding-agent/src/core/extensions/types.ts`.

export type PiUiNotifyLevel = 'info' | 'warning' | 'error'

export interface PiUiContext {
  notify: (message: string, level?: PiUiNotifyLevel) => void
}

export interface PiCommandContext {
  readonly cwd: string
  readonly ui: PiUiContext
}

export interface PiAutocompleteItem {
  readonly value: string
  readonly label: string
}

export interface PiRegisterCommandOptions {
  readonly description?: string
  readonly getArgumentCompletions?: (
    argumentPrefix: string,
  ) => PiAutocompleteItem[] | Promise<PiAutocompleteItem[] | null> | null
  readonly handler: (args: string, ctx: PiCommandContext) => Promise<void>
}

export interface PiExtensionAPI {
  registerCommand: (name: string, options: PiRegisterCommandOptions) => void
}

export type PiExtensionFactory = (pi: PiExtensionAPI) => void | Promise<void>
