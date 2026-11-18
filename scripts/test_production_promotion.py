"""Focused read-only promotion configuration and refusal contracts."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
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
            "/apps/example-promote": {"id": 5705771, "client_id": "Iv1.example", "permissions": permissions},
            "/orgs/example-org/installations": {"total_count": 1, "installations": [{
                "id": 10, "app_id": 5705771, "app_slug": "example-promote", "client_id": "Iv1.example",
                "account": {"login": "example-org"}, "permissions": permissions,
                "suspended_at": None, "repository_selection": "selected",
            }]},
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
        self.assertEqual(len(rows), 15)
        self.assertEqual([row[1] for row in rows if not row[0]], ["installation repository selection"])
        self.assertIn("approved App key required", next(row[2] for row in rows if not row[0]))
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

    def test_ci_requires_a_main_merge_group_sha_to_have_landed(self):
        runs = f"{PREFIX}/actions/workflows/ci.yml/runs"
        compare = f"{PREFIX}/compare/{SHA}...{BASE}"
        for branch, merge_base, expected_error in [
            ("main", SHA, None),
            ("other", SHA, "no successful exact-SHA"),
            ("main", BASE, "selected SHA is not on main"),
        ]:
            with self.subTest(branch=branch, merge_base=merge_base):
                fixture = Fixture()
                fixture.routes[runs]["workflow_runs"][0].update(
                    event="merge_group", head_branch=f"gh-readonly-queue/{branch}/pr-137-{BASE}")
                fixture.routes[f"{PREFIX}/git/ref/heads/main"]["object"]["sha"] = BASE
                fixture.routes[compare] = {"status": "ahead", "merge_base_commit": {"sha": merge_base}}
                if expected_error:
                    with self.assertRaisesRegex(promotion.NotReady, expected_error):
                        fixture.check.ci()
                else:
                    self.assertEqual(fixture.check.ci(), f"CI / ci; run=22; sha={SHA}")
                    self.assertIn(compare, fixture.calls)
                queries = [parse_qs(urlsplit(path).query) for path in fixture.calls
                           if urlsplit(path).path == runs]
                self.assertEqual([query["event"] for query in queries], [["push"], ["merge_group"]])

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
        fixture.routes["/orgs/example-org/installations"]["installations"][0]["repository_selection"] = "all"
        with self.assertRaisesRegex(promotion.NotReady, "must use selected repositories"):
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
        self.assertEqual(len(rows), 15)
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
        ]
        for path, key, value, condition in cases:
            with self.subTest(path=path, key=key):
                fixture = Fixture()
                fixture.routes[path][key] = value
                rows = fixture.check.run()
                self.assertFalse(next(row[0] for row in rows if row[1] == condition), rows)

    def test_user_visible_repository_cannot_substitute_for_installation_token(self):
        fixture = Fixture()
        fixture.routes["/user/installations/10/repositories"] = {
            "total_count": 1, "repositories": [{"id": 23, "full_name": REPO}]}
        with self.assertRaisesRegex(promotion.NotReady, "approved App key required"):
            fixture.check.installation_repositories()
        self.assertFalse(any(path.startswith("/user/") for path in fixture.calls))

    def test_cli_proves_unfiltered_scope_and_keeps_credentials_out_of_output(self):
        # Run the real CLI, signer and gh subprocess boundary. Only GitHub's
        # network responses are synthetic, following the documented REST schema.
        key = subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"],
                             capture_output=True, check=True).stdout
        child = textwrap.dedent('''
            import base64, http.client, json, os, runpy, sys, time
            from unittest.mock import patch
            calls = []
            token = "test-installation-token-not-a-credential"
            class Response:
                def __init__(self, status, value):
                    self.status, self.value = status, value
                def read(self):
                    return json.dumps(self.value).encode()
            class Connection:
                def __init__(self, host, timeout):
                    assert host == "api.github.com"
                def request(self, method, path, body, headers):
                    calls.append(method)
                    if method == "POST":
                        assert path == "/app/installations/10/access_tokens"
                        # Only metadata read; neither repository filter is allowed.
                        assert json.loads(body) == {"permissions": {"metadata": "read"}}
                        jwt = headers["Authorization"].removeprefix("Bearer ")
                        header, claims, signature = jwt.split(".")
                        decode = lambda value: json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
                        assert decode(header)["alg"] == "RS256" and signature
                        assert decode(claims)["iss"] == "Iv1.example"
                        assert decode(claims)["iat"] <= time.time() < decode(claims)["exp"]
                        self.response = Response(201, {"token": token})
                    elif method == "GET":
                        assert path == "/installation/repositories?per_page=100"
                        assert headers["Authorization"] == "Bearer " + token
                        self.response = Response(int(scope_status), json.loads(scope_json))
                    else:
                        assert method == "DELETE" and path == "/installation/token"
                        assert headers["Authorization"] == "Bearer " + token
                        self.response = Response(204, None)
                def getresponse(self):
                    return self.response
                def close(self):
                    pass
            scope_status, scope_json, script, *args = sys.argv[1:]
            sys.argv = [script, *args]
            with patch.object(http.client, "HTTPSConnection", Connection):
                try:
                    runpy.run_path(script, run_name="__main__")
                finally:
                    assert calls == ["POST", "GET", "DELETE"]
        ''')
        cases = [
            (200, {"total_count": 1, "repositories": [{"id": 23, "full_name": REPO}]}, True),
            (200, {"total_count": 2, "repositories": [{"id": 23, "full_name": REPO},
                  {"id": 24, "full_name": "example-org/hidden"}]}, False),
            (200, {"total_count": 1, "repositories": [{"id": 24, "full_name": REPO}]}, False),
            (200, {"total_count": 1, "repositories": [{"id": 23, "full_name": "example-org/other"}]}, False),
            (200, {"total_count": 1, "repositories": []}, False),
            (403, {"message": "test-installation-token-not-a-credential"}, False),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "routes.json").write_text(json.dumps(Fixture().routes))
            gh = root / "gh"
            gh.write_text(f"#!{sys.executable}\n" + textwrap.dedent('''
                import json, os, sys
                from pathlib import Path
                from urllib.parse import urlsplit
                assert sys.argv[1:4] == ["api", "--method", "GET"]
                routes = json.loads(Path(__file__).with_name("routes.json").read_text())
                print(json.dumps(routes[urlsplit(sys.argv[4]).path]))
            '''))
            gh.chmod(0o700)
            command = [str(Path(promotion.__file__)),
                       "--repo", REPO, "--sha", SHA, "--app-slug", "example-promote",
                       "--workflow-sha", SHA, "--admission-sha", BASE, "--app-key-fd", "3"]
            for status, scope, passed in cases:
                with self.subTest(status=status, scope=scope):
                    # A pipe supplies the key, just as the operator's fd stream does.
                    result = subprocess.run(
                        ["/bin/bash", "-c", 'exec 3<&0; exec "$@"', "precheck", sys.executable,
                         "-c", child, str(status), json.dumps(scope), *command], input=key,
                        capture_output=True, env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}"},
                        timeout=15, check=False,
                    )
                    output = result.stdout + result.stderr
                    self.assertEqual(result.returncode, 0 if passed else 1, output.decode())
                    self.assertEqual(result.stderr, b"")
                    self.assertEqual(sum(line.startswith(b"PASS ") for line in result.stdout.splitlines()),
                                     15 if passed else 14)
                    self.assertEqual(sum(line.startswith(b"FAIL ") for line in result.stdout.splitlines()),
                                     0 if passed else 1)
                    self.assertNotIn(b"test-installation-token-not-a-credential", output)
                    self.assertNotIn(key, output)
                    self.assertNotIn(b"PRIVATE KEY", output)

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
