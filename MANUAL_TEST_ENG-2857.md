# Manual Test Plan — ENG-2857

PR: https://github.com/campfirein/byterover-cli/pull/704
Scope: `brv webui` port handling
- Auto-fallback to the next free port when the default (7700) is taken
- Specific, actionable error messages for port conflicts
- Strict behavior for explicit choices (`--port`, `BRV_WEBUI_PORT`, persisted preference)

---

## Pre-test setup

```sh
# 1) Build so dist/ matches the PR head
npm run build

# 2) Clean state — stop daemon + clear persisted port preference
./bin/dev.js restart
rm -f "$HOME/Library/Application Support/brv/webui-config.json"
```

> **Tip:** All hogs in this plan bind `127.0.0.1` (IPv4) explicitly. A bare `listen(7700)` in Node binds IPv6 by default, which does **not** conflict with our daemon's IPv4 socket and gives a misleading "happy path" result.

---

## Test 1 — Happy path on default port

```sh
./bin/run.js webui
```

**Expect:**
```
ByteRover Web UI: http://localhost:7700
```
Browser opens.

---

## Test 2 — Auto-fallback on the default port

In a separate terminal, hold port 7700 (IPv4):

```sh
node -e "require('node:http').createServer((_,r)=>r.end()).listen(7700,'127.0.0.1',()=>console.log('hog'))"
```

Back in the brv terminal:

```sh
./bin/dev.js restart      # respawn daemon while 7700 is held
./bin/run.js webui
```

**Expect:**
```
Port 7700 was in use — using port 7701 instead.
ByteRover Web UI: http://localhost:7701
```

The browser should open and successfully reach the Web UI on 7701.

---

## Test 3 — Explicit `--port` is strict (no fallback)

With 7700 still held from Test 2:

```sh
./bin/run.js webui --port 7700
```

**Expect:**
```
Error: Web UI port 7700 is already in use. Run `brv webui --port <port>` to choose a different port.
```

Verify there is **no** silent fallback. The user explicitly typed 7700; we honor their choice strictly.

---

## Test 4 — Explicit env var is strict

```sh
./bin/dev.js restart
BRV_WEBUI_PORT=7700 ./bin/run.js webui
```

**Expect:** Same `Error: Web UI port 7700 is already in use...` message. Env var is treated as explicit intent — no auto-fallback.

---

## Test 5 — Persisted preference is strict

Free 9090 and clear hogs first, then set up the scenario:

```sh
# In the hog terminal: Ctrl-C the 7700 hog
npx kill-port 7700

# Persist 9090 as the preferred port via setPort
./bin/dev.js restart
./bin/run.js webui --port 9090
# (expect happy path on 9090)
```

Now hog 9090 and restart so the daemon hits the persisted preference at boot:

```sh
# In the hog terminal:
node -e "require('node:http').createServer((_,r)=>r.end()).listen(9090,'127.0.0.1',()=>console.log('hog'))"

# In the brv terminal:
./bin/dev.js restart
./bin/run.js webui
```

**Expect:**
```
Error: Web UI port 9090 is already in use. Run `brv webui --port <port>` to choose a different port.
```

The daemon honored the persisted preference strictly instead of silently shifting to 9091.

---

## Test 6 — Connection-failure path still routes through the generic handler

```sh
./bin/dev.js restart                           # kill daemon
BRV_IAM_BASE_URL='' ./bin/run.js webui         # makes daemon spawn fail
```

**Expect:** A daemon-connection error, e.g.
```
Error: Connection error: Failed to start daemon: timed out waiting for daemon to become ready
       Run 'brv restart' if the daemon is unresponsive.
```

This must **not** be any of the new port-conflict messages — confirms the new error branches don't accidentally swallow connection-layer errors.

---

## Cleanup

```sh
# Free any port hogs
npx kill-port 7700 9090 9091 2>/dev/null

# Reset state
./bin/dev.js restart
rm -f "$HOME/Library/Application Support/brv/webui-config.json"
```

---

## Pass criteria

- [ ] Test 1: URL is `http://127.0.0.1:7700`, browser opens.
- [ ] Test 2: Fallback notice prints; URL shifts to 7701; browser opens on 7701.
- [ ] Test 3: `--port 7700` fails strictly, no fallback attempted.
- [ ] Test 4: `BRV_WEBUI_PORT=7700` fails strictly, no fallback attempted.
- [ ] Test 5: Persisted preference 9090 fails strictly when 9090 is held, no shift to 9091.
- [ ] Test 6: Daemon-spawn failure produces a "Connection error: ..." message, not a port message.
