# claude-desktop-proxy

A Linux tray app (Electron) that routes AI coding clients through a local token-compression proxy.

Claude Code Desktop forces `ANTHROPIC_BASE_URL=https://api.anthropic.com`, so a compressor such as
[headroom](https://github.com/headroomlabs-ai/headroom) cannot be set as the base URL. The CLI still honours
`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` from `~/.claude/settings.json`. The app uses that:

```
claude ──HTTPS_PROXY──► mitmdump 127.0.0.1:8877 (systemd user service)
                          ├─ api.anthropic.com ─► headroom 127.0.0.1:6767 ─► api.anthropic.com
                          │                       (headroom down → straight to api.anthropic.com)
                          └─ any other host ─────► plain CONNECT tunnel, not decrypted
```

What the app does:

- turns routing on and off per client (Claude Code today) by editing only its own keys in the client config,
  and keeps them in place: checks at start, on every file change and on a timer;
- installs mitmproxy and headroom with `uv` (after asking) and runs them as systemd user services;
- shows proxy, headroom and client status plus headroom's savings, and lives in the tray.

## Quick start

Requirements: Linux with systemd user services, Node.js 22+, npm, [uv](https://docs.astral.sh/uv/), `ss` (iproute2).

```bash
make install   # npm dependencies and the Electron binary
make run       # build and start the app
```

In the window: **Install mitmproxy** (or **Apply** if the old `cdp.sh` unit exists), make sure headroom answers
(**Install headroom** if it does not), then switch **Claude Code** on. Open a new Claude Code session to use it;
running sessions keep their old environment.

## Documentation

| Document | For |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Using the app: cards, actions, settings, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | How it works: processes, modules, files it writes, safety rules |
| [docs/development.md](docs/development.md) | Building, testing, extending (new clients, compressors) |
| [AGENTS.md](AGENTS.md) | Instructions for coding agents working in this repository |
| [legacy/README.md](legacy/README.md) | The original shell version (`cdp.sh`), kept for reference |

## Status

Done: Claude Code client, mitmproxy service with headroom fallback, headroom service with its options in Settings,
statistics with expandable recent requests, settings,
start at login. Not yet: verified AppImage/deb packages, Codex and Cursor clients, macOS.
