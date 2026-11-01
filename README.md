# AI Desktop Proxy

A Linux tray app (Electron) that routes AI coding clients through a local token-compression proxy.

Claude Code Desktop forces `ANTHROPIC_BASE_URL=https://api.anthropic.com`, so a compressor such as
[headroom](https://github.com/headroomlabs-ai/headroom) cannot be set as the base URL. The CLI still honours
`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` from `~/.claude/settings.json`. The app uses that. Codex cannot use an
HTTPS proxy, but takes `openai_base_url` in `~/.codex/config.toml`, so the same mitmdump has a second, reverse
listener for it:

```
claude ──HTTPS_PROXY──► mitmdump 127.0.0.1:8877 (systemd user service)
                          ├─ api.anthropic.com ─► headroom 127.0.0.1:6767 ─► api.anthropic.com
                          │                       (headroom down → straight to api.anthropic.com)
                          └─ any other host ─────► plain CONNECT tunnel, not decrypted
codex ──openai_base_url─► mitmdump 127.0.0.1:8878 (reverse listener, same service)
                          └─ /v1/… ─────────────► headroom ─► api.openai.com or chatgpt.com/backend-api/codex
                                                  (headroom down → straight to the API Codex would use)
```

What the app does:

- turns routing on and off per client (Claude Code, Codex) by editing only its own keys in the client config,
  and keeps them in place: checks at start, on every file change and on a timer;
- installs mitmproxy and headroom with `uv` (after asking) and runs them as systemd user services;
- shows proxy, headroom and client status plus headroom's savings, and lives in the tray.
- detects RTK and Ponytail per client, offers installation, and checks headroom/RTK/Ponytail updates every six
  hours; installs, updates and RTK hook connections require approval with the exact commands or download steps.

## Install on Linux

On a Linux x64 desktop with systemd (Debian/Ubuntu, Fedora/RHEL or openSUSE), run as your normal user:

```bash
curl -fsSL https://raw.githubusercontent.com/redacid/ai-desktop-proxy/feat/electron-app/install.sh | bash
```

The installer downloads the latest stable GitHub Release, verifies its SHA-256 checksum, and installs the deb/rpm
with its runtime dependencies (sudo is requested). It also installs missing uv/uvx, Node.js/npm, mitmproxy and
headroom. Existing working tools are kept. Optional tools remain selectable in the app. Open **AI Desktop Proxy**
from the applications menu, set up the Proxy and Compressor services, then enable your clients.

Releases must provide `SHA256SUMS` or a SHA-256 asset digest through GitHub. To inspect the installer first:

```bash
curl -fsSL https://raw.githubusercontent.com/redacid/ai-desktop-proxy/feat/electron-app/install.sh -o install.sh
less install.sh
bash install.sh
```

See [installation details](docs/user-guide.md#installing-a-release) for prerequisites and file locations.

## Quick start (from source)

Requirements: Linux with systemd user services, Node.js 22+, npm, [uv](https://docs.astral.sh/uv/), `ss` (iproute2).

```bash
make install   # npm dependencies and the Electron binary
make run       # build and start the app
```

In the window: **Install mitmproxy** (or **Apply** if the old `cdp.sh` unit exists), make sure headroom answers
(**Install headroom** if it does not), then switch **Claude Code** or **Codex** on. Open a new session to use it;
running sessions keep their old settings.

## Documentation

| Document | For |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | Using the app: cards, actions, settings, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | How it works: processes, modules, files it writes, safety rules |
| [docs/development.md](docs/development.md) | Building, testing, extending (new clients, compressors) |
| [docs/plan.md](docs/plan.md) | Planned work and deferred headroom integration improvements |
| [AGENTS.md](AGENTS.md) | Instructions for coding agents working in this repository |
| [legacy/README.md](legacy/README.md) | The original shell version (`cdp.sh`), kept for reference |

## Status

Done: Claude Code and Codex clients, mitmproxy service with headroom fallback, headroom service with its options in Settings,
statistics with expandable recent requests, approved tool installation/update checks and RTK client connections, settings,
start at login. GitHub CI validates every push; version tags publish deb/rpm releases. Not yet: package installation smoke tests, Cursor client, macOS.
Planned headroom improvements: diagnostics, quotas, detailed savings, CCR inspection and tuning; see [the project plan](docs/plan.md).

## CI and releases

GitHub Actions runs validation, tests and a build on every push and pull request. A pushed version tag such as
`0.1.0` additionally builds Linux x64 deb/rpm packages and publishes them in a GitHub Release after checks pass.
See [release instructions](docs/development.md#github-ci-and-releases).

Use `make bump` to increment the app version, or `make version VERSION=0.2.0` to also prepare CHANGELOG.md.
GitHub Release descriptions use that version’s changelog section.

Installed builds support app self-updates from GitHub Releases: checks every two hours, optional automatic
background downloads, changelog display and explicit **Update and restart**. Development builds disable updating.
