/**
 * Invisible component that installs the Ctrl+Q cancel keybind for curate /
 * query tasks. Place inside the TransportProvider tree next to the existing
 * TaskSubscriptionInitializer so it shares the same task-store source of truth.
 */

import {useCancelRunningTaskKeybind} from '../hooks/use-cancel-running-task-keybind.js'

export function CancelKeybindInitializer(): null {
  useCancelRunningTaskKeybind()
  return null
}
