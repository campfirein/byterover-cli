/**
 * Copy text to the clipboard, with a fallback for non-secure contexts.
 *
 * `navigator.clipboard.writeText` is gated on a secure context in most
 * browsers (Firefox most strictly). When the daemon binds on 0.0.0.0 and a
 * LAN peer opens the WebUI at `http://<host-ip>:7700`, the browser treats it
 * as insecure and the modern Clipboard API throws or is undefined. The
 * legacy `document.execCommand('copy')` path still works in those cases.
 *
 * Returns `true` on success, `false` if every path failed.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // Plain `!== undefined` is the canonical guard; DOM lib types `navigator`
  // / `document` as mandatory but tests stub them via
  // `Object.defineProperty(globalThis, 'navigator', {value: undefined})`.
  // `as` casts and `typeof X !== 'undefined'` are both forbidden (CLAUDE.md
  // and `unicorn/no-typeof-undefined`).
  const nav = globalThis.navigator
  if (nav !== undefined && typeof nav.clipboard?.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path below.
    }
  }

  return execCommandFallback(text)
}

function execCommandFallback(text: string): boolean {
  const doc = globalThis.document
  if (doc === undefined || !doc.body) return false

  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  doc.body.append(textarea)

  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return doc.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
