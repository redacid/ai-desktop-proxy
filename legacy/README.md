> **Legacy.** This is the original shell version. The Electron app in the repository root replaces it; its
> **Apply** button migrates the `claude-desktop-proxy.service` unit written by `cdp.sh`. Kept for reference only.

# claude-desktop-proxy

Claude Code Desktop forces `ANTHROPIC_BASE_URL=https://api.anthropic.com` for the CLI it starts, so a
[headroom](https://github.com/headroomlabs-ai/headroom) proxy set up as the base URL is skipped. Other `env` keys from
`~/.claude/settings.json` still reach the CLI, and the CLI honours `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`. This
project uses that:

```
claude ──HTTPS_PROXY──► mitmdump 127.0.0.1:8877
                          ├─ api.anthropic.com → decrypted → headroom (127.0.0.1:6767) → api.anthropic.com
                          └─ any other host    → plain CONNECT tunnel, not decrypted
```

- Only `api.anthropic.com` is decrypted (`--allow-hosts`). Replies are streamed through (`stream_large_bodies=1`).
- The mitmproxy CA is trusted only by processes that get `NODE_EXTRA_CA_CERTS`, never by the system store.
- No loop: headroom is started by Headroom Desktop without `HTTPS_PROXY`, so it calls Anthropic directly.
- `NO_PROXY=127.0.0.1,localhost` keeps the console `claude` (base URL = headroom) off the proxy.
- `ANTHROPIC_UNIX_SOCKET` + `headroom proxy --uds` does not work: the CLI then treats the session as API-key auth.

## Requirements

Linux with systemd user services, `uv`, `curl`, `python3`, and headroom already answering on `127.0.0.1:6767`.

## Usage

```bash
./cdp.sh install    # installs mitmproxy (uv tool), systemd user unit, checks the chain, then edits settings.json
./cdp.sh check      # api.anthropic.com reaches headroom, other hosts tunnel
./cdp.sh status     # unit state, settings env, headroom totals
./cdp.sh uninstall  # removes the settings env first, then the unit
```

After `install`, open a **new** Desktop session; running ones keep their old environment.

| Variable | Default |
|---|---|
| `CDP_PORT` | `8877` |
| `CDP_HEADROOM_URL` | `http://127.0.0.1:6767` |
| `CDP_SETTINGS` | `~/.claude/settings.json` |

`install` refuses to touch `settings.json` when it already sets one of the three variables to a different value,
and keeps a one-time backup in `settings.json.bak-claude-desktop-proxy`. Logs: `journalctl --user -u claude-desktop-proxy`.

## Caveats

- `HTTPS_PROXY` is inherited by the agent's Bash commands (`git`, `curl`, `npm`): they tunnel through mitmdump
  without decryption. If the unit is down, they fail too, which is why the unit runs with `Restart=always`.
- headroom's SessionStart guard (`headroom-claude-guard.py`) may report the route as wrong in Desktop sessions,
  since their base URL is not headroom.

## Test

```bash
python3 test_settings_env.py
```
