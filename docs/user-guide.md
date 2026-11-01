# User guide

## Installing a release

Run this as your desktop user (not root, and do not pipe into `sudo bash`):

```bash
curl -fsSL https://raw.githubusercontent.com/redacid/ai-desktop-proxy/main/install.sh | bash
```

Supported: Linux x86_64 desktops with systemd and apt-get (Debian/Ubuntu), dnf (Fedora/RHEL), or zypper
(openSUSE), Internet access, sudo privileges, and curl to fetch the installer. ARM releases are not built yet.
If curl is missing, install it using your distribution's package manager first.

The installer:

- Installs system prerequisites (CA certificates, Python 3, Git, iproute and archive tools).
- Finds the latest stable public GitHub Release, downloads its deb/rpm and verifies SHA-256 using `SHA256SUMS` (or the GitHub API asset digest for older releases).
  Missing assets/checksum data or a checksum mismatch stop installation. The checksums detect a damaged download; packages
  are not code-signed. Older releases work when GitHub provides their SHA-256 asset digest.
- Keeps Node.js 20.18.1+ with npm/npx when available. Otherwise installs the official Node.js 22 distribution
  under `/opt/ai-desktop-proxy-node/` with links in `/usr/local/bin`, after checking its SHA-256 checksum.
  It refuses to overwrite unrelated files already in those link locations.
- Installs missing uv/uvx with Astral's official installer into `~/.local/bin` without changing shell profiles.
- Installs missing mitmproxy and `headroom-ai[all]` with `uv tool install --python 3.13`; uv can download Python
  3.13 if needed. Headroom and its models/dependencies can require a substantial download.
- Uses the native package manager to install the app and resolve its GUI/runtime dependencies.

Open AI Desktop Proxy from the applications menu (restart an already running copy). In Overview, set up/start the
Proxy and Compressor services, then turn on client routing. Optional tools, client CLIs and their account logins
are configured separately. Installation does not enable services or change Claude/Codex routing. Settings, indexes
and existing working tools are kept. Installed builds can subsequently update from inside the app.

For download-and-review installation:

```bash
curl -fsSL https://raw.githubusercontent.com/redacid/ai-desktop-proxy/main/install.sh -o install.sh
less install.sh
bash install.sh
```

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

The window has four tabs:

| Tab | What it holds |
|---|---|
| Overview | Proxy, Compressor and Clients cards; its dot repeats the overall state |
| Savings | headroom savings and recent requests |
| Tools | Tools & updates: headroom, RTK, Ponytail, Chisle, Serena, MarkItDown |
| Settings | App and headroom settings |

Errors and the Install log stay visible on every tab, and a running tool action keeps going when you switch tabs.

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
| Set up & start | installed, no service | Writes `ai-desktop-proxy.service` and starts it |
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
`ai-desktop-proxy-headroom.service`. The first start can take up to a minute.

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

### Tools & updates

This section checks headroom, RTK, the Ponytail and Chisle plugins, and the Serena and MarkItDown MCP servers, per client
where it applies (Claude Code, Codex).
Installation presence is checked at startup and every minute while the app runs. New stable versions are
checked at startup when the cached result is older than six hours, then every six hours. **Check for updates**
forces a fresh check. The cadence survives app restarts. A failed check shows an error and keeps the last
known version; a detection error is **unknown**, never treated as proof that a tool is missing.

**Install** appears for missing tools; **Update to …** appears when a newer stable version is known.
Nothing installs or updates automatically. Each action first opens a confirmation with the commands or
download URLs and file changes. Cancel makes no installation or configuration changes. Progress and errors
appear in the Install log. Missing optional tools do not turn the proxy's health red.

- **headroom:** requires `uv`. Installs a specific checked release with
  `uv tool install --upgrade --python 3.13 "headroom-ai[all]==<version>"`. An active app-managed service
  restarts afterward; a stopped service stays stopped. For a new installation, use **Set up & start** on
  the Compressor card afterward. Externally managed headroom and remote URLs are left alone. The original
  Compressor-card **Install headroom** action still installs and starts the service together.
- **RTK:** downloads the official Linux x64 or arm64 release archive and `checksums.txt`, verifies SHA-256,
  and installs a staged, version-checked binary in the app's `userData/tools/rtk`. It creates
  `~/.local/bin/rtk` as a symlink to that binary. It never replaces a foreign file or symlink at that path;
  update such an installation with its owner/package manager, or move it yourself first. No root access
  is needed. Coding clients must have `~/.local/bin` on PATH before other RTK installations; restart clients
  after installation. **Connect to Claude Code / Codex** previews the native `rtk init` changes, then asks
  before registering global hooks and instructions. Custom project filters are not automatically trusted.
  Reconnection is explicit; stopping the API proxy does not remove RTK hooks. The card lists Claude Code and
  Codex with a switch each, like the Clients card. Their state comes from `rtk init -g --show` (and
  `--codex --show`): **connected** only when every global item is in place, so a partial setup reads as not
  connected and switching on repairs it. Switching off previews and runs `rtk init -g [--codex] --uninstall`,
  which removes RTK's hooks, `RTK.md` and the `@RTK.md` reference; RTK itself stays installed.
