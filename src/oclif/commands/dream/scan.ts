import type {TaskAck} from '@campfirein/brv-transport-client'

import {Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'

import {ALL_DREAM_KINDS} from '../../../server/infra/dream/tool-mode/dream-session.js'
import {TaskEvents} from '../../../shared/transport/events/index.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'
import {DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, waitForTaskCompletion} from '../../lib/task-client.js'

// Canonical kinds list lives on the daemon side (dream-session.ts:ALL_DREAM_KINDS).
// Importing it here keeps the CLI validator from drifting if a new kind is added.
const VALID_KINDS: readonly string[] = ALL_DREAM_KINDS

export default class DreamScan extends Command {
  public static description =
    'Phase 1 of tool-mode dream — scan the context tree for cleanup candidates (link, merge, prune, synthesize).'
public static examples = [
    '# Scan all four kinds with defaults',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# Limit to link + merge, scoped to one domain',
    '<%= config.bin %> <%= command.id %> --kinds link,merge --scope security/',
    '',
    '# JSON output for scripting',
    '<%= config.bin %> <%= command.id %> --format json',
  ]
public static flags = {
    format: Flags.string({default: 'text', description: 'Output format (text or json)', options: ['text', 'json']}),
    kinds: Flags.string({
      description: 'Comma-separated list of candidate kinds (link,merge,prune,synthesize). Defaults to all.',
    }),
    'max-candidates': Flags.integer({
      description: 'Cap on returned candidates per kind. Default 20.',
      min: 1,
    }),
    scope: Flags.string({description: 'Limit scan to topics under this path prefix.'}),
    timeout: Flags.integer({
      default: DEFAULT_TIMEOUT_SECONDS,
      description: 'Maximum seconds to wait for completion',
      max: MAX_TIMEOUT_SECONDS,
      min: MIN_TIMEOUT_SECONDS,
    }),
  }

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    const {flags: raw} = await this.parse(DreamScan)
    const format = raw.format === 'json' ? 'json' : 'text'

    const kinds = raw.kinds ? raw.kinds.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    if (kinds) {
      const invalid = kinds.filter((k) => !VALID_KINDS.includes(k))
      if (invalid.length > 0) {
        const msg = `Invalid --kinds values: ${invalid.join(', ')}. Allowed: ${VALID_KINDS.join(', ')}`
        if (format === 'json') {
          writeJsonResponse({command: 'dream-scan', data: {error: msg, status: 'error'}, success: false})
        } else {
          this.log(msg)
        }

        return
      }
    }

    const payload: Record<string, unknown> = {}
    if (kinds) payload.kinds = kinds
    if (raw.scope) payload.scope = raw.scope
    if (raw['max-candidates'] !== undefined) payload.maxCandidates = raw['max-candidates']

    try {
      await withDaemonRetry(
        async (client, projectRoot, worktreeRoot) => {
          const taskId = randomUUID()
          const taskPayload = {
            content: JSON.stringify(payload),
            ...(projectRoot ? {projectPath: projectRoot} : {}),
            taskId,
            type: 'dream-scan' as const,
            ...(worktreeRoot ? {worktreeRoot} : {}),
          }

          const completionPromise = waitForTaskCompletion(
            {
              client,
              command: 'dream-scan',
              format,
              onCompleted: ({result}) => {
                if (format === 'json') {
                  this.log(result ?? '{}')
                } else {
                  renderScanText(this, result)
                }
              },
              onError: ({error}) => {
                const msg = error?.message ?? 'dream-scan failed'
                if (format === 'json') {
                  writeJsonResponse({command: 'dream-scan', data: {error: msg, status: 'error'}, success: false})
                } else {
                  this.log(`dream-scan failed: ${msg}`)
                }
              },
              taskId,
            },
            (msg) => this.log(msg),
          )

          await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
          await completionPromise
        },
        this.getDaemonClientOptions(),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'dream-scan failed'
      if (format === 'json') {
        writeJsonResponse({command: 'dream-scan', data: {error: message, status: 'error'}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }
    }
  }
}

function renderScanText(command: Command, raw: string | undefined): void {
  if (!raw) {
    command.log('(no result)')
    return
  }

  let parsed: {
    candidates?: {
      link?: Array<{pair: [string, string]; score: number}>
      merge?: Array<{pair: [string, string]; score: number}>
      prune?: Array<{path: string; reason: string}>
      synthesize?: {domains: Array<{domain: string; topics: unknown[]}>}
    }
    error?: string
    sessionId?: string
    status?: string
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    command.log(raw)
    return
  }

  // Daemon-side failures encode as {status:'error', error:'...'}. Surface
  // them as errors rather than printing an empty candidate summary that
  // looks like a successful zero-candidate scan.
  if (parsed.status === 'error') {
    command.log(`dream-scan failed: ${parsed.error ?? 'unknown error'}`)
    return
  }

  command.log(`Session: ${parsed.sessionId ?? '(none)'}`)
  command.log('')
  const c = parsed.candidates ?? {}
  command.log(`  link candidates:        ${c.link?.length ?? 0}`)
  command.log(`  merge candidates:       ${c.merge?.length ?? 0}`)
  command.log(`  prune candidates:       ${c.prune?.length ?? 0}`)
  const domains = c.synthesize?.domains?.length ?? 0
  command.log(`  synthesize candidates:  ${domains} domain${domains === 1 ? '' : 's'}`)

  for (const pair of c.link ?? []) {
    command.log(`    link  [${pair.score.toFixed(2)}]  ${pair.pair[0]}  ↔  ${pair.pair[1]}`)
  }

  for (const pair of c.merge ?? []) {
    command.log(`    merge [${pair.score.toFixed(2)}]  ${pair.pair[0]}  ⊕  ${pair.pair[1]}`)
  }

  for (const p of c.prune ?? []) {
    command.log(`    prune (${p.reason})  ${p.path}`)
  }

  for (const d of c.synthesize?.domains ?? []) {
    command.log(`    synth (${d.topics.length} topic${d.topics.length === 1 ? '' : 's'})  ${d.domain || '<root>'}`)
  }
}
