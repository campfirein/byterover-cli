/**
 * Phase 9.5.7 §3.3 Layer B — phase-stamped abort error.
 *
 * Each phase of the dial→envelope-write→frame-read→verification pipeline
 * records its own elapsed time, frame counts, and last observed frame state.
 * When an abort fires, this error reports exactly which phase was active and
 * what the last observed activity was — so the next retest log tells us which
 * layer aborted at ~10:46 rather than "The operation was aborted".
 *
 * Operators grep for `PARLEY_TURN_IDLE_TIMEOUT` or `PARLEY_ABORT` in
 * server-*.log to find these entries.
 */

export interface PhaseStampedAbortArgs {
  /** Wall-clock milliseconds elapsed since the phase started. */
  readonly elapsedMs: number
  /** Number of frames received so far (0 for dial phase). */
  readonly frameCount: number
  /** Kind of the last received frame, if any. */
  readonly lastFrameKind?: string
  /** Seq of the last received frame, if any. */
  readonly lastFrameSeq?: number
  /** Whether the local idle/dial timer fired (vs. external signal). */
  readonly localTimeoutFired: boolean
  /** Which pipeline phase was active when the abort fired. */
  readonly phase: 'dial' | 'envelope_write' | 'frame_read' | 'verify'
  /** The underlying abort reason error (signal.reason), if present. */
  readonly underlying?: Error
}

export class PhaseStampedAbort extends Error {
  public readonly elapsedMs: number
  public readonly frameCount: number
  public readonly lastFrameKind: string | undefined
  public readonly lastFrameSeq: number | undefined
  public readonly localTimeoutFired: boolean
  public readonly phase: PhaseStampedAbortArgs['phase']
  public readonly underlying: Error | undefined

  public constructor(args: PhaseStampedAbortArgs) {
    const lastFrame =
      args.lastFrameKind === undefined
        ? 'none'
        : `${args.lastFrameKind}#${args.lastFrameSeq}`
    const underlyingPart = args.underlying === undefined ? '' : ` underlying=${args.underlying.message}`
    super(
      `PARLEY_ABORT phase=${args.phase} elapsed=${args.elapsedMs}ms ` +
      `frameCount=${args.frameCount} lastFrame=${lastFrame} ` +
      `localTimeoutFired=${args.localTimeoutFired}${underlyingPart}`,
    )
    this.name = 'PhaseStampedAbort'
    this.phase = args.phase
    this.elapsedMs = args.elapsedMs
    this.frameCount = args.frameCount
    this.lastFrameKind = args.lastFrameKind
    this.lastFrameSeq = args.lastFrameSeq
    this.localTimeoutFired = args.localTimeoutFired
    this.underlying = args.underlying
  }
}