- **Ponytail:** requires the corresponding client CLI with plugin support. Uses the official
  `DietrichGebert/ponytail` marketplace and the client's native install/update commands. Only the Ponytail
  marketplace is refreshed, not every marketplace or plugin. A different marketplace already named
  `ponytail` is a conflict, not overwritten. Installation and updates may run plugin lifecycle code, as with
  installation directly in the client. Restart client sessions after changes. In Codex, review and trust
  Ponytail hooks through `/hooks`; this app does not approve hook trust. An installed but disabled plugin
  is reported as disabled; enable it in the client. Ponytail modes remain controlled by `/ponytail` in the
  client; the app does not rewrite project `AGENTS.md` with Ponytail instructions. Ponytail has one card with a
  switch per client: on installs it, off uninstalls it with the client's own command
  (`claude plugin uninstall ponytail@ponytail --scope user`, `codex plugin remove ponytail@ponytail`).

- **Chisle:** a Claude Code plugin handled like Ponytail, from the official `JayPokale/Chisle` marketplace
  (`chisle@chisle`), with the same card and per-client switch. Chisle has no Codex plugin (its Codex setup is an
  `npx chisle` run that edits `~/.codex/AGENTS.md`), so the app offers it for Claude Code only. Chisle and
  Ponytail both set a terse "lazy senior developer" style; running both doubles those instructions.
- **Serena, MarkItDown:** MCP servers, so there is nothing to install besides `uv`. A switch per client
  registers the server at user scope with the client's own command, run by uvx from a pinned PyPI release:
  `claude mcp add --scope user serena -- uvx --python 3.13 --from serena-agent==<version> serena start-mcp-server
  --context claude-code --project-from-cwd` (`--context codex` for Codex), and `markitdown-mcp==<version>
  markitdown-mcp` for MarkItDown. Switching off runs `claude mcp remove --scope user <name>` or
  `codex mcp remove <name>`. **Update** re-registers the new pin in every client the app connected. A server
  with the same name that the app did not add (another command, or no pin) shows **set up elsewhere** and is
  never changed. State is read from `~/.claude.json` (`mcpServers`) and `$CODEX_HOME/config.toml`
  (`mcp_servers`). uvx downloads the release on the client's next start.

**Open dashboard ↗** appears on a card while the tool's own web dashboard answers on this machine: headroom at
`<headroom URL>/dashboard`, Serena at `http://127.0.0.1:24282/dashboard/` (each running Serena takes the next port,
so there can be several links), and Codebase Memory's CBM Lens at `http://127.0.0.1:9749/` when its daemon runs
with the UI. The app checks these addresses with the presence check. Only CBM Lens can be started from the app:
the Codebase Memory card has a **Dashboard (CBM Lens)** switch that runs `npx -y codebase-memory-mcp@<version>
daemon start --port=9749` (off: `daemon stop`) with the same pinned build the clients use, after a confirmation.
The daemon keeps running when the app quits, and client sessions share it while it runs. RTK's dashboard (`rtk gain --watch`) is terminal-only, and the other
tools have none.

Hovering a card shows what the tool is for; **↗** next to its name opens the project's official page in the
browser. The headroom card shows the service state and its lifetime savings with a 14-day chart; the Savings tab
has the full detail.

**Stop / Start / Remove from system.** RTK, Serena, MarkItDown, Ponytail and Chisle cards end with machine-wide
buttons; each opens a confirmation that lists its commands, and the app checks the result afterwards.

| Tool | Stop (keeps it installed) | Remove from system |
|---|---|---|
| RTK | `rtk init -g [--codex] --uninstall` for every connected client | Stop, then delete the app-managed binary and its `~/.local/bin/rtk` symlink. An RTK installed elsewhere is refused. Savings history stays |
| Serena, MarkItDown | Remove the app's registration from every client | Stop, then `uv cache clean <package>` |
| Ponytail, Chisle | `claude plugin disable … --scope user`; **Start** enables it again. Codex has no plugin disable, so there only its switch (uninstall) applies | Uninstall from every client, then remove the official marketplace (`plugin marketplace remove`); a marketplace of that name from another source stays |

Registrations or marketplaces set up outside the app are never touched.

- **Context7:** an MCP server that fetches current library documentation. The app runs it locally with npx from a
  pinned npm release (`claude mcp add --scope user context7 -- npx -y @upstash/context7-mcp@<version>`, the same
  with `codex mcp add`), so it needs Node.js 20.18+; it still queries context7.com for the documentation itself.
  **Update** re-pins the clients the app connected. If Claude Code already has the official `context7` plugin (a
  remote server), its row shows **set up elsewhere**. **Stop** removes the app's registrations; there is nothing
  else to remove.

