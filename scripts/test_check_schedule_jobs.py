"""Contracts for the configured monitoring endpoint; no network access."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "schedule_monitor", Path(__file__).with_name("check-schedule-jobs.py")
)
MONITOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MONITOR)


class MonitoringEndpointTest(unittest.TestCase):
    def test_accepts_only_the_configured_origin_and_push_path(self):
        pattern = MONITOR.kuma_url_pattern("https://monitor.example.org")
        token = "a" * 32
        self.assertIsNotNone(pattern.fullmatch(f"https://monitor.example.org/api/push/{token}"))
        for url in [f"https://other.example.org/api/push/{token}",
                    f"https://monitor.example.org.evil.test/api/push/{token}",
                    f"https://user@monitor.example.org/api/push/{token}",
                    f"http://monitor.example.org/api/push/{token}",
                    f"https://monitor.example.org/api/push/{token}?query=1",
                    f"https://monitor.example.org/api/push/{token}#fragment",
                    "https://monitor.example.org/api/push/short"]:
            self.assertIsNone(pattern.fullmatch(url))

    def test_rejects_missing_or_non_origin_configuration(self):
        for origin in ["", "file:///tmp/monitor", "https://user:password@monitor.example.org",
                       "https://monitor.example.org/path", "https://monitor.example.org?query=1"]:
            with self.assertRaisesRegex(ValueError, "SCHEDULE_MONITOR_KUMA_ORIGIN"):
                MONITOR.kuma_url_pattern(origin)


if __name__ == "__main__":
    unittest.main()
