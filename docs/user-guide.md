# User guide

How to use the app day to day. To install it, see [Install and update](install.md); for screenshots of every
tab, see the [interface tour](interface.md); optional tools are described in [Tools](tools.md).

## Starting the app

Open **AI Desktop Proxy** from the applications menu, or turn on **Start at login** in Settings. Closing the window
hides it to the tray; **Quit** in the tray menu exits the app. The proxy and headroom services keep running after you
quit. Only one copy runs at a time: starting it again brings the existing window forward.

On GNOME the tray icon needs the AppIndicator extension.

## The window

The window has four tabs:

| Tab | What it holds |
|---|---|
| Overview | The request path: a card per client app, the shared Proxy and Compressor, and each client's provider; its dot repeats the overall state |
| Savings | headroom savings and recent requests |
| Tools | Optional tools and their updates, see [Tools](tools.md) |
| Settings | App and headroom settings |

Errors and the Install log stay visible on every tab, and a running tool action keeps going when you switch tabs.

The installed version is shown next to the title, in the footer, at the top of the tray menu and in the tray
tooltip. The dot next to the title and the tray icon colour show the overall state:

| Colour | Meaning |
|---|---|
| green | proxy, headroom and every routed client are fine |
| amber | something needs attention (e.g. headroom down, a client lost its settings) |
| red | the proxy is down |
| grey | not checked yet |

While the app installs, starts or stops a service, the tray icon turns blue and pulses (the chevrons squeeze the
dot) until the action finishes.

The window polls every 5 s while it is visible and every 30 s while it sits in the tray. **Check now** checks
everything right away and shows each step while it runs: the client configs, the proxy, headroom's health and its
statistics. When it finishes it shows what it found, for example "All good" or which part needs attention. The panel
closes by itself after a few seconds.

### Overview: the request path

The Overview tab draws the real request path, one lane per client app. The two clients never talk to each other;
they only share the proxy service and headroom:

- **Claude Code** → mitmproxy on `:8877` (through `HTTPS_PROXY`) → headroom → **Anthropic** (`api.anthropic.com`)
- **Codex** → mitmproxy's second listener on `:8878` (through `openai_base_url`) → headroom → **OpenAI**
  (`api.openai.com`, or `chatgpt.com/backend-api/codex` with a ChatGPT login)

Each lane also shows its two fallbacks, drawn around the shared cards (above them for Claude Code, below for Codex):

| Line | When it is used |
|---|---|
| Solid green, client → mitmproxy → headroom → provider | The client is routed and headroom answers: requests are compressed |
| Amber, mitmproxy → provider, around headroom | headroom does not answer: mitmproxy sends that client's requests straight to its provider, uncompressed, and the client keeps working |
| Grey, client → provider, around everything | The client is not routed, or the proxy is down (the app then removes its proxy settings) |

An animated request, labelled with its client, travels the line that client uses right now; each card it passes
through lights up in that line's colour. The clients take turns. Lines not in use stay as faint dashes, and a legend
under the diagram names them. Each provider card says which path its client's requests take.

The window opens wide enough for the diagram to run left to right where the screen allows; in a narrower window the
same diagram runs top to bottom. With reduced motion turned on in your desktop settings, the request does not move.

### Clients

Each client app card shows, below its routing switch, the token-saving tools that can work in that client:
**green** blocks are active there (connected, or a plugin installed and enabled), **grey** ones are not, and a dashed
outline means the app could not tell yet. Hover a block for its state. Tools you set up outside the app count as
active. Connect or disconnect them on the [Tools](tools.md) tab.

Each supported client has a switch. On writes the proxy settings into the client config; off removes exactly
what the app wrote. The badge shows what the config contains:

| Badge | Meaning |
|---|---|
| routed | our settings are in place |
| direct | none of our settings are present |
| partly set | some are missing, or they point at an old port |
| conflict | the config sets the same variable to someone else's value; the app will not overwrite it |
| not installed | the client's config directory does not exist |
| error | the config cannot be read (for example broken JSON); the app never writes to it |

Switching a client on is refused while the proxy is not listening: the client would fail every request.

Changes reach only **new** client sessions; running sessions keep the environment they started with.

