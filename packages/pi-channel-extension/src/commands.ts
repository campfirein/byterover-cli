import {ChannelClient, ChannelClientError} from '@brv/channel-client'

import {parseArgs} from './args.js'
import type {PiCommandContext} from './pi-api.js'
import {renderTurn} from './render.js'

// Type-safe alias for the `connect` factory so tests can inject a stub.
export type ConnectFn = (options?: {
  readonly cwd?: string
}) => Promise<ChannelClient>

const defaultConnect: ConnectFn = (options) => ChannelClient.connect(options)

const SUBCOMMANDS = [
  'new',
  'list',
  'invite',
  'mention',
  'approve',
  'deny',
  'show',
  'doctor',
] as const

export type ChannelSubcommand = (typeof SUBCOMMANDS)[number]

export const isChannelSubcommand = (value: string | undefined): value is ChannelSubcommand =>
  value !== undefined && (SUBCOMMANDS as readonly string[]).includes(value)

// Dispatch the umbrella `/channel` command. Connect once, route to the
// subcommand impl, close on the way out. Errors surface as `error`-level
// notifications so the Pi REPL doesn't crash on transient daemon issues.
export const dispatchChannelCommand = async (
  rawArgs: string,
  ctx: PiCommandContext,
  connect: ConnectFn = defaultConnect,
): Promise<void> => {
  const args = parseArgs(rawArgs)
  if (args.subcommand === undefined) {
    ctx.ui.notify(
      'Usage: /channel <new|list|invite|mention|approve|deny|show|doctor> ...',
      'warning',
    )
    return
  }

  if (!isChannelSubcommand(args.subcommand)) {
    ctx.ui.notify(`Unknown subcommand: ${args.subcommand}`, 'warning')
    return
  }

  let client: ChannelClient
  try {
    client = await connect({cwd: ctx.cwd})
  } catch (error) {
    notifyError(ctx, error)
    return
  }

  try {
    await runSubcommand(args.subcommand, args, ctx, client)
  } catch (error) {
    notifyError(ctx, error)
  } finally {
    await client.close()
  }
}

const runSubcommand = async (
  sub: ChannelSubcommand,
  args: ReturnType<typeof parseArgs>,
  ctx: PiCommandContext,
  client: ChannelClient,
): Promise<void> => {
  switch (sub) {
    case 'approve':
    case 'deny': {
      const [channelId, turnId, permissionId] = args.positional
      if (channelId === undefined || turnId === undefined || permissionId === undefined) {
        ctx.ui.notify(`Usage: /channel ${sub} <channelId> <turnId> <permissionId>`, 'warning')
        return
      }

      await client.request('channel:permission-decision', {
        channelId,
        decision: sub === 'approve' ? 'allow_once' : 'reject_once',
        permissionId,
        turnId,
      })
      ctx.ui.notify(`✓ ${sub === 'approve' ? 'approved' : 'denied'} ${permissionId}`)
      return
    }

    case 'doctor': {
      const result = await client.request<unknown, {profiles?: Array<{name: string; ok: boolean; reason?: string}>}>(
        'channel:doctor',
        args.flags.profile === undefined ? {} : {profile: args.flags.profile},
      )
      const profiles = result.profiles ?? []
      if (profiles.length === 0) {
        ctx.ui.notify('(no profiles configured)')
        return
      }

      for (const p of profiles) {
        ctx.ui.notify(`${p.ok ? '✓' : '✗'} ${p.name}${p.reason === undefined ? '' : ` — ${p.reason}`}`)
      }

      return
    }

    case 'invite': {
      const [channelId, handle] = args.positional
      const profile = args.flags.profile
      if (channelId === undefined || handle === undefined || profile === undefined) {
        ctx.ui.notify(
          'Usage: /channel invite <channelId> @<handle> --profile <name>',
          'warning',
        )
        return
      }

      await client.request('channel:invite', {
        channelId,
        memberHandle: handle.startsWith('@') ? handle : `@${handle}`,
        profile,
      })
      ctx.ui.notify(`✓ ${handle} joined #${channelId}`)
      return
    }

    case 'list': {
      const result = await client.request<unknown, {channels: Array<{channelId: string; state?: string; title?: string}>}>(
        'channel:list',
        {},
      )
      if (result.channels.length === 0) {
        ctx.ui.notify('(no channels — create one with `/channel new <id>`)')
        return
      }

      for (const ch of result.channels) {
        const state = ch.state ?? 'unknown'
        const title = ch.title ?? ''
        ctx.ui.notify(`${ch.channelId}  [${state}]  ${title}`.trim())
      }

      return
    }

    case 'mention': {
      const [channelId, ...rest] = args.positional
      const prompt = rest.join(' ')
      if (channelId === undefined || prompt === '') {
        ctx.ui.notify('Usage: /channel mention <channelId> "<prompt>"', 'warning')
        return
      }

      const accepted = await client.request<unknown, {turn: {turnId: string}}>(
        'channel:mention',
        {channelId, prompt, projectRoot: ctx.cwd},
      )
      const turnId = accepted.turn.turnId
      ctx.ui.notify(`turn ${turnId} started — streaming…`)
      await renderTurn({channelId, client, ctx, turnId})
      return
    }

    case 'new': {
      const [channelId] = args.positional
      if (channelId === undefined) {
        ctx.ui.notify('Usage: /channel new <channelId>', 'warning')
        return
      }

      await client.request('channel:create', {channelId})
      ctx.ui.notify(`✓ Channel #${channelId} created`)
      return
    }

    case 'show': {
      const [channelId, turnId] = args.positional
      if (channelId === undefined || turnId === undefined) {
        ctx.ui.notify('Usage: /channel show <channelId> <turnId>', 'warning')
        return
      }

      const turn = await client.request<unknown, {events?: Array<Record<string, unknown>>}>(
        'channel:get-turn',
        {channelId, turnId},
      )
      const events = turn.events ?? []
      if (events.length === 0) {
        ctx.ui.notify('(turn has no recorded events)')
        return
      }

      for (const ev of events) {
        ctx.ui.notify(`seq=${ev.seq ?? '?'} kind=${ev.kind ?? '?'} ${formatExtras(ev)}`)
      }

      return
    }
  }
}

const formatExtras = (event: Record<string, unknown>): string => {
  const extras: string[] = []
  if (typeof event.memberHandle === 'string') extras.push(`from=${event.memberHandle}`)
  if (typeof event.to === 'string') extras.push(`to=${event.to}`)
  if (typeof event.content === 'string' && event.content.length > 0) {
    const trimmed = event.content.length > 60 ? `${event.content.slice(0, 60)}…` : event.content
    extras.push(`content=${JSON.stringify(trimmed)}`)
  }

  return extras.join(' ')
}

const notifyError = (ctx: PiCommandContext, error: unknown): void => {
  if (error instanceof ChannelClientError) {
    ctx.ui.notify(`[${error.code}] ${error.message}`, 'error')
    return
  }

  ctx.ui.notify(`channel command failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
}

export const channelSubcommands = SUBCOMMANDS
