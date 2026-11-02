# AI Desktop Proxy

A Linux tray app that routes Claude Code and Codex through a local compression proxy (mitmproxy and headroom), so
your coding agents send fewer tokens. It also installs and connects optional tools that help agents use less
context. Closing the window keeps the app in the tray; the proxy services keep running when you quit it.

[![Overview with the proxy, compressor and connected clients](images/overview.png)](images/overview.png)

## How it works

![Request path: Claude Code and Codex go through mitmdump and headroom to the provider; when headroom is down, mitmdump sends requests straight to the provider](images/request-path.svg)

Claude Code reaches the proxy through `HTTPS_PROXY`, Codex through `openai_base_url`. API requests pass through
headroom, which compresses them. If headroom is down, requests go straight to the provider, uncompressed, and your
clients keep working. Traffic to other hosts is passed through without being decrypted.

## Install

Run as your normal desktop user on an x64 Linux distribution with systemd:

```bash
curl -fsSL https://raw.githubusercontent.com/redacid/ai-desktop-proxy/main/install.sh | bash
```

The script downloads the latest release, checks its checksum and installs it with mitmproxy, headroom and uv. See
[Install and update](install.md) for requirements, what it installs and how to uninstall.

## First run

1. Open **AI Desktop Proxy** from the applications menu.
2. On **Overview**, use **Set up & start** on the Proxy and Compressor cards.
3. Turn on **Claude Code** or **Codex**, then start a new client session.
4. Open **Savings** to see what headroom compresses, **Tools** to add optional tools, and **Settings** for ports,
   headroom options, start at login and app updates.

## Documentation

- [Install and update](install.md): requirements, installation, app updates, uninstalling.
- [Interface tour](interface.md): every tab, with screenshots.
- [User guide](user-guide.md): cards, buttons, settings, the files the app changes, and troubleshooting.
- [Tools](tools.md): RTK, Ponytail, Chisle, Caveman, Serena, MarkItDown, Context7, Codebase Memory and ccusage.

Screenshots use demonstration data; values, paths and versions are examples. The site follows the latest release.
Developer documentation (architecture, building, contributing) lives in the
[repository](https://github.com/redacid/ai-desktop-proxy/tree/main/docs-dev).
