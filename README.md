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
- Not yet: starting/installing mitmproxy and headroom (use `legacy/cdp.sh install` for the proxy for now).

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
