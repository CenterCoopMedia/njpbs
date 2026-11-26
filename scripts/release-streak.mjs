#!/usr/bin/env node
// Counts the production releases in a row that meet the release goal, read
// only from GitHub. Exit 0 when the count reaches --need.
//
//   node scripts/release-streak.mjs --need 4 --repo CenterCoopMedia/njpbs --tool-repo jamditis/jawn-ops --since 2026-11-01 [--json]
//
// --since is where reading starts; give a date before the first release you
// mean to count.
//
// Auth: GH_TOKEN or GITHUB_TOKEN; it must read jamditis/jawn-ops (condition 6).
//
// The record that `jawn-ops njpbs release run` writes, one per command:
// - A GitHub deployment on CenterCoopMedia/njpbs. environment release-production
//   or release-development, ref = the full source commit, task "release",
//   payload { schema: 1, source, release_id, tool, target, live }; live is the
//   commit njpbs.org served when the production command started.
// - Status in_progress at the start. At the end one status success or failure
//   whose description starts "failed=<n> seconds=<s> refused=<s>" and may name
//   its production CMS run, " cms=<run id>". A record with no
//   end status (a failed record write, a stopped host) does not count.
// - release-drift.yml names its runs "Release drift production [<id>] <source>"
//   (the check before the first write) and "Release drift production after
//   [<id>] <source>" (after the last), each maybe followed by " <dispatch
//   nonce>"; id = payload.release_id, source = the full commit.
//
// A release counts when all nine conditions of the release reliability plan hold
// (9 as changed Nov. 26: any night, no days-behind limit):
//  1. One release-production record for the commit; it ended success, failed=0.
//  2. A drift run with its ID ended green before the production CMS run started.
//  3. One production cms-deploy.yml run inside the record: attempt 1, success.
//  4. A later drift run with its ID ended green after the CMS run.
//  5. The live site named the commit: read by that drift run (4).
//  6. The tool commit is on jawn-ops master.
//  7. The commit's first release-development record ended success, failed=0.
//  8. Consecutive: a release that does not count ends the streak, and production
//     CMS runs with no record count as one release that does not count.
//  9. The release brings new commits: its source is ahead of payload.live.

export function parseEnd(description) {
  const m = /^failed=(\d+) seconds=(\d+(?:\.\d+)?) refused=(\d+(?:\.\d+)?)/.exec(description ?? "");
  const cms = /(?:^| )cms=(\d+)(?: |$)/.exec(description ?? "");
  return m ? { failed: Number(m[1]), seconds: Number(m[2]), refused: Number(m[3]), cms: cms ? Number(cms[1]) : null } : null;
}

const ended = (s) => s.state === "success" || s.state === "failure" || s.state === "error";
const runId = (url) => Number(/\/actions\/runs\/(\d+)/.exec(url ?? "")?.[1] ?? 0);
const short = (sha) => (sha ?? "").slice(0, 8);
const easternDate = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// GitHub lists newest first; with since, paging stops at the first older item.
async function list(get, path, key, since) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await get(`${path}${sep}per_page=100&page=${page}`);
    const items = key ? body?.[key] ?? [] : body ?? [];
    all.push(...items);
    if (items.length < 100 || (since && items.at(-1).created_at < since)) return since ? all.filter((i) => i.created_at >= since) : all;
  }
  throw new Error(`more than 1000 items at ${path}; pass a later --since`);
}

async function records(get, repo, environment, since) {
  const deployments = await list(get, `repos/${repo}/deployments?environment=${environment}`, null, since);
  return Promise.all(deployments.map(async (d) => {
    const statuses = await get(`repos/${repo}/deployments/${d.id}/statuses?per_page=100`);
    const end = statuses.find(ended);
    return { id: d.id, sha: d.sha, start: d.created_at, payload: d.payload ?? {}, end: end ? { state: end.state, at: end.created_at, ...parseEnd(end.description) } : null };
  }));
}

// The workflows that write production. A run of any of them that used the
// production environment is a production deploy; a release makes exactly one,
// of cms-deploy.yml. The other production-environment workflows only read.
const PRODUCTION_WRITERS = ["cms-deploy.yml", "cms-staging-deploy.yml", "promote.yml"];

