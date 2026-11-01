#!/usr/bin/env bash
# Route Claude Code Desktop's API traffic through a local headroom proxy:
#   claude --HTTPS_PROXY--> mitmdump (decrypts api.anthropic.com only) --> headroom --> api.anthropic.com
# usage: cdp.sh install | uninstall | status | check
set -euo pipefail

PORT="${CDP_PORT:-8877}"
HEADROOM_URL="${CDP_HEADROOM_URL:-http://127.0.0.1:6767}"
SETTINGS="${CDP_SETTINGS:-$HOME/.claude/settings.json}"
UNIT=claude-desktop-proxy.service
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
MITMDUMP="$HOME/.local/bin/mitmdump"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }
settings_env() { python3 "$HERE/settings_env.py" "$1" "$SETTINGS" "http://127.0.0.1:$PORT" "$CA"; }

check() {
  local out
  out="$(curl -s -m 10 -x "http://127.0.0.1:$PORT" --cacert "$CA" https://api.anthropic.com/health)" \
    || die "proxy on :$PORT did not answer"
  [[ $out == *headroom-proxy* ]] || die "api.anthropic.com did not reach headroom: ${out:0:200}"
  curl -s -m 10 -o /dev/null -x "http://127.0.0.1:$PORT" https://github.com \
    || die "passthrough for other hosts is broken"
  echo "ok: api.anthropic.com -> headroom, other hosts tunneled"
}

install() {
  command -v uv >/dev/null || die "uv is required (https://docs.astral.sh/uv/)"
  curl -sf -m 5 "$HEADROOM_URL/health" >/dev/null || die "headroom is not answering at $HEADROOM_URL"
  [[ -x $MITMDUMP ]] || uv tool install mitmproxy

  if ! systemctl --user is-active -q "$UNIT" && ss -ltn "sport = :$PORT" | grep -q LISTEN; then
    die "port $PORT is taken by another process; stop it or set CDP_PORT"
  fi

  mkdir -p "$(dirname "$UNIT_FILE")"
  # [.] instead of \. and $$ instead of $: systemd unescapes backslashes and expands $ in ExecStart.
  # stream_large_bodies=1 forwards SSE replies as they arrive instead of buffering them.
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=Claude Desktop -> headroom proxy (mitmdump)
After=network-online.target

[Service]
ExecStart=$MITMDUMP --listen-host 127.0.0.1 --listen-port $PORT --allow-hosts '^api[.]anthropic[.]com:443$$' --map-remote '|https://api[.]anthropic[.]com|$HEADROOM_URL' --set stream_large_bodies=1 --set flow_detail=1
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null
  systemctl --user restart "$UNIT"

  for _ in $(seq 20); do [[ -f $CA ]] && ss -ltn "sport = :$PORT" | grep -q LISTEN && break; sleep 0.5; done
  check
  # Settings last: Claude is pointed at the proxy only once the proxy is known to work.
  settings_env add
  echo "installed. Open a NEW Desktop session to use it."
}

uninstall() {
  # Settings first, so Claude never points at a proxy that is already gone.
  settings_env remove
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "uninstalled. mitmproxy and ~/.mitmproxy are left in place (uv tool uninstall mitmproxy)."
}

status() {
  systemctl --user --no-pager status "$UNIT" | head -5 || true
  grep -E '"(HTTPS_PROXY|NODE_EXTRA_CA_CERTS|NO_PROXY)"' "$SETTINGS" || echo "settings: no proxy env"
  curl -s -m 5 "$HEADROOM_URL/stats-history" | python3 -c \
    'import json,sys; l=json.load(sys.stdin)["lifetime"]; print(f"headroom: {l[\"requests\"]} requests, {l[\"tokens_saved\"]} tokens saved")' \
    || echo "headroom: not answering"
}

case "${1:-}" in
  install | uninstall | status | check) "$1" ;;
  *) echo "usage: $0 install | uninstall | status | check" >&2; exit 2 ;;
esac
