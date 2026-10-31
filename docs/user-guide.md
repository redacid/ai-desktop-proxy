# User guide

## Starting the app

```bash
make run          # window opens
make run-hidden   # starts straight into the tray
```

Closing the window hides it to the tray; **Quit** in the tray menu exits. Only one copy runs at a time: starting
it again brings the existing window forward. After `git pull`, quit the running copy first, or you will keep
seeing the old build.

On GNOME the tray icon needs the AppIndicator extension.

## The window

The dot next to the title and the tray icon colour show the overall state:

| Colour | Meaning |
|---|---|
| green | proxy, headroom and every routed client are fine |
| amber | something needs attention (e.g. headroom down, a client lost its settings) |
| red | the proxy is down |
| grey | not checked yet |

While the app installs, starts or stops a service, the tray icon turns blue and pulses (the chevrons squeeze the
dot) until the action finishes.

The window polls every 5 s while it is visible and every 30 s while it sits in the tray. **Check now** forces a
check.

### Proxy (mitmproxy)

| Buttons you see | When | What they do |
|---|---|---|
| Install mitmproxy | mitmproxy is not installed | Asks, runs `uv tool install mitmproxy`, then sets up and starts the service |
| Set up & start | installed, no service | Writes `claude-desktop-proxy.service` and starts it |
| Apply | the service was written by `cdp.sh` or by an older app version, or settings changed | Rewrites and restarts the service |
| Restart / Stop / Start | service exists | systemd actions. Stop first removes proxy settings from routed clients |
| Remove | service exists | Removes client settings, then stops and deletes the service. mitmproxy stays installed |
| Logs | service exists | The last 80 journal lines |

If headroom is down while the proxy runs, the card says so: API requests then go straight to Anthropic (and Codex's to
OpenAI or ChatGPT) without compression, and the clients keep working. The card also checks the second listener
Codex uses and shows **Degraded** while only one of the two ports answers.

### Compressor (headroom)

If headroom already answers at the configured URL but was not started by this app (for example by Headroom
Desktop), the card shows "run outside this app" and offers no buttons: the app never starts or stops it.

Otherwise the card offers **Install headroom** (`uv tool install --python 3.13 "headroom-ai[all]"`, a few hundred
MB), **Set up & start**, and the same Restart / Stop / Start / Remove / Logs as the proxy, for
`claude-desktop-proxy-headroom.service`. The first start can take up to a minute.

### Clients

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

### headroom savings

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
| Start at login | off | Writes `~/.config/autostart/claude-desktop-proxy.desktop`, which starts the app hidden |

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
| `~/.claude/settings.json.bak-claude-desktop-proxy` | One-time backup made before the first change |
| `~/.codex/config.toml` | `openai_base_url` and the comment line above it |
| `~/.codex/config.toml.bak-claude-desktop-proxy` | One-time backup made before the first change |
| `~/.config/claude-desktop-proxy/state.json` | App settings and what was written into each client |
| `~/.config/claude-desktop-proxy/cdp_addon.py` | The mitmproxy addon the service loads |
| `~/.config/systemd/user/claude-desktop-proxy.service` | Proxy service |
| `~/.config/systemd/user/claude-desktop-proxy-headroom.service` | headroom service (only if the app runs headroom) |
| `~/.config/autostart/claude-desktop-proxy.desktop` | Start at login (only if enabled) |
| `~/.mitmproxy/` | mitmproxy's CA; trusted only by clients the app routes, never by the system |

## Troubleshooting

**The proxy card flips between Ok and Degraded, logs say "address already in use".** Another process holds the
port, typically a `mitmdump` started by hand. The card names it ("held by mitmdump (pid …)"); **Restart** or
**Apply** offers to stop it. By hand: `ss -ltnp 'sport = :8877'`, then `kill <pid>`.

**`make run` fails with "Electron uninstall".** npm skipped Electron's post-install step (`ignore-scripts`).
`make install` downloads the binary; by hand: `node node_modules/electron/install.js`.

**I still see the old window after an update.** The previous copy is still in the tray: **Quit** it, then
`make run`.

**Remote/cloud Claude sessions are not compressed.** They run on Anthropic's machines, not yours, so their
traffic never reaches your proxy. Use Remote Control or local sessions for work that should be compressed.

**Codex says "conflict" right after `headroom wrap codex`.** headroom's own wrapper writes `model_provider` and
`openai_base_url` into the same file. Run `headroom unwrap codex`, then switch Codex on here.

**Undo everything.** Switch clients off, **Remove** both services, then optionally
`uv tool uninstall mitmproxy` and `uv tool uninstall headroom-ai`.
