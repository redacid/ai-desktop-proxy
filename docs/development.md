# Development

## Setup

Linux, Node.js 22+, npm, Python 3 (addon tests). `make` with no target lists every target.

| Target | What |
|---|---|
| `make install` | npm dependencies (`npm ci` with a lockfile) and the Electron binary, even with npm `ignore-scripts` |
| `make dev` | electron-vite dev mode with hot reload |
| `make build` | Build main, preload and renderer into `out/` |
| `make run` / `make run-hidden` | Build, then start (window / tray only) |
| `make typecheck` | `tsc` for the node and web projects |
| `make test` | vitest unit tests (`src/**/*.test.ts`) |
| `make test-addon` | Python tests for the mitmproxy addon (no mitmproxy needed) |
| `make check` | typecheck + test + test-addon: run before every commit |
| `make dist`, `dist-appimage`, `dist-deb` | electron-builder packages into `dist/` (not verified yet) |
| `make icons` | Regenerate every icon (SVG sources and PNGs) from `scripts/icons.mjs` |
| `make clean`, `make distclean` | Remove `out/` and `dist/`; also `node_modules` |

## Layout

```
src/shared/ipc.ts       IPC contract and every type crossing it
src/main/               main process (see docs/architecture.md)
src/preload/            window.api over contextBridge
src/renderer/           React UI (App.tsx, RecentRequests.tsx, messages.ts, styles.css)
resources/              icons and the mitmproxy addon (shipped as extraResources)
  icon.png, icons/      app icon: 512 px and the NxN.png set electron-builder uses for Linux
  tray/                 tray icons per health (22 px + @2x, plus 16/24/32 sizes) and busy-N animation frames
  icon-src/             generated SVG sources, static and animated (SMIL)
scripts/icons.mjs       icon generator
examples/               sample headroom /stats-history and /transformations/feed responses used by tests
legacy/                 original cdp.sh + settings_env.py, reference only
docs/                   user guide, architecture, this file
```

## Tests

Unit tests sit next to the code (`*.test.ts`). They use temporary directories and injected runners, so they never
touch your real `~/.claude`, systemd or network:

- `ClaudeCodeAdapter`: symlinks, file mode, Unicode, `NO_PROXY` merge, conflicts, broken JSON, port moves.
- `ClientManager`: enable refused without proxy, auto-restore, failsafe, suspend/resume.
- `ProxyManager`/`HeadroomService` pieces: unit rendering and quoting, outdated/legacy detection, port owner.
- `parseStatsHistory` against `examples/headroom-stats.json`; `parseFeed`/`detailFromFeed` and the renderer's
  `messages.ts` against `examples/headroom-feed.json`.

### End-to-end without systemd

A container without a systemd user session can still drive the whole app:

1. Put a fake `systemctl` first in `PATH` that reads `ExecStart=` from `~/.config/systemd/user/<unit>`, un-escapes
   `$$`/`%%`, and runs it in the background with a pid file (`start`, `stop`, `restart`, `is-active`,
   `show -p MainPID`), plus a `journalctl` that prints its log.
2. Start Electron with Playwright (`_electron.launch`) under `xvfb-run`, with `HOME` and `XDG_CONFIG_HOME` pointing
   at a scratch directory, and replace `dialog.showMessageBox` with a stub that confirms.
3. Click through: Install mitmproxy → Install headroom → switch Claude Code on → `curl` through the proxy →
   Stop/Start → change the port in Settings, and assert on the scratch `settings.json`.

Kill leftover `mitmdump`/`headroom` processes between runs; a stale one on the port makes the next run fail.

## Adding a client (Codex, Cursor, …)

1. Implement `ClientAdapter` in `src/main/clients/<name>.ts`: `configPath`, `watchPaths()`, `inspect(env,
   record)`, `apply(env, previous)` returning an `AppliedRecord`, `remove(record, env)`. Follow the invariants in
   [architecture.md](architecture.md#invariants); reuse `fsutil.ts` for writes.
2. Register it in `index.ts` (`new ClientManager([new ClaudeCodeAdapter(), new YourAdapter()], store)`). The UI
   and tray list clients from status, so no UI change is needed.
3. Add tests mirroring `claude-code.test.ts`.
4. Document it in the user guide (clients table, files the app touches) and the README status.

## Adding a compressor

Today headroom is wired directly (`HeadroomBackend`, `HeadroomService`). A second compressor means extracting a
`CompressorBackend` interface (`health`, `stats`, `info`, `install`, `setup`, …) from those two, choosing the
active one in settings, and passing its URL to the addon as `cdp_upstream`.

## Conventions

- TypeScript strict, no unused locals; no shell strings: run commands with argument arrays (`proxy/exec.ts`).
- Comments explain why, not what.
- Every user-visible behaviour change updates `docs/` and the README status in the same commit.

## Icons

All icons come from one generator, `scripts/icons.mjs`; edit it and run `make icons`, never the PNGs by hand.
The output is committed, so building the app needs no browser. The generator renders with Playwright's Chromium,
which it resolves from the project or from the global npm root (`npm i -g playwright && npx playwright install chromium`).

The mark is `>•<`: two chevrons squeezing a dot, for traffic pinched through a local proxy and made smaller. The tray
uses it flat in the health colour (same values as `--ok`, `--degraded`, `--down`, `--unknown` in `styles.css`);
the app icon puts it on a dark rounded tile. The animated variant closes the chevrons in and shrinks the dot over
1.2 s: `icon-src/*-animated.svg` animate with SMIL, and the tray plays the same motion from eight `tray/busy-N.png`
frames (blue) while a service action runs. Below 48 px the app icon drops its sheen and draws the mark larger.
