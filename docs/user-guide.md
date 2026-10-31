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

If headroom is down while the proxy runs, the card says so: API requests then go straight to Anthropic without
compression, and Claude keeps working.

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

### headroom savings

Lifetime totals (tokens saved, money saved by compression and by cache, requests), the current headroom session,
and tokens saved per day for the last 14 days, from headroom's `/stats-history`.

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
| headroom URL | `http://127.0.0.1:6767` | Base URL without a path. Only a local `http://127.0.0.1`/`localhost` URL can be run by the app |
| Check interval | 60 s | 10–3600 s |
| Restore proxy settings | on | Auto-restore described above |
| Start at login | off | Writes `~/.config/autostart/claude-desktop-proxy.desktop`, which starts the app hidden |

## Files the app touches

| Path | What |
|---|---|
| `~/.claude/settings.json` | `env.HTTPS_PROXY`, `env.NODE_EXTRA_CA_CERTS`, `env.NO_PROXY` (merged) |
| `~/.claude/settings.json.bak-claude-desktop-proxy` | One-time backup made before the first change |
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

**Undo everything.** Switch clients off, **Remove** both services, then optionally
`uv tool uninstall mitmproxy` and `uv tool uninstall headroom-ai`.