// Production deploy runs: writer runs whose job used the production
// environment. GitHub links each environment deployment to its job.
async function productionCMSRuns(get, repo, since) {
  const runs = (await Promise.all(PRODUCTION_WRITERS.map(async (workflow) =>
    (await list(get, `repos/${repo}/actions/workflows/${workflow}/runs?created=%3E%3D${since.slice(0, 10)}`, "workflow_runs"))
      .map((r) => ({ ...r, workflow }))))).flat();
  const deployments = await list(get, `repos/${repo}/deployments?environment=production`, null, since);
  const production = new Map();
  for (const d of deployments) {
    const statuses = await get(`repos/${repo}/deployments/${d.id}/statuses?per_page=100`);
    const id = runId(statuses.at(-1)?.target_url);
    if (id) production.set(id, { sha: d.sha, at: d.created_at });
  }
  // A run GitHub has not finished may still get a production deployment.
  const pending = runs.filter((r) => !production.has(r.id) && !r.conclusion).map((r) => r.id);
  return [runs.filter((r) => production.has(r.id))
    // A run is placed when its production deployment began, not when it was
    // dispatched: an approval wait or a rerun can move that later.
    .map((r) => ({ id: r.id, workflow: r.workflow, created: production.get(r.id).at, updated: r.updated_at, conclusion: r.conclusion, attempt: r.run_attempt, sha: production.get(r.id).sha }))
    .sort((a, b) => a.created.localeCompare(b.created)), pending];
}

