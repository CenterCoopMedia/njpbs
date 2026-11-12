#!/usr/bin/env python3
"""Read-only #57 configuration precheck. Uses gh's existing authentication."""

import argparse
import json
from pathlib import Path
import re
import subprocess


class NotReady(Exception):
    pass


class ReadError(NotReady):
    def __init__(self, path, status=None):
        self.status = status
        super().__init__(f"GET {path} unavailable" + (f" (HTTP {status})" if status else ""))


def github_get(path):
    result = subprocess.run(
        ["gh", "api", "--method", "GET", path], capture_output=True, text=True,
        timeout=45, check=False,
    )
    if result.returncode:
        status = re.search(r"HTTP (\d{3})", result.stderr)
        raise ReadError(path, int(status[1]) if status else None)
    return json.loads(result.stdout)


def require(condition, message):
    if not condition:
        raise NotReady(message)


class Precheck:
    def __init__(self, repository, sha, app_slug, workflow_sha, admission_sha, request=github_get):
        require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]+", repository))
                and repository.split("/")[1] not in (".", ".."), "invalid --repo")
        require(bool(re.fullmatch(r"[a-f0-9]{40}", sha)), "invalid --sha")
        require(all(re.fullmatch(r"[a-f0-9]{40}", value) for value in (workflow_sha, admission_sha)),
                "full reviewed workflow and admission merge SHAs are required")
        require(bool(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", app_slug)), "invalid --app-slug")
        self.repository, self.sha, self.app_slug = repository, sha, app_slug
        self.required_sources = {"workflow": workflow_sha, "admission": admission_sha}
        self.owner = repository.split("/")[0]
        self.prefix = f"/repos/{repository}"
        self.request, self.cache, self.rows = request, {}, []
        root = Path(__file__).resolve().parents[1] / "docs/release"
        self.payloads = [json.loads((root / f"production-{kind}.ruleset.json").read_text())
                         for kind in ("checks", "updates")]

    def get(self, path):
        if path not in self.cache:
            try:
                self.cache[path] = self.request(path)
            except ReadError as error:
                self.cache[path] = error
            except (subprocess.TimeoutExpired, OSError, ValueError):
                # Never print subprocess output, authentication diagnostics or arbitrary JSON.
                self.cache[path] = ReadError(path)
        value = self.cache[path]
        if isinstance(value, ReadError):
            raise value
        return value

    def listing(self, path, key=None):
        items = []
        for page in range(1, 21):
            value = self.get(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
            batch = value[key] if key else value
            require(isinstance(batch, list), f"incomplete list: {path}")
            items.extend(batch)
            if key and "total_count" in value:
                total = value["total_count"]
                require(isinstance(total, int) and len(items) <= total, f"inconsistent list: {path}")
                if len(items) == total:
                    return items
                require(bool(batch), f"incomplete list: {path}")
            elif len(batch) < 100:
                return items
        raise NotReady(f"pagination limit: {path}")

    def row(self, name, check):
        try:
            detail = check()
            self.rows.append((True, name, detail))
        except (NotReady, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            detail = str(error) if isinstance(error, NotReady) else "incomplete API response"
            self.rows.append((False, name, detail))

    def main_source(self):
        main_sha = self.get(f"{self.prefix}/git/ref/heads/main")["object"]["sha"]
        data = self.get(f"{self.prefix}/compare/{self.sha}...{main_sha}")
        require(data["status"] in ("ahead", "identical") and
                data["merge_base_commit"]["sha"] == self.sha, "selected SHA is not on main")
        return f"selected={self.sha}; main={main_sha}"

    def ci(self):
        identity = self.get(self.prefix)
        path = f"{self.prefix}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&head_sha={self.sha}"
        for run in self.listing(path, "workflow_runs"):
            if not (run["event"] == "push" and run["head_branch"] == "main" and
                    run["head_sha"] == self.sha and run["status"] == "completed" and
                    run["conclusion"] == "success" and run["path"].split("@")[0] == ".github/workflows/ci.yml" and
                    all(run[key]["id"] == identity["id"] and
                        run[key]["full_name"].lower() == self.repository.lower()
                        for key in ("repository", "head_repository"))):
                continue
            jobs = self.listing(f"{self.prefix}/actions/runs/{run['id']}/jobs?filter=latest", "jobs")
            if any(job["name"] == "ci" and job["run_id"] == run["id"] and job["head_sha"] == self.sha and
                   job["status"] == "completed" and job["conclusion"] == "success" for job in jobs):
                return f"CI / ci; run={run['id']}; sha={self.sha}"
        raise NotReady(f"no successful exact-SHA main-push CI / ci for {self.sha}")

    def reviewed_sources(self):
        for name, sha in self.required_sources.items():
            value = self.get(f"{self.prefix}/compare/{sha}...{self.sha}")
            require(value["status"] in ("ahead", "identical") and value["merge_base_commit"]["sha"] == sha,
                    f"selected SHA does not include reviewed {name} merge {sha}")
        return "; ".join(f"{name}={sha}" for name, sha in self.required_sources.items())

    def app(self):
        return self.get(f"/apps/{self.app_slug}")

    def permissions(self, value):
        expected_id = self.payloads[1]["bypass_actors"][0]["actor_id"]
        require(value.get("app_id", value.get("id")) == expected_id, "App ID differs from runbook")
        require(value["permissions"] == {"contents": "write", "workflows": "write", "metadata": "read"},
                "expected exactly Contents write, Workflows write, Metadata read")
        return "exactly Contents write, Workflows write, Metadata read"

    def installation(self):
        matches = [item for item in self.listing(f"/orgs/{self.owner}/installations", "installations")
                   if item["app_id"] == self.app()["id"]]
        require(len(matches) == 1, "expected exactly one matching organization installation")
        return matches[0]

    def installation_permissions(self):
        install = self.installation()
        self.permissions(install)
        require(install["app_slug"] == self.app_slug and install["account"]["login"].lower() == self.owner.lower()
                and install["client_id"] == self.app()["client_id"] and install["suspended_at"] is None,
                "installation identity differs or installation is suspended")
        return f"installation={install['id']}; {self.permissions(install)}"

    def installation_repositories(self):
        install = self.installation()
        require(install["repository_selection"] == "selected", "installation must use selected repositories")
        repos = self.listing(f"/user/installations/{install['id']}/repositories", "repositories")
        require(len(repos) == 1 and repos[0]["full_name"].lower() == self.repository.lower(),
                "installation must select only the requested repository")
        return "selected repository only"

    def variable(self, scope, name, expected):
        value = self.get(f"{self.prefix}/{scope}/variables/{name}")
        require(value["name"] == name and bool(expected) and value["value"] == expected,
                f"{name} missing or differs from expected public value")
        return f"{name} matches expected public value"

    def environment_policy(self):
        policy = self.get(f"{self.prefix}/environments/production")["deployment_branch_policy"]
        require(policy == {"protected_branches": False, "custom_branch_policies": True},
                "expected protected_branches=false, custom_branch_policies=true")
        return "custom branch policies enabled; protected branch admission disabled"

    def branch_entries(self):
        entries = self.listing(f"{self.prefix}/environments/production/deployment-branch-policies", "branch_policies")
        require(len(entries) == 1 and entries[0]["name"] == "main" and entries[0]["type"] == "branch",
                "expected only branch main; no tag entries")
        return "only branch main; no tag entries"

    def ruleset(self, expected):
        rules = self.listing(f"{self.prefix}/rulesets?includes_parents=true")
        matches = [item for item in rules if item["name"] == expected["name"] and item["source_type"] == "Repository"]
        require(len(matches) == 1, "expected exactly one repository ruleset with this name")
        value = self.get(f"{self.prefix}/rulesets/{matches[0]['id']}")
        for key, wanted in expected.items():
            actual = value[key]
            if key == "rules":
                actual = sorted(actual, key=lambda rule: rule["type"])
                wanted = sorted(wanted, key=lambda rule: rule["type"])
            require(actual == wanted, f"ruleset {key} differs from documented payload")
        return f"id={value['id']}; exact documented payload"

    def secret(self, scope, present):
        entries = self.listing(f"{self.prefix}/{scope}", "secrets")
        matches = [item for item in entries if item["name"] == "CCM_PROMOTE_APP_PRIVATE_KEY"]
        require(bool(matches) == present, "expected key metadata " + ("present" if present else "absent"))
        return (f"key metadata present; updated_at={matches[0]['updated_at']}" if present else "no key supplier")

    def production(self):
        sha = self.get(f"{self.prefix}/git/ref/heads/production")["object"]["sha"]
        data = self.get(f"{self.prefix}/compare/{sha}...{self.sha}")
        require(data["status"] in ("ahead", "identical") and data["merge_base_commit"]["sha"] == sha,
                "production cannot fast-forward to selected SHA")
        return f"production={sha}; selected SHA is a fast-forward or identical"

    def run(self):
        self.row("main ancestry", self.main_source)
        self.row("reviewed workflow and admission", self.reviewed_sources)
        self.row("green main-push CI", self.ci)
        self.row("Actions variable", lambda: self.variable("actions", "CCM_PROMOTE_APP_SLUG", self.app_slug))
        self.row("App permissions", lambda: self.permissions(self.app()))
        self.row("installation permissions", self.installation_permissions)
        self.row("installation repository selection", self.installation_repositories)
        self.row("production environment policy", self.environment_policy)
        self.row("production branch/tag entries", self.branch_entries)
        self.row("environment App client ID", lambda: self.variable("environments/production", "CCM_PROMOTE_APP_CLIENT_ID", self.app()["client_id"]))
        for payload in self.payloads:
            self.row(payload["name"], lambda payload=payload: self.ruleset(payload))
        self.row("production key metadata", lambda: self.secret("environments/production/secrets", True))
        self.row("repository key supplier absent", lambda: self.secret("actions/secrets", False))
        self.row("organization key supplier absent", lambda: self.secret("actions/organization-secrets", False))
        self.row("production fast-forward baseline", self.production)
        return self.rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--sha", required=True, help="named full green main SHA")
    parser.add_argument("--app-slug", required=True, help="expected App slug from the runbook")
    parser.add_argument("--workflow-sha", required=True, help="reviewed promotion workflow merge SHA")
    parser.add_argument("--admission-sha", required=True, help="reviewed App-push admission merge SHA")
    args = parser.parse_args()
    try:
        rows = Precheck(args.repo, args.sha, args.app_slug, args.workflow_sha, args.admission_sha).run()
    except NotReady as error:
        parser.error(str(error))
    print(f"Read-only promotion precheck: {args.repo} @ {args.sha}")
    for passed, name, detail in rows:
        print(f"{'PASS' if passed else 'FAIL'} {name}: {detail}")
    print("Approval, key provenance, live promotion/deployment and refusal evidence remain operator steps in #57.")
    return int(any(not passed for passed, _, _ in rows))


if __name__ == "__main__":
    raise SystemExit(main())