| Client | What the switch writes |
|---|---|
| Claude Code | `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and `NO_PROXY` in the `env` block of `~/.claude/settings.json` |
| Codex | `openai_base_url = "http://127.0.0.1:8878/v1"` as the first line of `~/.codex/config.toml` (or `$CODEX_HOME`), under a comment that says the app added it. Works for API-key and ChatGPT logins, CLI and desktop app |

Codex shows **conflict** when its config already sets `openai_base_url` to something else, or sets
`model_provider` to a provider other than `openai`: such traffic does not go to OpenAI, so the app cannot route it.
A profile (`[profiles.*]`) with its own `openai_base_url` or `model_provider` also bypasses the proxy while it is
selected. If you edit the app's line by hand, turning Codex off asks you to remove it yourself.

Codex sends its API key or ChatGPT token to port 8878 unencrypted (it never leaves the machine). So the app turns
Codex on only while it can see its own proxy service holding that port. If the service stops or another process takes the
port, the app removes the line at its next status check (every 5 s with the window open, 30 s in the tray), and
puts it back once the service holds the port again. A proxy restart therefore takes Codex off for a moment.

### Savings

Lifetime totals (tokens saved, money saved by compression and by cache, requests), the current headroom session,
and tokens saved per day for the last 14 days, from headroom's `/stats-history`.

### Recent requests

Below the totals is a table of the last 20 requests headroom handled (from its `/transformations/feed`), newest
first: time, model, input tokens before and after compression, tokens saved and percent, cache read / cache write /
uncached input tokens, and the transforms headroom applied. headroom does not list requests that failed.

Click a row to expand it. It shows three parts:

- **From the client**: the messages as the client sent them.
- **To the provider**: the messages headroom forwarded. Messages headroom rewrote are outlined and marked
  *changed*. Each message shows its size in characters, so you can see where the savings came from.
- **Response**: the text the provider returned.

Long messages are cut to a preview with **Show all**; **JSON** shows the raw message.

Message bodies exist only when headroom runs with `--log-messages`. For headroom run by this app, turn on
**Keep request bodies** in Settings → headroom (the service restarts). For your own headroom, start it with `--log-messages`
or `HEADROOM_LOG_MESSAGES=1`. Without it the table still shows the metrics. headroom keeps only its most recent
requests in memory, so an older row may say it is no longer available.

## Keeping clients safe

- The app re-checks client configs at start, whenever the config directory changes, and every check interval.
  If our settings disappear and the proxy is up, they are restored (turn off **auto-restore** in Settings to only
  report it).
- If the proxy stops serving for more than about 5 seconds on its own, the app removes the proxy settings from
  routed clients so new sessions go straight to the API, and restores them when the proxy is back.
- **Stop** and **Remove** first remove the client settings, then stop the service. Settings come back after
  **Start**, or when the proxy is started outside the app.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Proxy port | 8877 | 1024–65535. Changing it restarts the proxy and re-points routed clients |
| Codex port | 8878 | 1024–65535, not the proxy port. The proxy's second listener, used as Codex's OpenAI base URL |
| headroom URL | `http://127.0.0.1:6767` | Base URL without a path. Only a local `http://127.0.0.1`/`localhost` URL can be run by the app |
| Check interval | 60 s | 10–3600 s |
| Restore proxy settings | on | Auto-restore described above |
| Start at login | off | Writes `~/.config/autostart/ai-desktop-proxy.desktop`, which starts the app hidden |

### headroom options

The **headroom** section of Settings configures the headroom that this app runs. Each option maps to a
`headroom proxy` flag, and options left at their default add no flag, so headroom's own defaults apply. Saving
a change rewrites the service and restarts it. When headroom runs outside the app, the section says so and its
options do not reach that headroom.

