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
  const nav = (globalThis as {navigator?: Navigator}).navigator
  if (nav?.clipboard?.writeText) {
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
  // eslint-disable-next-line no-undef
  const doc = (globalThis as {document?: Document}).document
  if (!doc?.body) return false

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
