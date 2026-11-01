# Project plan

## RTK and Ponytail integration

Implemented: independent presence checks; per-client official Ponytail plugin installation; verified,
app-managed RTK installation and explicit native hook connection; six-hour durable release checks for
headroom, RTK and Ponytail; approval before all installs, updates and hook configuration. See the user guide.

Deferred: RTK savings/recall UI, richer connection-state inspection, Ponytail mode controls/Board integration,
and controlled comparisons with headroom. Keep savings from different stages separate; do not add their
percentages or estimated dollar amounts. RTK's API-proxy daemon is not enabled by this integration.

## Headroom integration

Deferred backlog from the integration review on 2026-10-31. Check endpoint and flag support against the installed runtime before implementation; package metadata currently reports 0.40.0, while integration comments refer to 0.42.

### First stage: visibility and compatibility

- Detect supported endpoints and flags, show the runtime version and effective settings, and gracefully handle unavailable features. Keep externally managed headroom read-only.
- Verify that the "disable ML" setting fully disables Kompress, including the installed CLI's `--disable-kompress-fallback` behavior.
- Add diagnostics from `/stats`: failed requests, rate limits attributed to headroom or the upstream provider, request latency, time to first byte, and compression overhead.
- Show provider quotas and reset times from `/quota` and `/subscription-window` when available. Distinguish unavailable, stale, and current data; subscription dollar estimates are not actual billing savings.
- Extend savings views with model and project breakdowns, day/week/month periods, and CSV export from `/stats-history`.
- Show new-input savings alongside whole-context savings, preserving headroom's matching numerator and denominator and its handling of missing provider usage data.

### Second stage: inspection and tuning

- Add a CCR inspector using `/v1/retrieve/stats` and `/v1/retrieve/{hash}`: store statistics, recent retrievals, and on-demand original content, including expired or missing entries.
- Expose savings profiles (`coding`, `balanced`, `agent-90`, `general`) and relevant environment settings: protection of user messages, recent turns and short shell outputs, plus per-provider Kompress overrides. Make profile, environment and explicit flag precedence clear.
- Compare settings on a selected recorded request through `POST /v1/compress`, showing before/after content, token counts and compression time without requesting a provider completion. Verify supported modes and retrieval behavior; compression ratios alone do not establish answer quality.

### Later: persistent memory and learning

- Evaluate `--memory` and `--learn` only after establishing reliable project identity and isolation for traffic through the shared service.
- Account for Anthropic cache-mode restrictions on automatic memory injection, document storage locations and lifecycle, and keep activation explicit.

### Implementation requirements

- Preserve the invariants in [architecture.md](architecture.md), declare IPC additions in `src/shared/ipc.ts`, and keep renderer access mediated by the main process.
- Add tests with fixtures, temporary directories and injected dependencies; do not use the real home directory, systemd or network in tests.
- Update the user guide, architecture/development documentation as applicable, and README status with each implementation change.

### References

- [Headroom proxy and configuration](https://docs.headroomlabs.ai/docs/proxy)
- [Metrics and monitoring](https://docs.headroomlabs.ai/docs/metrics)
- [Persistent memory](https://docs.headroomlabs.ai/docs/memory)
