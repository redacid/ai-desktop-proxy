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

Stage 1 of the plan: window, tray (closing the window hides it), typed IPC, status polling skeleton.
Next: Claude Code adapter + config watcher, mitmproxy manager, headroom backend and stats.

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
