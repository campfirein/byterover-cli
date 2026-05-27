/**
 * Ctrl+Q keybind that cancels the most recently started curate / query task.
 *
 * Scoped via Ink's `useInput` `isActive` — the binding only fires while there
 * is a non-terminal task in the tasks store. When no cancellable task exists,
 * Ctrl+Q is a no-op so the keybind never steals input from other surfaces.
 *
 * Why scoped here instead of inside curate-flow / query-flow: those components
 * unmount as soon as the daemon acks task:create (< 100ms), so they cannot
 * own a keybind that needs to be active for the entire task lifetime.
 *
 * RESERVED CHORD WARNING (read before binding Ctrl+Q anywhere else in the TUI):
 * - This keybind is mounted globally via `app-providers.tsx → CancelKeybindInitializer`,
 *   so as soon as ANY non-terminal task exists in the tasks store, Ctrl+Q is
 *   intercepted everywhere — text inputs, REPL prompt, search box, modals, etc.
 * - DO NOT bind Ctrl+Q to any other action while a curate/query/dream task can
 *   be in flight; the global cancel will eat the chord first.
 * - The binding targets `selectCancelTargetTaskId`'s "oldest running task,
 *   falling back to the oldest queued task." With multiple in-flight tasks,
 *   Ctrl+Q cancels the task occupying the agent slot (FIFO) so the queue
 *   drains; it does NOT cancel whichever task is currently focused in the UI.
 * - There is no confirmation step today — the cancel network round-trip starts
 *   the instant the chord lands. If a real-world conflict surfaces (user
 *   accidentally cancelling), the recommended follow-up is to mirror the SIGINT
 *   double-tap pattern in `installSigintCancel` (first Ctrl+Q arms, second
 *   within Ns fires).
 */

import {useInput} from 'ink'

import {cancelTask} from '../api/cancel-task.js'
import {useTasksStore} from '../stores/tasks-store.js'
import {selectCancelTargetTaskId} from './select-cancel-target.js'

export function useCancelRunningTaskKeybind(): void {
  const targetTaskId = useTasksStore((s) => selectCancelTargetTaskId(s.tasks))

  useInput(
    (input, key) => {
      if (!targetTaskId) return
      if (!key.ctrl || input !== 'q') return

      cancelTask({taskId: targetTaskId}).catch(() => {
        // Best-effort: the daemon's task:cancelled (or task:error) broadcast
        // is the source of truth for status. A throw here means the request
        // round-trip failed, but the user's intent is captured by the keypress
        // and any visible terminal event still drives the store.
      })
    },
    {isActive: Boolean(targetTaskId)},
  )
}
