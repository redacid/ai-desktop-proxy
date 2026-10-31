"""mitmproxy addon for claude-desktop-proxy.

Sends decrypted api.anthropic.com requests to the compressor (headroom) while it
is healthy, and lets them go straight to the API when it is not, so Claude keeps
working without compression instead of failing with 502.

Options (set with --set):
  cdp_upstream        compressor base URL, e.g. http://127.0.0.1:6767
  cdp_health_path     health endpoint on the compressor (default /health)
  cdp_health_interval seconds between health checks (default 5)
"""
from __future__ import annotations

import logging
import threading
import urllib.request
from urllib.parse import urlsplit

API_HOST = "api.anthropic.com"
log = logging.getLogger(__name__)


def route(host: str, upstream: str, healthy: bool) -> tuple[str, str, int] | None:
    """(scheme, host, port) to send the request to, or None to leave it unchanged."""
    if host != API_HOST or not upstream or not healthy:
        return None
    u = urlsplit(upstream)
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    return u.scheme, u.hostname, u.port or (443 if u.scheme == "https" else 80)


# Never send the health check through HTTP(S)_PROXY from the service environment.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def probe(url: str, timeout: float = 2.0) -> bool:
    try:
        with _opener.open(url, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


class CompressorRoute:
    def __init__(self) -> None:
        self.healthy = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def load(self, loader) -> None:
        loader.add_option("cdp_upstream", str, "", "Compressor base URL")
        loader.add_option("cdp_health_path", str, "/health", "Compressor health path")
        loader.add_option("cdp_health_interval", int, 5, "Seconds between health checks")

    def running(self) -> None:
        from mitmproxy import ctx

        self._thread = threading.Thread(target=self._watch, args=(ctx.options,), daemon=True)
        self._thread.start()

    def done(self) -> None:
        self._stop.set()

    def _watch(self, options) -> None:
        # A background check keeps request handling free of network waits.
        while not self._stop.is_set():
            upstream = options.cdp_upstream.rstrip("/")
            healthy = bool(upstream) and probe(upstream + options.cdp_health_path)
            if healthy != self.healthy:
                log.warning("compressor %s is %s: routing %s", upstream or "(unset)",
                            "up" if healthy else "down", "through it" if healthy else "directly to the API")
            self.healthy = healthy
            self._stop.wait(max(1, options.cdp_health_interval))

    def requestheaders(self, flow) -> None:
        # requestheaders, not request: with stream_large_bodies the body is streamed to
        # the server chosen here, before the request hook would run.
        from mitmproxy import ctx

        target = route(flow.request.pretty_host, ctx.options.cdp_upstream, self.healthy)
        if target is None:
            return
        scheme, host, port = target
        # Keep the Host header as api.anthropic.com; the compressor forwards it upstream.
        flow.request.scheme, flow.request.host, flow.request.port = scheme, host, port
        flow.request.host_header = API_HOST


addons = [CompressorRoute()]
