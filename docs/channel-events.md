# Channel Event Kinds

Reference for canonical `kind` values emitted on the channel event stream.
Used with `brv channel subscribe --kinds <kind1>,<kind2>` (filter to specific
kinds) or `--all-kinds` (capture everything, for diagnostics).

## Quick-reference: turn flavour → relevant kinds

| Turn flavour | Required kinds to capture |
|---|---|
| Local outbound (operator prompt) | `message`, `turn_state_change` |
| ACP-agent response (codex, kimi, etc.) | `agent_message_chunk`, `delivery_state_change`, `turn_state_change` |
| Remote-peer response (bridge parley) | `agent_message_chunk`, `delivery_state_change`, `turn_state_change` |
| Permission gate | `permission_request`, `permission_decision`, `delivery_state_change` |
| Channel auto-created by bridge | `channel_auto_created` |

**Common mistake:** subscribing with `--kinds message,delivery_state_change`
for an inbound remote-peer flow will capture zero events because the response
body is streamed as `agent_message_chunk`, not `message`. The terminal event
is `turn_state_change` (turn-level), not `delivery_state_change` (member-level).

## Event kind table

| Kind | When emitted | Source | Payload key fields |
|---|---|---|---|
| `message` | Operator prompt posted via `brv channel mention` | Local outbound | `content`, `role: 'user'`, `turnId`, `seq` |
| `agent_message_chunk` | Streaming LLM/agent text delta | Local ACP agent OR inbound remote-peer | `content`, `deliveryId`, `memberHandle`, `seq` |
| `agent_thought_chunk` | Streaming agent internal thought (visible in verbose mode) | Local ACP agent | `content`, `deliveryId`, `memberHandle`, `seq` |
| `tool_call` | Agent begins a tool call | Local ACP agent | `toolName`, `callId`, `deliveryId`, `seq` |
| `tool_call_update` | Tool call result appended | Local ACP agent | `callId`, `output`, `status`, `seq` |
| `agent_meta` | Agent emits structured metadata (model, version, etc.) | Local ACP agent | `meta`, `deliveryId`, `seq` |
| `permission_request` | Agent requests operator approval for a sensitive action | Local ACP agent | `permissionRequestId`, `toolName`, `toolCall`, `deliveryId`, `seq` |
| `permission_decision` | Operator approves or denies a permission request | Operator action | `permissionRequestId`, `decision`, `seq` |
| `plan` | Agent emits a structured task plan | Local ACP agent | `plan`, `deliveryId`, `seq` |
| `artifact` | Agent emits a structured artifact (file, code block, etc.) | Local ACP agent | `artifact`, `deliveryId`, `seq` |
| `delivery_state_change` | A single member's delivery moves to a new state | Local ACP agent, remote-peer response | `deliveryId`, `memberHandle`, `state`, `seq` |
| `turn_state_change` | The overall turn transitions to a new state | Any terminal delivery | `state` (`completed`/`cancelled`/`errored`), `seq` |
| `channel_auto_created` | Bob's daemon auto-created a mirror channel for an inbound parley | Bridge inbound (§9.5.4) | `channelId`, `autoProvisionedFrom`, `autoProvisionedAt`, `multiaddr`, `addressability`, `seq` |

## Delivery states (for `delivery_state_change`)

`queued` → `dispatched` → `streaming` → `completed` | `cancelled` | `errored`

A delivery in `awaiting_permission` means the agent is paused waiting for an
operator decision; use `brv channel approve/deny` to resume it.

## Subscribing for common use-cases

**Wait for any turn to finish:**
```bash
brv channel subscribe <channel> --exit-on-terminal
```

**Wait for a specific agent to finish:**
```bash
brv channel subscribe <channel> --roles @codex --kinds delivery_state_change --count 1
```

**Capture everything for diagnostics:**
```bash
brv channel subscribe <channel> --all-kinds --json
```

**React to auto-created channels (bridge operators):**
```bash
brv channel subscribe <channel> --kinds channel_auto_created
```
