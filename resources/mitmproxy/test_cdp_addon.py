import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cdp_addon import route  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