| Option | Default | Flag |
|---|---|---|
| Compress requests | on | off = `--no-optimize`: requests pass through unchanged, tokens are still counted |
| Mode | Cache | `--mode token` compresses harder and may rewrite earlier turns; Cache keeps them stable for the provider's prompt cache |
| Target ratio | auto | `--target-ratio`, 0.05–0.95: share of text tokens to keep |
| Recovery of compressed content | Retrievable | `--lossless` (no markers or retrieval tool) or `--no-ccr` (lossy, most savings) |
| Compressors | all | `--compressor` with the checked ones: smart_crusher, kompress, code_aware, search, log, tabular, config, html, image |
| Enable the AST-based code compressor | off | `--code-aware` |
| Turn off ML text compression | off | `--disable-kompress` |
| Never compress results of these tools | empty | `--protect-tool-results`, comma separated, added to headroom's built-in list |
| Rate limit requests | on | off = `--no-rate-limit` |
| Requests / tokens per minute | 60 / unlimited | `--rpm`, `--tpm` (empty = headroom default) |
| Budget, period | none, day | `--budget` USD and `--budget-period`; requests get 429 once it is spent |
| Semantic cache | on | off = `--no-cache` |
| HTTP/2 to providers | on | off = `--no-http2`; helps with `SSLV3_ALERT_BAD_RECORD_MAC` errors |
| Anonymous session summaries to Headroom Labs | on | off sets `HEADROOM_BEACON=off` in the service; local stats keep working |
| Keep request bodies | off | `--log-messages`, so recent requests can be expanded. headroom then keeps prompts, code and replies in memory and logs |
| Extra arguments | empty | Appended as is: quotes and backslashes work, nothing runs through a shell. `--host`, `--port`, `--uds` and `--workers` are refused because the app sets the address from the headroom URL |

## Files the app touches

| Path | What |
|---|---|
| `~/.claude/settings.json` | `env.HTTPS_PROXY`, `env.NODE_EXTRA_CA_CERTS`, `env.NO_PROXY` (merged) |
| `~/.claude/settings.json.bak-ai-desktop-proxy` | One-time backup made before the first change |
| `~/.codex/config.toml` | `openai_base_url` and the comment line above it |
| `~/.codex/config.toml.bak-ai-desktop-proxy` | One-time backup made before the first change |
| `~/.config/ai-desktop-proxy/state.json` | App settings and what was written into each client |
| `~/.config/ai-desktop-proxy/ccusage.json` | The ccusage release you enabled (only while ccusage is enabled) |
| `~/.config/ai-desktop-proxy/updates.json` | App update preferences |
| `~/.config/ai-desktop-proxy/tool-updates.json` | Latest known tool versions and update-check attempt times |
| `~/.config/ai-desktop-proxy/tools/rtk` | App-managed RTK binary; a temporary `rtk.staging` file is used for verification |
| `~/.local/bin/rtk` | Symlink to the app-managed RTK, created only when absent |
| `~/.config/ai-desktop-proxy/cdp_addon.py` | The mitmproxy addon the service loads |
| `~/.config/systemd/user/ai-desktop-proxy.service` | Proxy service |
| `~/.config/systemd/user/ai-desktop-proxy-headroom.service` | headroom service (only if the app runs headroom) |
| `~/.config/autostart/ai-desktop-proxy.desktop` | Start at login (only if enabled) |
| `~/.mitmproxy/` | mitmproxy's CA; trusted only by clients the app routes, never by the system |

Tools you connect on the Tools tab change the client through the tool's or the client's own commands, which the
confirmation lists: RTK adds hooks and `RTK.md` instructions, plugins go into the client's plugin registry, and MCP
servers into `~/.claude.json` or `~/.codex/config.toml`. **Remove** on the Proxy or Compressor card does not undo
those; use the switches and buttons on the [Tools](tools.md) tab.

## Troubleshooting

**After the rename from Claude Desktop Proxy.** Quit the old copy from its tray first: the new name has its own
single-instance lock, so both would otherwise run. The first start copies the old settings and the RTK binary over;
the Proxy and Compressor cards then show **Apply**, which replaces the old `claude-desktop-proxy*.service` units
with `ai-desktop-proxy*.service`. The old `~/.config/claude-desktop-proxy` directory can be deleted after that.

**The proxy card flips between Ok and Degraded, logs say "address already in use".** Another process holds the
port, typically a `mitmdump` started by hand. The card names it ("held by mitmdump (pid …)"); **Restart** or
**Apply** offers to stop it. By hand: `ss -ltnp 'sport = :8877'`, then `kill <pid>`.

**I still see the old window after an update.** The previous copy is still in the tray: **Quit** it there, then
open the app again.

**Remote/cloud Claude sessions are not compressed.** They run on Anthropic's machines, not yours, so their
traffic never reaches your proxy. Use Remote Control or local sessions for work that should be compressed.

**Codex says "conflict" right after `headroom wrap codex`.** headroom's own wrapper writes `model_provider` and
`openai_base_url` into the same file. Run `headroom unwrap codex`, then switch Codex on here.

**Undo everything.** See [Uninstalling](install.md#uninstalling).

