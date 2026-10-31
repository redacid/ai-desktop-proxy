# Architecture

## Processes

```
┌────────────── Electron app ─────────────────────────────┐
│ Renderer (React, src/renderer)                          │
│   └─ window.api ── preload (contextBridge) ── IPC ──┐   │
│ Main process (src/main)                             ▼   │
│   ClientManager ── ClaudeCodeAdapter ── ~/.claude/settings.json
│                 └─ CodexAdapter ────── ~/.codex/config.toml
│   ProxyManager ─── systemctl --user ── claude-desktop-proxy.service ── mitmdump + cdp_addon.py
│   HeadroomService ─ systemctl --user ── claude-desktop-proxy-headroom.service ── headroom proxy
│   HeadroomBackend ─ HTTP /health, /stats-history, /transformations/feed
│   StatusMonitor, AppTray, AppStore, Autostart           │
└─────────────────────────────────────────────────────────┘
```

All file, process and network work happens in the main process. The renderer only shows state and sends
commands over typed IPC; it has no Node access (`contextIsolation`).

The proxy and headroom run as **systemd user services**, not as children of the app. Quitting or crashing the app
must never leave clients pointing at a dead proxy port, so the services outlive it.

## Request path

1. A client started with `HTTPS_PROXY=http://127.0.0.1:<port>` opens a `CONNECT` to mitmdump.
2. mitmdump decrypts only `api.anthropic.com:443` and `api.openai.com:443` (`--allow-hosts`); everything else is
   tunnelled untouched.
   The client trusts mitmproxy's CA through `NODE_EXTRA_CA_CERTS`; the system trust store is never changed.
3. The addon (`resources/mitmproxy/cdp_addon.py`) rewrites the request target to headroom while headroom's
   `/health` answers (checked every 5 s in a background thread, ignoring proxy variables). Otherwise the request
   goes to the API directly. The `Host` header stays `api.anthropic.com`.
4. Routing happens in the `requestheaders` hook: with `stream_large_bodies=1` the body is streamed to whatever
   server is chosen there. `connection_strategy=lazy` avoids opening an API connection a routed request never
   uses.
5. headroom runs with proxy variables unset (`UnsetEnvironment=` in its unit), so it reaches the API directly and
   cannot loop back through mitmdump.

### Codex

Codex (CLI and desktop app) sends requests from Rust and cannot be made to trust our CA through an environment in
its config, but its built-in `openai` provider takes `openai_base_url` from `config.toml` for both API-key and
ChatGPT logins. The same mitmdump therefore runs a second listener, `--mode reverse:https://api.openai.com@<codex
port>` (default 8878), next to `--mode regular@<proxy port>`, and Codex's base URL is `http://127.0.0.1:<codex
port>/v1`. Codex talks plain HTTP and WebSocket to it, so no certificate is involved.

1. While headroom is healthy, the addon sends every request from the reverse listener to headroom with the path
   unchanged (`/v1/responses`, `/v1/models`, WebSocket upgrades). headroom picks the upstream itself: chatgpt.com
   for a ChatGPT login (a `ChatGPT-Account-Id` header), api.openai.com for an API key.
2. While headroom is down, a request with `ChatGPT-Account-Id` goes to `https://chatgpt.com/backend-api/codex`
   with `/v1` replaced by that prefix, which is where Codex would send it without a base URL; anything else goes
   to the reverse mode's upstream, api.openai.com.
3. `api.openai.com:443` is in `--allow-hosts` so the reverse listener's TLS to it is handled by mitmproxy. On the
   regular listener a `CONNECT` to api.openai.com is therefore decrypted too, but the addon leaves those requests
   alone: only the reverse listener's OpenAI traffic is routed.
4. Codex sends its API key or ChatGPT token to the reverse listener in plain HTTP. Any local user could bind that
   port while our service is not on it, so the adapter declares it as `plaintextPort()`, and `ClientManager` lets
   Codex point there only while `ProxyManager.ownsPort` sees our service's main PID listening on it. `ss` cannot
   see other users' processes, so an unidentified owner counts as not ours. The port checked is the one the config
   points at (the last `AppliedRecord`), not only the one in settings. When it is not ours, the base URL is
   removed in that check, without the failsafe's 5 s wait and whether or not auto-restore is on. The status
   monitor re-checks clients whenever the listeners or their owner change, so this follows within one poll
   (5 s with the window open, 30 s in the tray). Changing a port in Settings suspends all clients before the
   proxy moves and resumes them after.

