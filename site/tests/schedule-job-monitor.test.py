import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("schedule_monitor", Path(__file__).resolve().parents[2] / "scripts/check-schedule-jobs.py")
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)
now = monitor.timestamp("2026-10-02T19:00:00Z")
endpoint = "http://192.0.2.10:3001/api/push/" + "a" * 32


def run(created="2026-10-02T15:38:38Z", updated="2026-10-02T15:46:52Z", status="completed", conclusion="success"):
    return {"event": "schedule", "created_at": created, "updated_at": updated, "status": status, "conclusion": conclusion}


def bake_pr(created="2026-10-02T16:59:59Z"):
    return {"state": "open", "created_at": created,
            "base": {"ref": "main", "repo": {"full_name": "example-org/example-repo"}},
            "head": {"ref": "automation/schedule-bake", "repo": {"full_name": "example-org/example-repo"}}}


REPOSITORY_QUERY = "repos/example-org/example-repo"
WORKFLOW = REPOSITORY_QUERY + "/actions/workflows/schedule-bake.yml/runs?event=schedule&per_page=20"
PULL_REQUESTS = REPOSITORY_QUERY + "/pulls?state=open&head=example-org:automation/schedule-bake&base=main&per_page=100"


class ScheduleJobs(unittest.TestCase):
    def setUp(self):
        settings = patch.dict(os.environ, {"CANONICAL_GITHUB_REPOSITORY": "example-org/example-repo",
            "CANONICAL_GITHUB_REPOSITORY_ID": "123456", "SCHEDULE_MONITOR_KUMA_ORIGIN": "http://192.0.2.10:3001"})
        settings.start()
        self.addCleanup(settings.stop)
        pattern = patch.object(monitor, "KUMA_URL", monitor.kuma_url_pattern("http://192.0.2.10:3001"))
        pattern.start()
        self.addCleanup(pattern.stop)

    def test_missing_and_wrong_repository_identity_refuses_before_other_reads(self):
        for settings in [{"CANONICAL_GITHUB_REPOSITORY": ""}, {"CANONICAL_GITHUB_REPOSITORY_ID": ""}, {}]:
            with self.subTest(settings=settings), patch.dict(os.environ, settings):
                response = {"full_name": "wrong/repository", "id": 123456}
                with patch.object(monitor, "command", return_value=json.dumps(response)) as command:
                    self.assertEqual(monitor.observe(now)["bake"]["reason"], "bake_observation_unavailable")
                    self.assertLessEqual(command.call_count, 1)

    def test_transferred_repository_is_resolved_before_querying_schedule_prs(self):
        repository = "example-org/example-repo"
        pr = bake_pr()
        pr["base"]["repo"]["full_name"] = repository
        pr["head"]["repo"]["full_name"] = repository
        def read(args):
            target = args[-1]
            if target == REPOSITORY_QUERY:
                return json.dumps({"full_name": repository, "id": 123456})
            if target == "repos/example-org/example-repo/actions/workflows/schedule-bake.yml/runs?event=schedule&per_page=20":
                return json.dumps({"workflow_runs": [run()]})
            if target == "repos/example-org/example-repo/pulls?state=open&head=example-org:automation/schedule-bake&base=main&per_page=100":
                return json.dumps([pr])
            raise RuntimeError("unavailable boundary")
        with patch.object(monitor, "command", side_effect=read):
            self.assertEqual(monitor.observe(now)["bake"]["reason"], "bake_pr_pending")
        pr["head"]["repo"]["full_name"] = "fork/example-repo"
        with self.assertRaises(ValueError):
            monitor.assess_open_bake_prs([pr], now)

    def test_bake_current_and_known_jitter(self):
        self.assertTrue(monitor.assess_bake({"workflow_runs": [run()]}, now)["healthy"])
        old = run("2026-10-01T23:00:00Z", "2026-10-02T00:01:00Z")
        self.assertTrue(monitor.assess_bake({"workflow_runs": [old]}, now)["healthy"])

    def test_open_pr_is_unhealthy_before_and_after_two_hours(self):
        for created, reason in [("2026-10-02T18:50:00Z", "bake_pr_waiting"),
                                ("2026-10-02T17:00:00Z", "bake_pr_waiting"),
                                ("2026-10-02T16:59:59Z", "bake_pr_pending")]:
            with self.subTest(created=created):
                self.assertEqual(monitor.assess_bake({"workflow_runs": [run()]}, now, [bake_pr(created)]),
                                 {"healthy": False, "reason": reason})

    def test_merge_restores_green_and_pr_age_uses_creation_time(self):
        pr = {**bake_pr(), "updated_at": "2026-10-02T18:59:59Z"}
        self.assertEqual(monitor.assess_bake({"workflow_runs": [run()]}, now, [pr])["reason"], "bake_pr_pending")
        self.assertEqual(monitor.assess_bake({"workflow_runs": [run()]}, now, []),
                         {"healthy": True, "reason": "bake_current"})

    def test_open_pr_preserves_missing_failed_stalled_and_stale_states(self):
        cases = [([run("2026-10-01T21:00:00Z", "2026-10-01T21:30:00Z")], "bake_missing"),
                 ([run(conclusion="failure")], "bake_failed"),
                 ([run(), run("2026-10-02T17:59:59Z", "2026-10-02T18:00:00Z", "queued", None)], "bake_stalled"),
                 ([run("2026-10-02T18:50:00Z", "2026-10-02T18:50:00Z", "queued", None)], "bake_success_stale")]
        for runs, reason in cases:
            with self.subTest(reason=reason):
                self.assertEqual(monitor.assess_bake({"workflow_runs": runs}, now, [bake_pr()])["reason"], reason)

    def test_invalid_pr_observation_cannot_report_green(self):
        for pr in [{**bake_pr(), "state": "closed"}, {**bake_pr(), "created_at": "2026-10-02T19:06:00Z"},
                   {**bake_pr(), "head": {"ref": "automation/schedule-bake", "repo": {"full_name": "fork/njpbs-site"}}},
                   {**bake_pr(), "base": {"ref": "develop", "repo": {"full_name": "example-org/example-repo"}}}]:
            with self.subTest(pr=pr):
                with self.assertRaises(ValueError):
                    monitor.assess_bake({"workflow_runs": [run()]}, now, [pr])

    def test_observer_reads_open_prs_and_reports_query_failure_safely(self):
        def read(args):
            if args[-1] == REPOSITORY_QUERY: return json.dumps({"full_name": "example-org/example-repo", "id": 123456})
            if args[-1] == WORKFLOW: return json.dumps({"workflow_runs": [run()]})
            if args[-1] == PULL_REQUESTS: return json.dumps([bake_pr()])
            raise RuntimeError("refresh fixture unavailable")
        with patch.object(monitor, "command", side_effect=read):
            self.assertEqual(monitor.observe(now)["bake"], {"healthy": False, "reason": "bake_pr_pending"})
        def failed(args):
            if args[-1] == REPOSITORY_QUERY: return json.dumps({"full_name": "example-org/example-repo", "id": 123456})
            if args[-1] == WORKFLOW: return json.dumps({"workflow_runs": [run()]})
            raise RuntimeError(endpoint)
        with patch.object(monitor, "command", side_effect=failed):
            observation = monitor.observe(now)["bake"]
        self.assertEqual(observation, {"healthy": False, "reason": "bake_observation_unavailable"})
        self.assertNotIn(endpoint, json.dumps(observation))

    def test_bake_only_never_queries_retired_units_or_journal(self):
        for conclusion, reason in [("success", "bake_current"), ("failure", "bake_failed")]:
            def read(args):
                if args[-1] == REPOSITORY_QUERY:
                    return json.dumps({"id": 123456, "full_name": "example-org/example-repo"})
                if args[-1] == WORKFLOW:
                    return json.dumps({"workflow_runs": [run(conclusion=conclusion)]})
                if args[-1] == PULL_REQUESTS: return "[]"
                self.fail("Bake-only queried a retired unit or journal")
            with patch.object(monitor, "command", side_effect=read) as command:
                observation = monitor.observe(now, bake_only=True)
            self.assertEqual(command.call_count, 3)
            self.assertEqual(observation, {"bake": {"healthy": conclusion == "success", "reason": reason}})

    def test_bake_only_report_reads_and_reports_only_bake_credential(self):
        observe = monitor.observe
        def read(args):
            if args[-1] == REPOSITORY_QUERY:
                return json.dumps({"id": 123456, "full_name": "example-org/example-repo"})
            if args[-1] == WORKFLOW: return json.dumps({"workflow_runs": [run()]})
            if args[-1] == PULL_REQUESTS: return "[]"
            self.fail("Bake-only queried a retired unit or journal")
        with patch.object(monitor, "command", side_effect=read), \
             patch.object(monitor, "observe", side_effect=lambda _now, **options: observe(now, **options)), \
             patch.object(monitor, "read_push_url", return_value=endpoint) as credential, \
             patch.object(monitor, "report") as send, \
             patch.object(monitor.sys, "argv", ["check-schedule-jobs.py", "--bake-only", "--report"]), \
             patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(monitor.main(), 0)
        self.assertEqual(credential.call_args.args[1], "bake")
        credential.assert_called_once()
        send.assert_called_once_with(endpoint, {"healthy": True, "reason": "bake_current", "reported": True})
        self.assertEqual(set(json.loads(output.getvalue())["jobs"]), {"bake"})

    def test_bake_stale_or_empty_history(self):
        old = run("2026-10-01T21:00:00Z", "2026-10-01T22:59:59Z")
        current = run("2026-10-02T18:50:00Z", "2026-10-02T18:50:00Z", "queued", None)
        self.assertEqual(monitor.assess_bake({"workflow_runs": [current, old]}, now)["reason"], "bake_success_stale")
        self.assertFalse(monitor.assess_bake({"workflow_runs": []}, now)["healthy"])

    def test_missing_scheduled_run_is_separate_from_old_failure_or_success(self):
        for conclusion in ["success", "failure", "cancelled"]:
            with self.subTest(conclusion=conclusion):
                old = run("2026-10-01T21:00:00Z", "2026-10-01T21:30:00Z", conclusion=conclusion)
                self.assertEqual(monitor.assess_bake({"workflow_runs": [old]}, now),
                                 {"healthy": False, "reason": "bake_missing"})

    def test_missing_boundary_preserves_twenty_hour_scheduling_grace(self):
        old = run("2026-10-01T23:00:00Z", "2026-10-02T00:01:00Z")
        self.assertEqual(monitor.assess_bake({"workflow_runs": [old]}, now)["reason"], "bake_current")
        later = monitor.timestamp("2026-10-02T19:00:01Z")
        self.assertEqual(monitor.assess_bake({"workflow_runs": [old]}, later)["reason"], "bake_missing")

    def test_retry_cannot_hide_missing_cron_but_new_arrival_restores_assessment(self):
        retry = {**run("2026-10-01T21:00:00Z", "2026-10-02T18:50:00Z", "in_progress", None),
                 "run_started_at": "2026-10-02T18:50:00Z"}
        self.assertEqual(monitor.assess_bake({"workflow_runs": [retry]}, now)["reason"], "bake_missing")
        self.assertEqual(monitor.assess_bake({"workflow_runs": [run(), retry]}, now)["reason"], "bake_current")

    def test_failure_is_not_hidden_by_a_recent_success_or_new_running_job(self):
        failed = run("2026-10-02T17:00:00Z", "2026-10-02T17:10:00Z", conclusion="failure")
        current = run("2026-10-02T18:50:00Z", "2026-10-02T18:50:00Z", "in_progress", None)
        self.assertEqual(monitor.assess_bake({"workflow_runs": [current, run(), failed]}, now)["reason"], "bake_failed")

    def test_inflight_stall_and_normal_inflight(self):
        for status in ["queued", "in_progress", "pending", "waiting"]:
            stalled = run("2026-10-02T17:59:59Z", "2026-10-02T18:00:00Z", status, None)
            self.assertEqual(monitor.assess_bake({"workflow_runs": [run(), stalled]}, now)["reason"], "bake_stalled")
        current = run("2026-10-02T18:50:00Z", "2026-10-02T18:50:00Z", "in_progress", None)
        self.assertTrue(monitor.assess_bake({"workflow_runs": [current, run()]}, now)["healthy"])

    def test_running_retry_uses_current_attempt_start_and_rejects_future_start(self):
        retry = {**run("2026-10-02T17:00:00Z", "2026-10-02T18:50:00Z", "in_progress", None),
                 "run_started_at": "2026-10-02T18:50:00Z"}
        self.assertTrue(monitor.assess_bake({"workflow_runs": [retry, run()]}, now)["healthy"])
        retry["run_started_at"] = "2026-10-02T19:06:00Z"
        with self.assertRaises(ValueError): monitor.assess_bake({"workflow_runs": [retry, run()]}, now)

    def test_invalid_run_cannot_report_healthy(self):
        for bad in [{**run(), "event": "push"}, {**run(), "updated_at": "2026-10-03T00:00:00Z"},
                    {**run(), "updated_at": "2026-10-02T14:00:00Z"}, {**run(), "status": "surprise"}]:
            with self.assertRaises(ValueError):
                monitor.assess_bake({"workflow_runs": [bad]}, now)

    def test_credential_is_exact_and_not_a_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "schedule-bake-push-url"
            path.write_text(endpoint + "\n")
            self.assertEqual(monitor.read_push_url(directory, "bake"), endpoint)
            path.unlink()
            path.symlink_to(Path(directory) / "other")
            with self.assertRaises(ValueError): monitor.read_push_url(directory, "bake")

    def test_invalid_endpoints_are_rejected_before_network(self):
        for url in [endpoint + "?status=up", endpoint + "/fail", endpoint + "\n", endpoint.replace("192.0.2.10", "example.com"),
                    endpoint.replace("http:", "https:"), endpoint.replace("/api/", "/other/"), endpoint[:-1]]:
            with patch.object(monitor, "build_opener") as opener:
                with self.assertRaises(ValueError): monitor.report(url, monitor.result(True, "bake_current"))
                opener.assert_not_called()

    def test_push_uses_private_endpoint_no_proxy_or_redirect(self):
        with patch.object(monitor, "build_opener") as factory:
            response = factory.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'{"ok":true}'
            monitor.report(endpoint, monitor.result(False, "bake_failed"))
            handlers = factory.call_args.args
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsNone(handlers[1].redirect_request(None))
            factory.return_value.open.assert_called_once_with(endpoint + "?status=down&msg=bake_failed", timeout=10)

    def test_observation_errors_are_redacted_and_jobs_independent(self):
        with patch.object(monitor, "command", side_effect=RuntimeError(endpoint)):
            output = monitor.observe(now)
        self.assertEqual(output["bake"]["reason"], "bake_observation_unavailable")
        self.assertEqual(set(output), {"bake"})
        self.assertNotIn(endpoint, json.dumps(output))

    def test_reporting_failure_is_redacted(self):
        observations = {"bake": monitor.result(True, "bake_current")}
        with patch.object(monitor, "observe", return_value=observations), patch.object(monitor, "read_push_url", return_value=endpoint), \
             patch.object(monitor, "report", side_effect=RuntimeError(endpoint)) as send, \
             patch.object(monitor.sys, "argv", ["check-schedule-jobs.py", "--report"]), patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(monitor.main(), 1)
        send.assert_called_once()
        self.assertNotIn(endpoint, output.getvalue())
        self.assertFalse(json.loads(output.getvalue())["jobs"]["bake"]["reported"])

    def test_default_invocation_does_not_read_credentials_or_send(self):
        observations = {"bake": monitor.result(True, "bake_current")}
        with patch.object(monitor, "observe", return_value=observations), patch.object(monitor, "read_push_url") as read, \
             patch.object(monitor, "report") as send, patch.object(monitor.sys, "argv", ["check-schedule-jobs.py"]), \
             patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(monitor.main(), 0)
        read.assert_not_called()
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
