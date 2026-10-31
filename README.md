# claude-desktop-proxy

Tray app (Electron) that routes AI coding clients through a local compression proxy:

```
claude ──HTTPS_PROXY──► mitmdump 127.0.0.1:8877
                          ├─ api.anthropic.com → headroom (127.0.0.1:6767) → api.anthropic.com
                          └─ any other host    → plain CONNECT tunnel, not decrypted
```

Claude Code Desktop forces `ANTHROPIC_BASE_URL=https://api.anthropic.com`, so headroom cannot be set as the base URL.
The CLI still honours `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` from `~/.claude/settings.json`; the app manages those.
The original shell version lives in [`legacy/`](legacy/).

## Status

- Window + tray (closing the window hides it; `--hidden` starts in the tray), typed IPC.
- Claude Code: the app writes `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and `NO_PROXY` into `~/.claude/settings.json`
  and removes exactly what it wrote. It re-checks the file at start, on every change and every 60 s, and restores
  settings that disappeared while the proxy is up. Foreign values are reported as a conflict, never overwritten.
  Turning a client on is refused while nothing listens on the proxy port.
- headroom: health and savings from `/stats-history` (sample in `examples/headroom-stats.json`).
- Proxy: installs mitmproxy with `uv tool install mitmproxy` (after asking), writes and runs the systemd user
  service `claude-desktop-proxy.service` (same name as the `cdp.sh` one, which "Apply" replaces), shows its logs.
  The mitmproxy addon (`resources/mitmproxy/cdp_addon.py`) sends API requests to headroom while it answers
  `/health` and straight to the API when it does not, so Claude keeps working without compression.
- Stopping or removing the proxy from the app first removes the proxy settings from every client; they come back
  when the proxy is started again. If the proxy dies on its own for more than ~5 s, the same happens automatically.
- headroom: when nothing answers at the headroom URL, the app can install headroom
  (`uv tool install --python 3.13 "headroom-ai[all]"`, after asking) and run it as
  `claude-desktop-proxy-headroom.service` (proxy variables unset, so it never loops through mitmproxy).
  A headroom run elsewhere (e.g. Headroom Desktop) is only monitored, never started or stopped.
- Settings: proxy port, headroom URL, check interval, auto-restore, start at login (an XDG autostart entry that
  starts the app hidden in the tray). Changing the port or URL restarts the services the app runs and re-points
  routed clients; settings written for the old port are updated, not reported as a conflict.
- Not yet: packaging checks (AppImage/deb), Codex and Cursor, macOS.

App state lives in `~/.config/claude-desktop-proxy/state.json`; the first edit of a client config keeps a backup
next to it (`settings.json.bak-claude-desktop-proxy`).

## Development

Requirements: Linux, Node.js 22+, npm. Run `make` to list targets.

```bash
make install        # npm dependencies
make dev            # hot-reload dev mode
make run            # build and start the built app
make run-hidden     # build and start straight into the tray
make check          # typecheck + unit tests
make dist           # AppImage + deb into dist/
```

On GNOME the tray icon needs the AppIndicator extension.
