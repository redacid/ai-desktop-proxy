"""mitmproxy addon for ai-desktop-proxy.

Sends decrypted api.anthropic.com requests to the compressor (headroom) while it
is healthy, and lets them go straight to the API when it is not, so Claude keeps
working without compression instead of failing with 502.

Codex cannot use an HTTPS proxy, so it talks to a second, reverse-mode listener
whose upstream is api.openai.com. Those requests go to the compressor too; when it
is down they go to api.openai.com, or for a ChatGPT login (a ChatGPT-Account-Id
header) to chatgpt.com/backend-api/codex, where Codex would send them itself.

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
OPENAI_HOST = "api.openai.com"
CHATGPT_HOST = "chatgpt.com"
CODEX_PREFIX = "/backend-api/codex"
log = logging.getLogger(__name__)


def route(host: str, upstream: str, healthy: bool) -> tuple[str, str, int] | None:
    """(scheme, host, port) to send the request to, or None to leave it unchanged."""
    if host not in (API_HOST, OPENAI_HOST) or not upstream or not healthy:
        return None
    u = urlsplit(upstream)
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    return u.scheme, u.hostname, u.port or (443 if u.scheme == "https" else 80)


def chatgpt_path(path: str) -> str | None:
    """chatgpt.com path for a Codex request made against our /v1 base URL, or None."""
    for prefix in ("/v1/", "/v1?"):
        if path.startswith(prefix):
            return CODEX_PREFIX + path[3:]
    return CODEX_PREFIX if path == "/v1" else None


def plan(host: str, path: str, reverse: bool, chatgpt: bool, upstream: str,
         healthy: bool) -> tuple[str, str, int, str] | None:
    """(scheme, host, port, path) to send a request to, or None to leave it unchanged.

    OpenAI requests are ours only on the reverse listener; a Claude client that
    CONNECTs to api.openai.com through the regular one is left alone.
    """
    if host == OPENAI_HOST and not reverse:
        return None
    target = route(host, upstream, healthy)
    if target is not None:
        return (*target, path)
    if host == OPENAI_HOST and chatgpt:
        codex_path = chatgpt_path(path)
        if codex_path is not None:
            return "https", CHATGPT_HOST, 443, codex_path
    return None


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

        reverse = flow.client_conn.proxy_mode.type_name == "reverse"
        # On the reverse listener the destination is the mode's upstream; pretty_host
        # would be whatever Host the client sent (127.0.0.1:<port>).
        api_host = flow.request.host if reverse else flow.request.pretty_host
        target = plan(api_host, flow.request.path, reverse, "chatgpt-account-id" in flow.request.headers,
                      ctx.options.cdp_upstream, self.healthy)
        if target is None:
            return
        scheme, host, port, path = target
        flow.request.scheme, flow.request.host, flow.request.port = scheme, host, port
        flow.request.path = path
        # Keep the API's Host header; the compressor forwards it upstream.
        flow.request.host_header = CHATGPT_HOST if host == CHATGPT_HOST else api_host


addons = [CompressorRoute()]
