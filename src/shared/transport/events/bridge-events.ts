import {z} from 'zod'

/**
 * Phase 9 / Slice 9.4b — daemon-level libp2p bridge events.
 *
 * Currently only `bridge:whoami` is wired: the CLI asks the running
 * daemon for its install peer_id, current bridge multiaddrs, and L2
 * tree pubkey, so operators can paste those into a remote install's
 * `brv channel invite --peer ... --multiaddr ... --l2-pub-key ...`
 * command without manually running `brv bridge listen` first.
 *
 * Slice 9.4c will add `bridge:status`, `bridge:reconnect`, etc.
 */

export const BridgeEvents = {
  WHOAMI: 'bridge:whoami',
} as const

export const BridgeWhoamiRequestSchema = z.object({}).strict()
export type BridgeWhoamiRequest = z.infer<typeof BridgeWhoamiRequestSchema>

export const BridgeWhoamiResponseSchema = z
  .object({
    l2PubKey: z.string(),
    multiaddrs: z.array(z.string()),
    peerId: z.string(),
    treeId: z.string(),
  })
  .strict()
export type BridgeWhoamiResponse = z.infer<typeof BridgeWhoamiResponseSchema>
