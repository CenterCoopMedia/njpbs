"""Focused read-only promotion configuration and refusal contracts."""
import copy
import importlib.util
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs

spec = importlib.util.spec_from_file_location("promotion", Path(__file__).with_name("check-production-promotion.py"))
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)

REPO = "example-org/example"
SHA = "a" * 40
BASE = "b" * 40
PREFIX = f"/repos/{REPO}"


class Fixture:
    def __init__(self):
        self.calls = []
        self.check = promotion.Precheck(REPO, SHA, "example-promote", SHA, BASE, self.request)
        permissions = {"contents": "write", "workflows": "write", "metadata": "read"}
        identity = {"id": 23, "full_name": REPO}
        self.routes = {
            PREFIX: identity,
            f"{PREFIX}/git/ref/heads/main": {"object": {"sha": SHA}},
            f"{PREFIX}/compare/{SHA}...{SHA}": {"status": "identical", "merge_base_commit": {"sha": SHA}},
            f"{PREFIX}/compare/{BASE}...{SHA}": {"status": "ahead", "merge_base_commit": {"sha": BASE}},
            f"{PREFIX}/git/ref/heads/production": {"object": {"sha": BASE}},
            f"{PREFIX}/actions/workflows/ci.yml/runs": {"total_count": 1, "workflow_runs": [{
                "id": 22, "event": "push", "head_branch": "main", "head_sha": SHA,
                "status": "completed", "conclusion": "success", "path": ".github/workflows/ci.yml",
                "repository": identity, "head_repository": identity,
            }]},
            f"{PREFIX}/actions/runs/22/jobs": {"total_count": 1, "jobs": [{
                "name": "ci", "run_id": 22, "head_sha": SHA, "status": "completed", "conclusion": "success",
            }]},
            f"{PREFIX}/actions/variables/CCM_PROMOTE_APP_SLUG": {"name": "CCM_PROMOTE_APP_SLUG", "value": "example-promote"},
            "/apps/example-promote": {"id": 5705771, "client_id": "Iv1.example", "permissions": permissions},
            "/orgs/example-org/installations": {"total_count": 1, "installations": [{
                "id": 10, "app_id": 5705771, "app_slug": "example-promote", "client_id": "Iv1.example",
                "account": {"login": "example-org"}, "permissions": permissions,
                "suspended_at": None, "repository_selection": "selected",
            }]},
            "/user/installations/10/repositories": {"total_count": 1, "repositories": [identity]},
            f"{PREFIX}/environments/production": {"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}},
            f"{PREFIX}/environments/production/deployment-branch-policies": {"total_count": 1, "branch_policies": [{"id": 1, "name": "main", "type": "branch"}]},
            f"{PREFIX}/environments/production/variables/CCM_PROMOTE_APP_CLIENT_ID": {"name": "CCM_PROMOTE_APP_CLIENT_ID", "value": "Iv1.example"},
            f"{PREFIX}/environments/production/secrets": {"total_count": 1, "secrets": [{"name": "CCM_PROMOTE_APP_PRIVATE_KEY", "updated_at": "2026-01-01T00:00:00Z"}]},
            f"{PREFIX}/actions/secrets": {"total_count": 0, "secrets": []},
            f"{PREFIX}/actions/organization-secrets": {"total_count": 0, "secrets": []},
            f"{PREFIX}/rulesets": [],
        }
        for index, payload in enumerate(self.check.payloads, 1):
            self.routes[f"{PREFIX}/rulesets"].append({"id": index, "name": payload["name"], "source_type": "Repository"})
            self.routes[f"{PREFIX}/rulesets/{index}"] = {"id": index, **copy.deepcopy(payload)}

    def request(self, path):
        self.calls.append(path)
        return copy.deepcopy(self.routes[urlsplit(path).path])


class PromotionTests(unittest.TestCase):
    def test_configuration_reads_all_conditions_and_refuses_unproven_scope(self):
        fixture = Fixture()
        rows = fixture.check.run()
        self.assertEqual(len(rows), 16)
        self.assertEqual([row[1] for row in rows if not row[0]], ["installation repository selection"])
        self.assertIn("cannot prove installation-wide isolation", next(row[2] for row in rows if not row[0]))
        self.assertEqual(len(fixture.calls), len(set(fixture.calls)))

    def test_ci_rejects_wrong_event_source_identity_and_job(self):
        mutations = [
            ("run", "event", "workflow_dispatch"), ("run", "head_branch", "other"),
            ("run", "head_sha", BASE), ("run", "path", ".github/workflows/other.yml"),
            ("run", "conclusion", "failure"), ("job", "name", "other"),
            ("job", "run_id", 33), ("job", "head_sha", BASE), ("job", "conclusion", "failure"),
            ("run", "head_repository", {"id": 24, "full_name": REPO}),
        ]
        for target, key, value in mutations:
            with self.subTest(target=target, key=key):
                fixture = Fixture()
                path, field = ((f"{PREFIX}/actions/workflows/ci.yml/runs", "workflow_runs") if target == "run"
                               else (f"{PREFIX}/actions/runs/22/jobs", "jobs"))
                fixture.routes[path][field][0][key] = value
                with self.assertRaises(promotion.NotReady):
                    fixture.check.ci()

    def test_rulesets_require_exact_scope_guards_and_bypasses(self):
        for key, value in [
            ("enforcement", "disabled"), ("bypass_actors", [{"actor_type": "RepositoryRole", "actor_id": 5}]),
            ("conditions", {"ref_name": {"include": ["~ALL"], "exclude": []}}),
            ("rules", [{"type": "deletion"}]),
        ]:
            with self.subTest(key=key):
                fixture = Fixture()
                fixture.routes[f"{PREFIX}/rulesets/1"][key] = value
                with self.assertRaises(promotion.NotReady):
                    fixture.check.ruleset(fixture.check.payloads[0])

    def test_tag_policy_and_alternate_secret_suppliers_refuse(self):
        fixture = Fixture()
        fixture.routes[f"{PREFIX}/environments/production/deployment-branch-policies"]["branch_policies"][0]["type"] = "tag"
        with self.assertRaises(promotion.NotReady):
            fixture.check.branch_entries()
        for scope in ("actions/secrets", "actions/organization-secrets"):
            with self.subTest(scope=scope):
                fixture = Fixture()
                fixture.routes[f"{PREFIX}/{scope}"] = {"total_count": 1, "secrets": [{"name": "CCM_PROMOTE_APP_PRIVATE_KEY"}]}
                with self.assertRaises(promotion.NotReady):
                    fixture.check.secret(scope, False)

    def test_missing_or_extra_permissions_and_wide_installation_refuse(self):
        for permissions in ({"contents": "write", "metadata": "read"},
                            {"contents": "write", "workflows": "write", "metadata": "read", "actions": "write"}):
            with self.subTest(permissions=permissions):
                fixture = Fixture()
                fixture.routes["/orgs/example-org/installations"]["installations"][0]["permissions"] = permissions
                with self.assertRaises(promotion.NotReady):
                    fixture.check.installation_permissions()
        fixture = Fixture()
        fixture.routes["/user/installations/10/repositories"] = {"total_count": 2, "repositories": [{"full_name": REPO}, {"full_name": "example-org/other"}]}
        with self.assertRaises(promotion.NotReady):
            fixture.check.installation_repositories()

    def test_unavailable_metadata_fails_and_continues_without_secret_output(self):
        fixture = Fixture()
        real_request = fixture.request

        def request(path):
            if "environments/production" in path:
                raise promotion.ReadError(path, 403)
            return real_request(path)

        fixture.check.request = request
        rows = fixture.check.run()
        self.assertEqual(len(rows), 16)
        self.assertFalse(next(row[0] for row in rows if row[1] == "production key metadata"))
        self.assertTrue(next(row[0] for row in rows if row[1] == "organization key supplier absent"))

    def test_incomplete_and_paginated_lists(self):
        fixture = Fixture()
        fixture.routes[f"{PREFIX}/actions/secrets"] = {"total_count": 1, "secrets": []}
        with self.assertRaises(promotion.NotReady):
            fixture.check.secret("actions/secrets", False)

    def test_source_and_environment_identity_refusals(self):
        cases = [
            (f"{PREFIX}/compare/{BASE}...{SHA}", "status", "diverged", "reviewed workflow and admission"),
            (f"{PREFIX}/compare/{BASE}...{SHA}", "status", "behind", "production fast-forward baseline"),
            (f"{PREFIX}/environments/production", "deployment_branch_policy", {"protected_branches": True, "custom_branch_policies": False}, "production environment policy"),
            (f"{PREFIX}/environments/production/variables/CCM_PROMOTE_APP_CLIENT_ID", "value", "wrong-client", "environment App client ID"),
            (f"{PREFIX}/actions/variables/CCM_PROMOTE_APP_SLUG", "value", "wrong-app", "Actions variable"),
        ]
        for path, key, value, condition in cases:
            with self.subTest(path=path, key=key):
                fixture = Fixture()
                fixture.routes[path][key] = value
                rows = fixture.check.run()
                self.assertFalse(next(row[0] for row in rows if row[1] == condition), rows)

    def test_single_user_visible_repository_cannot_certify_hidden_selection(self):
        # This API response is identical when another selected repository is
        # hidden from the authenticated user. It can never prove full scope.
        fixture = Fixture()
        with self.assertRaisesRegex(promotion.NotReady, "cannot prove installation-wide isolation"):
            fixture.check.installation_repositories()

    def test_runbook_requires_operator_target_for_every_activation_write(self):
        source = (Path(__file__).resolve().parents[1] / "docs/release/production-branch.md").read_text()
        blocks = re.findall(r"^[ \t]*```sh\n(.*?)\n[ \t]*```", source, re.S | re.M)
        writes = [line.strip() for block in blocks for line in block.splitlines()
                  if re.search(r"gh (?:variable set|secret set|workflow run|api --method (?:POST|PUT|DELETE))\b", line)]
        self.assertTrue(writes)
        for command in writes:
            with self.subTest(command=command):
                self.assertIn("$PROMOTION_REPOSITORY", command)
                self.assertNotIn("CenterCoopMedia/njpbs", command)
        setups = [block for block in blocks if "PROMOTION_REPOSITORY='" in block]
        self.assertEqual(len(setups), 1)
        setup = setups[0]
        result = subprocess.run(["/bin/bash"], input=setup, text=True, capture_output=True, env={"PATH": ""}, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")
        for block in blocks:
            result = subprocess.run(["/bin/bash", "-n"], input=block, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_late_page_secret_supplier_refuses(self):
        fixture = Fixture()
        fixture.check.request = lambda path: {"total_count": 101, "secrets":
            ([{"name": "OTHER"}] * 100 if parse_qs(urlsplit(path).query)["page"] == ["1"]
             else [{"name": "CCM_PROMOTE_APP_PRIVATE_KEY"}])}
        with self.assertRaises(promotion.NotReady):
            fixture.check.secret("actions/secrets", False)

    def test_transport_uses_get_only_and_hides_diagnostics(self):
        with patch.object(promotion.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "sensitive", "sensitive HTTP 403")) as run:
            with self.assertRaises(promotion.ReadError) as error:
                promotion.github_get("/apps/example-promote")
            self.assertNotIn("sensitive", str(error.exception))
            self.assertEqual(run.call_args.args[0], ["gh", "api", "--method", "GET", "/apps/example-promote"])


if __name__ == "__main__":
    unittest.main()
