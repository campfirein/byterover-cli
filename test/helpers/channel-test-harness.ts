import {spawn} from 'node:child_process'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * ChannelTestHarness — subprocess-based daemon boot + oclif runner.
 *
 * Each harness instance owns:
 *   - a temp `BRV_DATA_DIR` (so the daemon spawns with isolated state and
 *     each test gets its own daemon-auth-token + InstanceInfo)
 *   - the `projectDir` passed in by the test (used as `cwd` for every oclif
 *     subprocess so channel commands resolve `projectRoot` correctly)
 *
 * `run()` spawns `./bin/dev.js <args>` as a subprocess. The first call
 * triggers the published `ensureDaemonRunning` in channel-client.ts, which
 * forks the daemon. Subsequent calls reuse it. `shutdown()` reads the
 * daemon's pid from `<BRV_DATA_DIR>/instances/*.json` and sends SIGTERM
 * (with a hard SIGKILL fallback) so the next test isn't blocked on a stale
 * port lock.
 *
 * Tradeoffs vs. an in-process harness: slower (~3-5s per `run()` for ts-node
 * startup), but it exercises the full ts-node → oclif → channel-client →
 * socket.io → daemon → handler → orchestrator stack end-to-end. That's the
 * critical path Phase 1 needs to prove, so the cost is the right one.
 */

export type ChannelTestHarnessBootOptions = {
  readonly projectDir: string
}

export type ChannelTestHarnessRunOptions = {
  readonly env?: Readonly<Record<string, string>>
}

export type ChannelTestHarnessRunResult = {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
// test/helpers/ → up two levels to byterover-cli/
const REPO_ROOT = resolve(HARNESS_DIR, '..', '..')
const BIN_DEV = join(REPO_ROOT, 'bin', 'dev.js')

const splitArgs = (input: string): string[] => {
  // Lightweight shell-style splitter: handles single + double quotes, no
  // escapes. The integration tests only use plain words and quoted strings,
  // so this is sufficient. Full shell parsing is YAGNI for Phase 1.
  const out: string[] = []
  let buf = ''
  let quote: "'" | '"' | undefined
  for (const ch of input) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
      } else {
        buf += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (buf !== '') {
        out.push(buf)
        buf = ''
      }
    } else {
      buf += ch
    }
  }

  if (buf !== '') out.push(buf)
  return out
}

const killByPid = async (pid: number): Promise<void> => {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
    return
  }

  // Wait briefly for graceful exit before SIGKILL. The await-in-loop is
  // intentional: each iteration probes the process and sleeps before the
  // next probe, which is the standard "wait for X" pattern.
  for (let i = 0; i < 30; i += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 100)
    })
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

export class ChannelTestHarness {
  public readonly dataDir: string

  private constructor(
    public readonly projectDir: string,
    dataDir: string,
  ) {
    this.dataDir = dataDir
  }

  static async boot(options: ChannelTestHarnessBootOptions): Promise<ChannelTestHarness> {
    const dataDir = await fs.mkdtemp(join(tmpdir(), 'brv-channel-harness-'))
    return new ChannelTestHarness(options.projectDir, dataDir)
  }