async function driftRuns(get, repo, since) {
  try {
    return await list(get, `repos/${repo}/actions/workflows/release-drift.yml/runs?created=%3E%3D${since.slice(0, 10)}`, "workflow_runs");
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function onMaster(get, toolRepo, tool) {
  if (!/^[0-9a-f]{40}$/.test(tool ?? "")) return false;
  const compare = await get(`repos/${toolRepo}/compare/master...${tool}`);
  return compare.status === "behind" || compare.status === "identical";
}

// The source contains the live commit and more: GitHub says "ahead", not
// "diverged", "behind" or "identical".
async function ahead(get, repo, live, source) {
  const compare = await get(`repos/${repo}/compare/${live}...${source}`);
  return compare.status === "ahead" && compare.ahead_by > 0;
}

// A drift run counts only when its production job, "check", ran and
// succeeded; a run whose check job was skipped can still end "success".
async function ranGreen(get, repo, run) {
  if (run.conclusion !== "success") return false;
  const { jobs = [] } = await get(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
  return jobs.some((j) => j.name === "check" && j.conclusion === "success");
}

async function judge(get, release, ctx) {
  const why = [];
  const { record, cms } = release;
  if (!record) {
    why.push(`no release-production record (${cms.length} production deploy run${cms.length === 1 ? "" : "s"}: ${cms.map((r) => `${r.workflow === "cms-deploy.yml" ? "" : r.workflow + " "}${r.id} ${r.conclusion}`).join(", ")})`);
    return why;
  }
  // 1: every production record of the commit, whatever its age.
  const same = await records(get, ctx.repo, `release-production&sha=${record.sha}`, null);
  if (same.length > 1) why.push(`${same.length} release-production records for the commit`);
  if (!record.end) why.push("record has no end status");
  else if (record.end.state !== "success" || record.end.failed !== 0) why.push(`record ended ${record.end.state}${record.end.failed == null ? "" : `, failed=${record.end.failed}`}`);
  // 3. A record whose end names its CMS run ("cms=<id>") needs that run.
  // Records without it use the window rule alone (coordinator ruling, Nov. 26,
  // 2026, ~9:37 AM ET): delete this fallback once every counted record carries cms=.
  if (cms.length !== 1) why.push(`${cms.length} production deploy runs inside the record, not 1`);
  else if (cms[0].workflow !== "cms-deploy.yml") why.push(`the production deploy inside the record is ${cms[0].workflow} run ${cms[0].id}`);
  else if (record.end?.cms && cms[0].id !== record.end.cms) why.push(`the record names CMS run ${record.end.cms}, not ${cms[0].id}`);
  const run = cms[0];
  if (run && (run.conclusion !== "success" || run.attempt !== 1)) why.push(`CMS run ${run.id} ${run.conclusion}, attempt ${run.attempt}`);
  // 2 and 4
  const id = record.payload.release_id;
  // release-drift.yml may add " <dispatch nonce>" after the ID.
  // The name carries the release ID and the source the check read.
  const drift = (name) => {
    const title = `${name} [${id}] ${record.sha}`;
    return id ? ctx.drift.filter((d) => d.display_title === title || d.display_title?.startsWith(`${title} `)) : [];
  };
  const green = async (runs, ok) => {
    for (const d of runs) if (run && ok(d) && (await ranGreen(get, ctx.repo, d))) return true;
    return false;
  };
  // Both runs fall inside the record: only that command dispatches with its
  // random ID while the record is open.
  const within = (d) => record.end && d.created_at >= record.start && d.updated_at <= record.end.at;
  if (!(await green(drift("Release drift production"), (d) => within(d) && d.updated_at <= run.created))) why.push("no green drift check before the CMS run");
  if (!(await green(drift("Release drift production after"), (d) => within(d) && d.created_at >= run.updated))) why.push("no green drift check after the release (conditions 4 and 5)");
  // 6
  if (!(await onMaster(get, ctx.toolRepo, record.payload.tool))) why.push(`tool ${short(record.payload.tool) || "unnamed"} is not on jawn-ops master`);
  // 7: every development record of the commit, whatever its age.
  const development = await records(get, ctx.repo, `release-development&sha=${record.sha}`, null);
  const dev = development.sort((a, b) => a.start.localeCompare(b.start))[0];
  if (!dev || dev.start > record.start) why.push("no earlier release-development record");
  else if (dev.end?.state !== "success" || dev.end.failed !== 0) why.push("first release-development record did not succeed");
  else if (dev.end.at >= record.start) why.push("the development release ended after the production release started");
  // 9
  const live = record.payload.live;
  if (!/^[0-9a-f]{40}$/.test(live ?? "")) why.push("the record does not name the commit live at its start");
  else if (!(await ahead(get, ctx.repo, live, record.sha))) why.push("the commit is not ahead of the live commit");
  return why;
}

export async function releaseStreak(get, { need, since, repo, toolRepo }) {
  const [production, [cmsRuns, pending], drift] = await Promise.all([
    records(get, repo, "release-production", since), productionCMSRuns(get, repo, since), driftRuns(get, repo, since),
  ]);
  // Each record is one release; production CMS runs outside every ended record
  // form releases without a record, one per stretch between records. A record
  // that never ended takes no run: nothing ties a later run to it.
  const inside = (run, r) => Boolean(r.end) && run.created >= r.start && run.created <= r.end.at;
  const events = [
    ...production.map((r) => ({ at: r.start, record: r, cms: cmsRuns.filter((run) => inside(run, r)) })),
  ];
  let loose = null;
  for (const run of cmsRuns) {
    if (production.some((r) => inside(run, r))) { loose = null; continue; }
    const recordBetween = loose && production.some((r) => r.start > loose.cms.at(-1).created && r.start < run.created);
    // Runs 12 hours apart are separate attempts. This only names them: any
    // stretch without a record already ends the streak.
    const apart = loose && Date.parse(run.created) - Date.parse(loose.cms.at(-1).created) > 12 * 3600e3;
    if (!loose || recordBetween || apart) events.push(loose = { at: run.created, record: null, cms: [] });
    loose.cms.push(run);
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const ctx = { production, drift, repo, toolRepo };
  const releases = [];
  let count = 0;
  for (const e of events) {
    const why = await judge(get, e, ctx);
    // A run with no record shows only main at its dispatch, not the ref it deployed.
    releases.push({ at: e.at, sha: e.record?.sha ?? null, mainAtDispatch: e.record ? null : e.cms.at(-1)?.sha, counted: why.length === 0, why });
    if (why.length) break;
    count++;
    if (count >= need) break;
  }
  // An unfinished CMS run may be a production release with no record.
  return { need, count, met: count >= need && pending.length === 0, pending, releases };
}

function githubGet(token) {
  return async (path) => {
    const reply = await fetch(`https://api.github.com/${path}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!reply.ok) {
      const error = new Error(`GitHub HTTP ${reply.status} for ${path.split("?")[0]}`);
      error.status = reply.status;
      throw error;
    }
    return reply.json();
  };
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const need = Number(arg("--need"));
  const repo = arg("--repo");
  const toolRepo = arg("--tool-repo");
  const name = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const day = arg("--since");
  if (!Number.isInteger(need) || need < 1 || !name.test(repo ?? "") || !name.test(toolRepo ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
    throw new Error("usage: release-streak.mjs --need <n> --repo <owner/name> --tool-repo <owner/name> --since YYYY-MM-DD [--json]");
  }
  const since = new Date(`${day}T00:00:00Z`).toISOString();
  const result = await releaseStreak(githubGet(process.env.GH_TOKEN || process.env.GITHUB_TOKEN), { need, since, repo, toolRepo });
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 1));
  else {
    console.log(`count ${result.count} of ${need}`);
    for (const r of result.releases) {
      const commit = r.sha ? short(r.sha) : `(main ${short(r.mainAtDispatch)} at dispatch)`;
      console.log(`${r.counted ? "counted" : "not counted"}: ${easternDate(r.at)} ET ${commit}${r.why.length ? ": " + r.why.join("; ") : ""}`);
    }
    if (result.pending.length) console.log(`not met while these CMS runs are unfinished: ${result.pending.join(", ")}`);
  }
  return result.met ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