## Main-process modules

| Module | Responsibility |
|---|---|
| `index.ts` | Wiring, IPC handlers, user actions (`runProxyAction`, `runCompressorAction`, `saveSettings`), dialogs. One service action at a time (`exclusive`) |
| `clients/types.ts` | `ClientAdapter` interface, `AppliedRecord` (what we wrote into a config) |
| `clients/claude-code.ts` | Claude Code adapter: `env` block of `~/.claude/settings.json` |
| `clients/codex.ts` | Codex adapter: top-level `openai_base_url` in `$CODEX_HOME/config.toml` (default `~/.codex`), edited as text and checked with `smol-toml` |
| `clients/manager.ts` | `ClientManager`: watches config dirs, periodic checks, auto-restore, failsafe, enable/disable, suspend/resume |
| `proxy/manager.ts` | `ProxyManager`: find/install mitmdump, render the unit, set up/start/stop/remove, wait until serving |
| `proxy/systemd.ts` | Unit rendering with systemd-safe quoting; `systemctl --user` / `journalctl --user` wrapper |
| `proxy/tools.ts` | Finding `uv` and uv-installed tools, port owner via `ss`, `PortTakenError` |
| `proxy/exec.ts` | Shell-free command runner; streaming runner for installs (whole lines) |
| `compressors/headroom.ts` | `HeadroomBackend`: `/health`, `/stats-history` and `/transformations/feed` parsing (recent requests and their bodies) |
| `compressors/headroom-service.ts` | `HeadroomService`: install/run headroom as a user service, external detection |
| `compressors/headroom-options.ts` | headroom options: defaults, validation, mapping to `headroom proxy` flags and service environment, argument splitting |
| `integrations/tools.ts` | Independent tool detection, durable update-check cadence, reviewable action plans, native plugin/RTK setup and verified RTK downloads |
| `status.ts` | `StatusMonitor` (polling, combined health) and the status-line functions for each card |
| `store.ts` | `AppStore`: `state.json` with settings and per-client `{ enabled, applied }` |
| `settings.ts` | Validation of user settings |
| `autostart.ts` | XDG autostart entry |
| `fsutil.ts` | Atomic JSON and text writes that keep symlinks, permissions and Unicode; one-time backups |
| `proxy-env.ts` | The proxy environment for clients (proxy URL, CA, `NO_PROXY` hosts, Codex base URL); TCP port probe |
| `tray.ts`, `window.ts`, `paths.ts` | Tray menu and icon (health colour; busy animation while a service action runs), window (close hides), resource paths in dev and packaged builds |

`src/shared/ipc.ts` is the single contract between main and renderer: every channel and every type that crosses
it is defined there.

## IPC

| Channel | Direction | Payload |
|---|---|---|
| `status:get`, `status:refresh` | invoke | → `AppStatus` |
| `status:changed` | main → renderer | `AppStatus` after every check |
| `client:set-enabled` | invoke | `(id, enabled)` → `ActionResult` |
| `proxy:action`, `compressor:action` | invoke | `install \| setup \| start \| stop \| restart \| remove` → `ActionResult` |
| `proxy:logs`, `compressor:logs` | invoke | → last 80 journal lines |
| `proxy:install-log` | main → renderer | one line of install output (both services) |
| `settings:get`, `settings:save` | invoke | `UserSettings` → `ActionResult` |
| `compressor:request-detail` | invoke | request id → `RequestDetail` (messages from the client, sent to the provider, response) |
| `tools:get`, `tools:check` | invoke | → `ToolInfo[]` (cached state / forced registry and installation check) |
| `tools:action` | invoke | `(ToolId, ToolAction)` → `ToolActionResult`, after a native confirmation |
| `tools:changed` | main → renderer | `ToolInfo[]` after a check or action |

Recent requests travel with `AppStatus.stats.recent` as metrics only; bodies are fetched on demand through
`compressor:request-detail`, because they can be large and are only kept when headroom runs with `--log-messages`.
The renderer turns messages into readable text in `src/renderer/src/messages.ts` (pure, unit tested).

## Client state machine

### Independent tool lifecycle

`ToolManager` is separate from `ClientManager` and `StatusMonitor`. Optional RTK/Ponytail availability does
not change proxy health and their hooks survive proxy stop/remove. Main-process `exclusive` serializes
approved tool actions with service/settings actions. The renderer cannot supply commands or download URLs;
it supplies only validated tool/action identifiers. A plan is prepared read-only, including RTK's dry-run,
and approved before any mutation. Checks share in-flight work; background checks do not mutate tools.

