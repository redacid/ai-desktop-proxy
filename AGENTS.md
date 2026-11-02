# Agent instructions

Electron tray app (TypeScript, React, electron-vite) that routes AI coding clients through a local mitmproxy and
a token compressor (headroom), and manages both as systemd user services. Linux only for now.

Read before changing code:
- [docs-dev/architecture.md](docs-dev/architecture.md): modules, request path, client state machine, **invariants**
- [docs-dev/development.md](docs-dev/development.md): commands, tests, how to add a client or compressor
- [docs/](docs/): user documentation published to GitHub Pages (install, interface, user guide, tools); keep it
  true and free of developer detail

## Commands

```bash
make install   # dependencies + Electron binary (works with npm ignore-scripts)
make check     # typecheck + vitest + addon tests: must pass before every commit
make build     # build into out/
make run       # build and start the app (needs a display)
```

## Rules

- **Documentation is part of the change.** Any feature, behaviour change, new setting, new file the app writes,
  or new make target updates `docs/` for users and `docs-dev/` for internals (and the README status) in the same commit. Documentation is in English.
- Keep the invariants in `docs-dev/architecture.md`. In short: never overwrite or remove config values the app did not
  write; never write a config that failed to parse; clients come off the proxy before the proxy stops; never
  enable a client while the proxy is not listening; never start a service on a port another process holds; never
  touch a headroom the app did not start; install nothing without a confirmation that names the command.
- Everything that crosses IPC is declared in `src/shared/ipc.ts`; the renderer has no Node access.
- Run commands with argument arrays (`src/main/proxy/exec.ts`), never through a shell.
- Tests must not touch the real home directory, systemd or network: use temp dirs and injected runners as the
  existing tests do. Add tests next to the code (`*.test.ts`).
- `legacy/` is the old shell version, kept for reference; do not extend it.
- Work on the `feat/electron-app` branch; do not open pull requests unless the repository owner asks.
- Commit messages: imperative subject under ~70 characters, body explaining why.

## Environment notes

- There may be no systemd user session (containers, CI). Unit tests do not need one; for end-to-end runs see
  "End-to-end without systemd" in `docs-dev/development.md`.
- Do not `pkill -f <pattern>` from a shell whose own command line contains the pattern; it kills that shell.
