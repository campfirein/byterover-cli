# ByteRover CLI Analytics Disclosure

Analytics sharing is opt-in and off by default. If you turn it on, the ByteRover
CLI sends anonymous product-usage events to ByteRover so we can understand which
features are used and where the tool can improve. This page explains exactly what
is shared, from where, and where it goes — please read it before enabling.

## What is collected

Only anonymous usage signals are shared: the **names** of events (for example,
which command ran) plus a small set of properties attached to every event:

- `device_id` — a random identifier generated on this device
- `cli_version` — the installed CLI version
- `os` — your operating system platform
- `node_version` — the Node.js runtime version
- `environment` — whether the build is development or production

We never collect the **content** of your work: no query text, file contents, code,
memory, or file paths are ever sent. The CLI keeps a local record of activity
regardless of this setting; enabling analytics only controls whether anonymous
events are **shared** with ByteRover.

## Which surfaces are tracked

Events can originate from any ByteRover CLI surface: the interactive TUI, headless
CLI commands, the MCP server, the local web UI, IDE extensions, and the background
agent worker processes.

## Where it goes

Shared events are sent to the ByteRover Analytics Service. From there, Mixpanel
acts as a sub-processor for product analytics. The Mixpanel project credentials
stay server-side and are never exposed by the CLI.

## Cross-device alias

While you are not logged in, activity is associated only with this device's
anonymous `device_id`. If you log in on this device, prior anonymous activity here
is permanently linked to your ByteRover account.

## How to disable

You can stop sharing at any time by running:

```bash
brv settings set analytics.share false
```

You can also toggle the `analytics.share` setting from the Settings page in the TUI.

## Privacy policy

For full details on how ByteRover handles your data, see:

https://byterover.dev/services/privacy