The manager polls installations once per minute and stable release sources at most once per six hours,
unless explicitly forced. `tool-updates.json` persists release values and attempt timestamps across restarts,
including backoff after failed checks. Registry failure preserves the previous release value; malformed
native CLI output produces an unknown installation state and disables mutations. Native client lists may
also consult the client's configured plugin catalogs. No updater approval is inferred from elapsed time.

RTK release archives are downloaded from a version-specific official URL, bounded in size, SHA-256 checked,
and decompressed with a size limit. Only the regular root `rtk` entry is read; archive paths are never
extracted to the filesystem. A staged binary must report the expected version before atomic replacement.
The user-bin symlink is created exclusively and must remain ours; foreign binaries are never overwritten.
Native `rtk init` owns hook setup; native client plugin commands own Ponytail setup. There is no generic
rewrite of client configs and no automatic hook-trust approval. Headroom ownership is rechecked before
package mutation and before restarting an active service. Stopped services remain stopped after updates.

### Routing state machine

`ClaudeCodeAdapter.inspect` (and `CodexAdapter.inspect` likewise) classifies the config as `applied`, `absent`, `partial`, `conflict`, `missing` or
`error`. Values equal to the last `AppliedRecord` (for example the previous port) count as ours, so a port change
reads as `partial` and is repaired, not reported as a conflict.

`ClientManager.check` runs at start, 500 ms after any change in a watched config directory, on the check interval,
and when the proxy's listening state flips:

1. **Failsafe.** Enabled + `applied`, but the proxy has been down for 5 s → remove our settings, keep the client
   enabled.
2. **Auto-restore.** Enabled + `absent`/`partial`, auto-restore on, proxy serving, not held → apply again.
3. **Hold.** `suspendAll()` (before Stop/Remove) removes settings and holds restores until `resume()`, which runs
   after Start/Setup or when the proxy starts listening again.

## Invariants

These protect the user's configs and running sessions; keep them when changing code.

- Never overwrite a value we did not write. A foreign `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS` is a conflict, and so
  is a foreign `openai_base_url` or a `model_provider` other than `openai` in Codex's config.
- Codex's config is edited as text so comments survive: our key goes on the first line under a marker comment,
  removal deletes exactly that line, and every result is parsed before it is written. A line of ours edited by
  hand is reported, not guessed at.
- Remove only what the `AppliedRecord` says we wrote; `NO_PROXY` is merged and un-merged host by host.
- Never write a config we could not parse; never create a config on remove; never rewrite an unchanged file.
- Writes are atomic, keep symlinks (dotfiles), file mode and Unicode, and leave no temp files.
- Clients first on the way down (remove settings, then stop the proxy); proxy first on the way up.
- Never enable a client while nothing listens on the proxy port or the Codex port (one mitmdump serves both).
- Never point a client at a plain-HTTP port (Codex) unless our service's main process is seen holding it.
- Never start a service on a port another process holds; name the process and ask before stopping it.
- Never touch a headroom the app did not start.
- Install anything only after the user confirms a dialog that names the command.

## State

`~/.config/claude-desktop-proxy/state.json` (Electron `userData`):

```json
{
  "proxyPort": 8877,
  "codexPort": 8878,
  "caFile": "/home/me/.mitmproxy/mitmproxy-ca-cert.pem",
  "headroomUrl": "http://127.0.0.1:6767",
  "headroom": { "mode": "cache", "rpm": null, "logMessages": false, "extraArgs": "", "…": "see HeadroomOptions" },
  "autoRepair": true,
  "checkIntervalSec": 60,
  "clients": {
    "claude-code": {
      "enabled": true,
      "applied": { "proxyUrl": "http://127.0.0.1:8877", "caFile": "…", "noProxyAdded": ["127.0.0.1", "localhost"] }
    },
    "codex": {
      "enabled": true,
      "applied": { "proxyUrl": "http://127.0.0.1:8878/v1", "caFile": "", "noProxyAdded": [] }
    }
  }
}
```

Missing headroom options are filled from defaults on load; a top-level `headroomLogMessages` from older
versions moves into `headroom.logMessages`.

The services' unit files are regenerated from these settings; the app compares them with what it would write and
shows **Apply** when they differ (`unit: outdated`), or when the unit came from `legacy/cdp.sh` (`legacy`).