  /**
   * Poll `brv channel show <channel> <turnId> --json` until an event matching
   * `predicate` is observed in `events[]`. Returns the matched event.
   */
  async pollForEvent<T = Record<string, unknown>>(
    channelId: string,
    turnId: string,
    predicate: (event: Record<string, unknown>) => boolean,
    options?: {timeoutMs?: number},
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? 60_000
    const deadline = Date.now() + timeoutMs
     
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.run(`channel show ${channelId} ${turnId} --json`)
      if (res.exitCode === 0) {
        try {
          const parsed = parseJson<{events: Array<Record<string, unknown>>}>(res.stdout)
          const match = parsed.events.find((e) => predicate(e))
          if (match !== undefined) return match as T
        } catch {
          // Ignore parse blips; keep polling.
        }
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, 200)
      })
    }

    throw new Error(
      `pollForEvent: predicate did not match within ${timeoutMs}ms for turn ${turnId} in channel ${channelId}`,
    )
  }

  /**
   * Poll `brv channel list-turns --json` until the named turn reaches a
   * terminal state (`completed` or `cancelled` — per CHANNEL_PROTOCOL.md §4.5,
   * these are the only terminal `TurnState` values; delivery-level errors
   * surface as `delivery_state_change → errored` while the turn finalises as
   * `completed`).
   *
   * Times out after `timeoutMs` (default 60_000) and rejects with a clear
   * error including the last observed state.
   */
  async pollForTerminal(
    channelId: string,
    turnId: string,
    options?: {timeoutMs?: number},
  ): Promise<{state: 'cancelled' | 'completed'; turn: Record<string, unknown>}> {
    const timeoutMs = options?.timeoutMs ?? 60_000
    const deadline = Date.now() + timeoutMs
    let lastState: string | undefined
     
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.run(`channel list-turns ${channelId} --json`)
      if (res.exitCode === 0) {
        try {
          const parsed = parseJson<{turns: Array<{state?: string; turnId?: string}>}>(res.stdout)
          const turn = parsed.turns.find((t) => t.turnId === turnId)
          if (turn !== undefined) {
            lastState = turn.state
            if (turn.state === 'completed' || turn.state === 'cancelled') {
              return {state: turn.state, turn: turn as Record<string, unknown>}
            }
          }
        } catch {
          // Ignore parse blips; keep polling.
        }
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, 200)
      })
    }

    throw new Error(
      `pollForTerminal: turn ${turnId} in channel ${channelId} did not reach terminal within ${timeoutMs}ms (last state: ${lastState ?? 'unknown'})`,
    )
  }

  /**
   * Phase-3 restart-recovery support. Kills the current daemon (PID from
   * `daemon.json`) and awaits its exit so the next `run()` spawns a fresh
   * daemon — without wiping the data dir, so `events.jsonl`,
   * `pending-permissions.jsonl`, etc. all survive into the new daemon.
   *
   * Use this in tests that exercise broker persistence or seq recovery.
   */
  async restart(): Promise<void> {
    try {
      const raw = await fs.readFile(join(this.dataDir, 'daemon.json'), 'utf8')
      const parsed = JSON.parse(raw) as {pid?: unknown}
      if (typeof parsed.pid === 'number') {
        await killByPid(parsed.pid)
      }
    } catch {
      // No daemon.json — nothing to kill; the next run() spawns fresh.
    }
  }

  async run(args: string, options?: ChannelTestHarnessRunOptions): Promise<ChannelTestHarnessRunResult> {
    const argv = splitArgs(args)

    const env = {
      ...process.env,
      BRV_DATA_DIR: this.dataDir,
      BRV_ENV: 'development',
      ...options?.env,
    }

    return new Promise((resolveResult) => {
      const child = spawn('node', [BIN_DEV, ...argv], {
        cwd: this.projectDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      child.on('close', (code) => {
        resolveResult({exitCode: code ?? 0, stderr, stdout})
      })

      child.on('error', (err) => {
        resolveResult({
          exitCode: 127,
          stderr: stderr + (err instanceof Error ? err.message : String(err)),
          stdout,
        })
      })
    })
  }

  /**
   * Phase-3 fixture-side settings seed. Reads the channel's `meta.json`
   * (under `<projectDir>/.brv/context-tree/channel/<id>/`) and merges the
   * supplied partial settings into `meta.settings`. The Phase-3 plan §1
   * fan-out queueing test uses this to set `maxParallelAgents=1` because
   * the wire has no `channel:update-settings` surface yet.
   */
  async seedSettings(
    channelId: string,
    partial: {defaultLookbackTurns?: number; maxParallelAgents?: number},
  ): Promise<void> {
    const metaPath = join(
      this.projectDir,
      '.brv',
      'context-tree',
      'channel',
      channelId,
      'meta.json',
    )
    const raw = await fs.readFile(metaPath, 'utf8')
    const meta = JSON.parse(raw) as {settings?: Record<string, unknown>; updatedAt: string}
    meta.settings = {...meta.settings, ...partial}
    meta.updatedAt = new Date().toISOString()
    const tmp = `${metaPath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(meta, undefined, 2), 'utf8')
    await fs.rename(tmp, metaPath)
  }

  async shutdown(): Promise<void> {
    // Find the daemon spawned under our isolated BRV_DATA_DIR and kill it so
    // the next test's boot doesn't fight an old daemon for the port. The
    // daemon writes its InstanceInfo to `<dataDir>/daemon.json`.
    try {
      const raw = await fs.readFile(join(this.dataDir, 'daemon.json'), 'utf8')
      const parsed = JSON.parse(raw) as {pid?: unknown}
      if (typeof parsed.pid === 'number') {
        await killByPid(parsed.pid)
      }
    } catch {
      // No daemon.json → nothing to clean up (test failed before daemon spawn).
    }

    // Best-effort: clean up the data dir.
    await fs.rm(this.dataDir, {force: true, recursive: true}).catch(() => {})
  }

  /**
   * Crash-recovery fault injection: deletes the `turn.json` snapshot for the
   * given (channel, turn) so the reader is forced to replay `events.jsonl`.
   * Uses the canonical layout under `<projectDir>/.brv/context-tree/channel/<id>/`.
   */
  async simulateSnapshotLoss(channelId: string, turnId: string): Promise<void> {
    const snapshotPath = join(
      this.projectDir,
      '.brv',
      'context-tree',
      'channel',
      channelId,
      'turns',
      turnId,
      'turn.json',
    )
    await fs.rm(snapshotPath, {force: true})
  }
}

/**
 * Parse JSON from a command's stdout, tolerating a non-JSON preamble such as
 * the `[dotenv@17.x.x] injecting env ...` banner that bin/dev.js prints
 * before any command output. Finds the first `{` or `[` and parses from there.
 */
export const parseJson = <T = unknown>(stdout: string): T => {
  // Find the first line that starts (at column 0) with `{` or `[`. This skips
  // the dotenv banner (`[dotenv@17.x.x] ...`) that bin/dev.js prints, since
  // that line starts with `[d` (not bare `[` / `{`).
  const lines = stdout.split('\n')
  let jsonStart = -1
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('{') || line.startsWith('[')) {
      // Reject the dotenv banner: it always starts with `[dotenv@`.
      if (line.startsWith('[dotenv@')) continue
      jsonStart = index
      break
    }
  }

  const slice = jsonStart === -1 ? stdout : lines.slice(jsonStart).join('\n')
  try {
    return JSON.parse(slice) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse JSON from stdout: ${message}\n---stdout---\n${stdout}\n---end---`)
  }
}
