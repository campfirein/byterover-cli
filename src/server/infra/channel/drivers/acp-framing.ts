/**
 * NDJSON framing for ACP over stdio (CHANNEL_PROTOCOL.md §6, DESIGN.md §5).
 *
 * One JSON message per line, terminated by `\n`. JSON.stringify escapes
 * embedded newlines so each physical line is exactly one logical message.
 * No Content-Length prefix (that's LSP, not ACP).
 *
 * The decoder buffers partial reads, splits on `\n`, and silently skips any
 * line that fails to JSON.parse so a corrupt frame doesn't poison the rest
 * of the stream.
 */

export const encodeAcpFrame = (msg: unknown): string => `${JSON.stringify(msg)}\n`

export class AcpFrameDecoder {
  private buffer = ''

  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const out: unknown[] = []
    let newlineIdx = this.buffer.indexOf('\n')
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx)
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (line.trim() !== '') {
        try {
          out.push(JSON.parse(line))
        } catch {
          // Skip malformed line and continue with the next.
        }
      }

      newlineIdx = this.buffer.indexOf('\n')
    }

    return out
  }
}
