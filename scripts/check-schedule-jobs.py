#!/usr/bin/env python3
"""Observe the GitHub schedule bake; --report sends its result to private Kuma."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

UTC = timezone.utc
BAKE_MAX_AGE = timedelta(hours=20)
BAKE_MAX_RUNNING = timedelta(hours=1)
BAKE_PR_MAX_AGE = timedelta(hours=2)
def kuma_url_pattern(origin):
    parsed = urlsplit(origin)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc
            or parsed.username or parsed.password or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment):
        raise ValueError("Configure SCHEDULE_MONITOR_KUMA_ORIGIN as an HTTP or HTTPS origin")
    return re.compile(re.escape(origin.rstrip("/")) + r"/api/push/[A-Za-z0-9]{32}")


KUMA_URL = (kuma_url_pattern(os.environ["SCHEDULE_MONITOR_KUMA_ORIGIN"])
            if os.environ.get("SCHEDULE_MONITOR_KUMA_ORIGIN") else re.compile(r"(?!)"))
def repository_identity():
    repository = os.environ.get("CANONICAL_GITHUB_REPOSITORY", "")
    repository_id = os.environ.get("CANONICAL_GITHUB_REPOSITORY_ID", "")
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
            or re.search(r"replace|placeholder", repository, re.I)
            or not re.fullmatch(r"[1-9][0-9]*", repository_id)):
        raise ValueError("Configure the canonical GitHub repository name and numeric ID")
    return repository, int(repository_id)


def command(args):
    # Provider output and errors can contain credentials. Only fixed reason codes
    # leave the observer; the captured output is used solely for parsing.
    result = subprocess.run(args, capture_output=True, text=True, timeout=20,
                            env={**os.environ, "LC_ALL": "C", "TZ": "UTC", "GH_PROMPT_DISABLED": "1"})
    if result.returncode or len(result.stdout) > 2_000_000:
        raise ValueError("observation unavailable")
    return result.stdout


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("invalid timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp has no timezone")
    return parsed.astimezone(UTC)


def result(healthy, reason):
    return {"healthy": healthy, "reason": reason}


def assess_open_bake_prs(prs, now, repository=None):
    if not isinstance(prs, (list, tuple)) or len(prs) > 100:
        raise ValueError("invalid PR history")
    expected_repository, _ = repository_identity()
    if repository is None:
        repository = expected_repository
    if repository != expected_repository:
        raise ValueError("invalid schedule repository")
    created_times = []
    for pr in prs:
        created = timestamp(pr["created_at"])
        if (pr["state"] != "open" or pr["base"]["ref"] != "main" or
                pr["head"]["ref"] != "automation/schedule-bake" or
                pr["base"]["repo"]["full_name"] != expected_repository or
                pr["head"]["repo"]["full_name"] != pr["base"]["repo"]["full_name"] or
                (repository is not None and pr["base"]["repo"]["full_name"] != repository) or
                created > now + timedelta(minutes=5)):
            raise ValueError("invalid schedule PR")
        created_times.append(created)
    if not created_times:
        return None
    reason = "bake_pr_pending" if now - min(created_times) > BAKE_PR_MAX_AGE else "bake_pr_waiting"
    return result(False, reason)


def assess_bake(payload, now, open_prs=(), repository=None):
    pending_pr = assess_open_bake_prs(open_prs, now, repository)
    runs = payload["workflow_runs"]
    if not isinstance(runs, list) or not 1 <= len(runs) <= 20:
        return result(False, "bake_history_unavailable")
    parsed = []
    for run in runs:
        created = timestamp(run["created_at"])
        updated = timestamp(run["updated_at"])
        if run["event"] != "schedule" or updated < created or updated > now + timedelta(minutes=5):
            raise ValueError("invalid run")
        if run["status"] not in {"completed", "queued", "in_progress", "pending", "waiting", "requested"}:
            raise ValueError("invalid run status")
        parsed.append((created, updated, run))
    parsed.sort(key=lambda row: row[0], reverse=True)
    created, _, latest = parsed[0]
    # Missing scheduled arrivals take precedence over an old failed attempt.
    # Completion or a rerun of that old attempt does not prove a new cron ran.
    if now - created > BAKE_MAX_AGE:
        return result(False, "bake_missing")
    completed = [run for _, _, run in parsed if run["status"] == "completed"]
    if completed and completed[0]["conclusion"] != "success":
        return result(False, "bake_failed")
    started = created
    if latest["status"] == "in_progress" and latest.get("run_started_at") is not None:
        started = timestamp(latest["run_started_at"])
        if started < created or started > now + timedelta(minutes=5):
            raise ValueError("invalid attempt time")
    if latest["status"] != "completed" and now - started > BAKE_MAX_RUNNING:
        return result(False, "bake_stalled")
    successes = [updated for _, updated, run in parsed
                 if run["status"] == "completed" and run["conclusion"] == "success"]
    if not successes or now - max(successes) > BAKE_MAX_AGE:
        return result(False, "bake_success_stale")
    return pending_pr or result(True, "bake_current")


def observe(now, bake_only=False):
    # Keep --bake-only compatible with the installed monitor; all checks are bake-only.
    observations = {}
    try:
        expected_repository, expected_id = repository_identity()
        metadata = json.loads(command(["/usr/bin/gh", "api", f"repos/{expected_repository}"]))
        repository = metadata["full_name"]
        if repository != expected_repository or metadata["id"] != expected_id:
            raise ValueError("invalid schedule repository")
        workflow = f"repos/{repository}/actions/workflows/schedule-bake.yml/runs?event=schedule&per_page=20"
        pulls = (f"repos/{repository}/pulls?state=open&head={repository.split('/')[0]}:"
                 "automation/schedule-bake&base=main&per_page=100")
        runs = json.loads(command(["/usr/bin/gh", "api", workflow]))
        prs = json.loads(command(["/usr/bin/gh", "api", pulls]))
        observations["bake"] = assess_bake(runs, now, prs, repository)
    except Exception:
        observations["bake"] = result(False, "bake_observation_unavailable")
    return observations


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


def read_push_url(credentials_directory, name):
    if not os.environ.get("SCHEDULE_MONITOR_KUMA_ORIGIN"):
        raise ValueError("Configure SCHEDULE_MONITOR_KUMA_ORIGIN before reporting")
    directory = Path(credentials_directory)
    path = directory / f"schedule-{name}-push-url"
    if not directory.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("invalid credential")
    with path.open("rb") as handle:
        value = handle.read(513).decode("ascii").removesuffix("\n")
    if not KUMA_URL.fullmatch(value):
        raise ValueError("invalid credential")
    return value


def report(url, observation):
    if not KUMA_URL.fullmatch(url):
        raise ValueError("invalid endpoint")
    query = urlencode({"status": "up" if observation["healthy"] else "down", "msg": observation["reason"]})
    opener = build_opener(ProxyHandler({}), NoRedirect())
    with opener.open(f"{url}?{query}", timeout=10) as response:
        body = response.read(4097)
        if response.status != 200 or len(body) > 4096 or json.loads(body).get("ok") is not True:
            raise ValueError("report refused")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="Send results using systemd credentials")
    parser.add_argument("--bake-only", action="store_true", help="Observe only GitHub bake for the scheduled build")
    args = parser.parse_args()
    now = datetime.now(UTC)
    observations = observe(now, bake_only=args.bake_only)
    failed = any(not value["healthy"] for value in observations.values())
    if args.report:
        urls = {}
        for name, observation in observations.items():
            observation["reported"] = False
            try:
                urls[name] = read_push_url(os.environ.get("CREDENTIALS_DIRECTORY", ""), name)
            except Exception:
                failed = True
        if len(urls) != len(set(urls.values())):
            # The second job must never overwrite the first job's failed state.
            urls = {}
            failed = True
        for name, url in urls.items():
            observation = observations[name]
            try:
                report(url, observation)
                observation["reported"] = True
            except Exception:
                # HTTP and file exceptions can include the complete push token.
                observation["reported"] = False
                failed = True
    print(json.dumps({"checkedAt": now.isoformat(), "jobs": observations}))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
