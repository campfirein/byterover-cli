import type {ITransportClient} from '@campfirein/brv-transport-client'

import chalk from 'chalk'

import type {StatusBillingDTO} from '../../shared/transport/types/dto.js'

import {
  BillingEvents,
  type BillingResolveResponse,
} from '../../shared/transport/events/billing-events.js'
import {formatBillingLine} from './format-billing-line.js'

const SKIP_SOURCES = new Set<StatusBillingDTO['source']>(['other-provider'])
const LOW_CREDIT_RATIO = 0.1

type BillingTone = 'danger' | 'normal' | 'warn'

function tone(billing: StatusBillingDTO): BillingTone {
  if (billing.source === 'other-provider') return 'normal'
  const {remaining, total} = billing
  if (remaining === undefined || total === undefined || total <= 0) return 'normal'
  if (remaining <= 0) return 'danger'
  if (remaining / total < LOW_CREDIT_RATIO) return 'warn'
  return 'normal'
}

function colorize(line: string, t: BillingTone): string {
  switch (t) {
    case 'danger': {
      return chalk.red(line)
    }

    case 'warn': {
      return chalk.yellow(line)
    }

    default: {
      return chalk.dim(line)
    }
  }
}

export interface PrintBillingLineDeps {
  client: ITransportClient
  format: 'json' | 'text'
  log: (msg: string) => void
}

export async function printBillingLine(deps: PrintBillingLineDeps): Promise<StatusBillingDTO | undefined> {
  try {
    const response = await deps.client.requestWithAck<BillingResolveResponse>(BillingEvents.RESOLVE)
    const {billing} = response
    if (!billing) return undefined

    if (deps.format === 'text' && !SKIP_SOURCES.has(billing.source)) {
      deps.log(colorize(formatBillingLine(billing), tone(billing)))
    }

    return billing
  } catch {
    return undefined
  }
}
