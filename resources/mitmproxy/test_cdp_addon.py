import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cdp_addon import chatgpt_path, plan, route  # noqa: E402


class RouteTest(unittest.TestCase):
    def test_api_goes_to_healthy_compressor(self):
        self.assertEqual(route("api.anthropic.com", "http://127.0.0.1:6767", True), ("http", "127.0.0.1", 6767))

    def test_falls_back_when_compressor_is_down(self):
        self.assertIsNone(route("api.anthropic.com", "http://127.0.0.1:6767", False))

    def test_other_hosts_untouched(self):
        self.assertIsNone(route("github.com", "http://127.0.0.1:6767", True))

    def test_unset_or_bad_upstream(self):
        self.assertIsNone(route("api.anthropic.com", "", True))
        self.assertIsNone(route("api.anthropic.com", "ftp://x", True))

    def test_default_ports(self):
        self.assertEqual(route("api.anthropic.com", "https://h.example", True), ("https", "h.example", 443))


UP = "http://127.0.0.1:6767"


class PlanTest(unittest.TestCase):
    def test_codex_goes_to_healthy_compressor(self):
        self.assertEqual(plan("api.openai.com", "/v1/responses", True, True, UP, True),
                         ("http", "127.0.0.1", 6767, "/v1/responses"))

    def test_codex_with_api_key_falls_back_to_openai(self):
        self.assertIsNone(plan("api.openai.com", "/v1/responses", True, False, UP, False))

    def test_codex_with_chatgpt_login_falls_back_to_chatgpt(self):
        self.assertEqual(plan("api.openai.com", "/v1/responses?x=1", True, True, UP, False),
                         ("https", "chatgpt.com", 443, "/backend-api/codex/responses?x=1"))

    def test_openai_through_regular_listener_untouched(self):
        self.assertIsNone(plan("api.openai.com", "/v1/responses", False, False, UP, True))

    def test_anthropic_unchanged(self):
        self.assertEqual(plan("api.anthropic.com", "/v1/messages", False, False, UP, True),
                         ("http", "127.0.0.1", 6767, "/v1/messages"))
        self.assertIsNone(plan("api.anthropic.com", "/v1/messages", False, False, UP, False))

    def test_chatgpt_path(self):
        self.assertEqual(chatgpt_path("/v1/models"), "/backend-api/codex/models")
        self.assertEqual(chatgpt_path("/v1"), "/backend-api/codex")
        self.assertIsNone(chatgpt_path("/v10/x"))
        self.assertIsNone(chatgpt_path("/other"))


if __name__ == "__main__":
    unittest.main()
