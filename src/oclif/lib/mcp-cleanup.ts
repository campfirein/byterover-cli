export type McpCleanupDeps = {
  readonly exit: (code: number) => void
}

/**
 * Race a stop() callback against a hard timeout, then exit(0) regardless.
 *
 * Guarantees: exit is called exactly once; the timeout timer is cleared if
 * stop() resolves first; a synchronous throw from stop() does not propagate.
 */
export async function runMcpCleanup(
  stop: () => Promise<void>,
  timeoutMs: number,
  deps: McpCleanupDeps,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const stopPromise = (async () => stop())().catch(() => {
      // Swallow — exit anyway. Both sync throws and async rejections land here
      // because the IIFE wraps the call in an async boundary.
    })
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    await Promise.race([stopPromise, timeoutPromise])
  } catch {
    // Belt-and-suspenders: nothing inside the try is expected to throw, but if
    // it ever does (e.g., setTimeout polyfill misbehaves), still exit cleanly.
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  deps.exit(0)
}