- **Codebase Memory:** [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) indexes the code into
  a local knowledge graph the agent queries instead of re-reading files. Handled like Context7: run by npx from a
  pinned npm release (`npx -y codebase-memory-mcp@<version>`; the package downloads and verifies the release binary
  on first start), a switch per client, **Update** re-pins. Its own `codebase-memory@codebase-memory` Claude Code
  plugin counts as set up elsewhere. Indexes stay in `~/.cache/codebase-memory-mcp`; the app never deletes them,
  so the card has **Stop** but no **Remove from system**. The project's full installer (`codebase-memory-mcp install`,
  with skills and hooks) is not used.

Each card also shows what the tool achieved, refreshed with the presence check:

- **RTK:** tokens saved, average saving and commands filtered, plus tokens saved per day for the last 14 days,
  from `rtk gain --daily --format json`. These are RTK's own local records on this machine.
- **Ponytail:** totals from Ponytail's own band ledger (`$XDG_CONFIG_HOME/ponytail/band/*.csv`, default
  `~/.config/ponytail/band`): cost, tokens, turns and agent time over every Claude Code session it recorded,
  the same figures as its band in Claude Code. They show what the sessions used, not what Ponytail saved.
  Until the ledger has a session, the card shows the published benchmark from the installed plugin's
  `ponytail-gain` skill instead (less lines of code, output tokens, cost, time), labelled as such.

- **Chisle:** characters its compress-output hook elided from tool output, an estimate of tokens (characters ÷ 4),
  and how many outputs it compressed, from `~/.claude/.chisle-compress-stats.json`.
- **Serena, MarkItDown:** none; Serena keeps its tool-usage statistics only in a running server's dashboard.

Version sources are PyPI (`headroom-ai`, `serena-agent`, `markitdown-mcp`), npm (`@upstash/context7-mcp`, `codebase-memory-mcp`), GitHub
Releases (`rtk-ai/rtk`), and
the official Ponytail and Chisle plugin manifests. GitHub rate limits, an offline machine, or unsupported client CLI output can prevent a check;
the error is shown without attempting an installation. After a partial native-command failure, review
the log: earlier steps may already have completed. Tool versions and installation paths are distinct
from a running headroom process's version until that process is restarted.

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
| `~/.config/ai-desktop-proxy/tool-updates.json` | Latest known tool versions and update-check attempt times |
| `~/.config/ai-desktop-proxy/tools/rtk` | App-managed RTK binary; a temporary `rtk.staging` file is used for verification |
| `~/.local/bin/rtk` | Symlink to the app-managed RTK, created only when absent |
| `~/.config/ai-desktop-proxy/cdp_addon.py` | The mitmproxy addon the service loads |
| `~/.config/systemd/user/ai-desktop-proxy.service` | Proxy service |
| `~/.config/systemd/user/ai-desktop-proxy-headroom.service` | headroom service (only if the app runs headroom) |
| `~/.config/autostart/ai-desktop-proxy.desktop` | Start at login (only if enabled) |
| `~/.mitmproxy/` | mitmproxy's CA; trusted only by clients the app routes, never by the system |

Approved RTK connection commands additionally manage the client's global hooks and instruction files
(`settings.json`, `CLAUDE.md`, `RTK.md`, RTK hook/filter files for Claude; `$CODEX_HOME/hooks.json`,
`AGENTS.md`, `RTK.md` for Codex). Their native dry-run lists the changes before approval. Approved Ponytail
commands manage the client's marketplace registry, plugin cache and enablement through its own CLI.
These client-managed artifacts are not removed by **Remove** on either proxy service card.

## Troubleshooting

**After the rename from Claude Desktop Proxy.** Quit the old copy from its tray first: the new name has its own
single-instance lock, so both would otherwise run. The first start copies the old settings and the RTK binary over;
the Proxy and Compressor cards then show **Apply**, which replaces the old `claude-desktop-proxy*.service` units
with `ai-desktop-proxy*.service`. The old `~/.config/claude-desktop-proxy` directory can be deleted after that.

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

## Downloading release packages

GitHub Releases publishes Linux x64 `.deb` and `.rpm` installers for version tags such as `0.1.0`.
Download the package for your distribution from the corresponding release. Packages are built only after
CI validation succeeds; CI checks package metadata, but does not test installation on every distribution.

## App self-updates

Installed deb/rpm packages (and AppImage builds) check GitHub Releases for a newer stable version on first launch,
then every **2 hours** while the app runs. The last check is saved, so restarting the app does not reset the cadence.
Development (`make run`) and unpacked builds show that updating is unavailable.

**Settings → App updates** shows the current version, last check and switches for automatic checking and downloading
(both on by default). **Check for updates** and **Download update** can be used manually. A notice on other tabs
shows the new version, release notes and download progress; **Later** hides the notice for this run.

Updates are downloaded and checksum-checked by electron-updater. Installation happens only after **Update and
restart**; quitting normally does not install it. The app refuses installation while a service/tool operation is
running; retry when that operation finishes. Installing deb/rpm can prompt for administrator authentication via the
system installer. Proxy and headroom services keep running across the app restart. Preferences are stored in
`~/.config/ai-desktop-proxy/updates.json`. The first release that includes this feature must be installed manually.
