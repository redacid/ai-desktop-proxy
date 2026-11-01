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
| `make dist`, `dist-appimage`, `dist-deb` | electron-builder packages into `dist/`; default targets: AppImage, deb, rpm |
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
- `CodexAdapter`: byte-exact round trip with comments, old-port moves, foreign `openai_base_url` and `model_provider`,
  broken TOML, hand-edited lines, symlinks.
- `cdp_addon.py` `plan()`: Codex to headroom, fallback to api.openai.com or chatgpt.com, Claude routes unchanged.
- `ClientManager`: enable refused without proxy, auto-restore, failsafe, suspend/resume.
- `ProxyManager`/`HeadroomService` pieces: unit rendering and quoting, outdated/legacy detection, port owner.
- `parseStatsHistory` against `examples/headroom-stats.json`; `parseFeed`/`detailFromFeed` and the renderer's
  `messages.ts` against `examples/headroom-feed.json`.
- `ToolManager`: injected registry requests, command runners, clock, client discovery and headroom lifecycle;
  temporary roots for cache, binaries and symlinks. Covers approval cancellation, six-hour persistence/backoff,
  per-client plugin detection, native command plans, source conflicts, external/stopped services, checksum
  failure, archive entry restrictions and preserving a working binary on failed verification.

## Tool integrations

`src/main/integrations/tools.ts` manages package/plugin presence and updates independently of API routing.
Add any new IPC types/channels to `src/shared/ipc.ts`; UI lives in `src/renderer/src/Tools.tsx`. Do not add
optional-tool failures to overall proxy health. Installation and update actions must prepare a reviewable
plan and pass through `approveToolAction` and the main process's serialized confirmation path.

Tests must inject `ToolDependencies` and use temporary `root`/`home` paths. Never run real client installers,
network fetches, systemd actions or writes to user config in unit tests. Native CLI compatibility is checked
from actual command help and schemas: notably Codex refreshes a marketplace with `plugin marketplace upgrade`
and installs/reinstalls with `plugin add`; it has no `plugin update` subcommand in the inspected runtime.

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

## Adding a client (Cursor, …)

1. Implement `ClientAdapter` in `src/main/clients/<name>.ts`: `configPath`, `watchPaths()`, `inspect(env,
   record)`, `apply(env, previous)` returning an `AppliedRecord`, `remove(record, env)`. Follow the invariants in
   [architecture.md](architecture.md#invariants); reuse `fsutil.ts` for writes.
   A client that honours `HTTPS_PROXY` and a CA file follows `claude-code.ts`; one that only takes a base URL
   follows `codex.ts` and needs a listener in `mitmdumpArgs` plus a route in `cdp_addon.py`'s `plan()`.
2. Register it in `index.ts` (`new ClientManager([new ClaudeCodeAdapter(), new CodexAdapter(), new YourAdapter()], store)`). The UI
   and tray list clients from status, so no UI change is needed.
3. Add tests mirroring `claude-code.test.ts` or `codex.test.ts`.
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

## GitHub CI and releases

`.github/workflows/ci.yml` runs on every push (branches and tags) and pull request: Node.js 22, Python 3.13,
`npm ci`, Electron binary installation, `make check`, and `make build` on Ubuntu 24.04.

Pushing a tag exactly matching `MAJOR.MINOR.PATCH`, without a `v` prefix or prerelease suffix (for example
`0.1.0`), also builds Linux x64 deb and rpm packages after validation succeeds. The tag supplies the packaged
app version via electron-builder's `extraMetadata.version`; it does not change the committed package.json.
The job checks each package's version, creates a draft GitHub Release, uploads both packages, then publishes it
with the version’s changelog section (or a generated commit list when no section exists). A failed upload leaves a draft and can be retried by re-running the job.
Published releases are not overwritten. The release job uses the automatic `GITHUB_TOKEN` with `contents: write`;
no personal token is needed. Repository policy must allow that permission.

To release a committed revision, push it and its version tag:

```bash
git tag 0.1.0
git push origin 0.1.0
```

Other tag formats still run checks but do not publish a release. Release packages are not code-signed.
`npm run dist -- --rpm --x64 --publish never` can also build an rpm locally; Linux rpm tooling is required.

## Preparing a version

`make bump` increments the patch version in package.json and both app version entries in package-lock.json.
Dependency versions and historical version examples are preserved. Use `make bump BUMP=minor`, `BUMP=major`,
or `make bump VERSION=0.2.0` to choose the next version explicitly. Versions must be plain `MAJOR.MINOR.PATCH`
and greater than the current version. Mismatched manifest/lock versions fail before anything is written.

`make version` performs the same bump and prepends a dated section to `CHANGELOG.md`, listing commit subjects
and short hashes since the highest earlier version tag reachable from HEAD. With no earlier version tag it
lists the full history. The same `BUMP` and `VERSION` arguments apply. Run either `bump` or `version` for a
release; running them one after the other bumps twice. Neither command creates a commit or tag.

For example:

```bash
make version VERSION=0.2.0
# Review CHANGELOG.md and the manifest changes, then commit them.
git add package.json package-lock.json CHANGELOG.md
git commit -m "Prepare release 0.2.0"
git tag 0.2.0
git push origin HEAD
git push origin 0.2.0
```

CI checks out full Git history and uses the matching CHANGELOG.md section as the GitHub Release description.
If a tag has no changelog section, the description is generated directly from the same Git commit range.
The version/changelog helper tests use temporary repositories and run as part of `make check` (`test-release`).

## Self-update delivery

`src/main/updates.ts` wraps electron-updater with a durable two-hour check cadence, manual installation and typed
IPC. The renderer subscribes to state/progress; it never receives an installer path or executes commands. Backend
and clock are injected in unit tests; tests never download or install an update. Preferences/last check live in
`userData/updates.json`. Only packaged deb/rpm (electron-builder's `resources/package-type`) and AppImage builds
are eligible. `autoInstallOnAppQuit`, prereleases and downgrades are disabled.

`electron-builder.yml` uses the public GitHub repository `redacid/ai-desktop-proxy` as the update provider with
plain version tags. Along with deb/rpm, the release workflow must upload the generated `latest-linux.yml`, whose
file entries include package checksums. The package embeds `app-update.yml` and its package type so electron-updater
selects the matching installer. Metadata and both packages are uploaded before the draft release is published.
An end-to-end update test requires two packaged versions published to the configured release feed; unit tests
and a development build cannot validate administrator authentication or distribution-specific installation.

## Bootstrap installer

The root `install.sh` is a standalone Bash script served directly from the maintained `feat/electron-app` branch.
It supports `curl | bash` without a checkout or npm build. It only runs package-manager commands as root; uv,
mitmproxy and headroom belong to the invoking desktop user. The release workflow uploads `SHA256SUMS` alongside
the packages and update metadata. The installer validates release names, URLs, package identity/version and SHA-256
before passing the package to apt-get/dnf/zypper. Node's fallback distribution is checked against nodejs.org's
SHASUMS256.txt; uv uses Astral's official installer. Tests replace commands in a temporary PATH and HOME; they
never run real sudo/package managers or network calls. `make test-install` is included in `make check`.
