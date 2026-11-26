#!/usr/bin/env node
// Counts the production releases in a row that meet the release goal, read
// only from GitHub. Exit 0 when the count reaches --need.
//
//   node scripts/release-streak.mjs --need 4 [--since 2026-11-01] [--json]
//
// Auth: GH_TOKEN or GITHUB_TOKEN; it must read jamditis/jawn-ops (condition 6).
//
// The record that `jawn-ops njpbs release run` writes, one per command:
// - A GitHub deployment on CenterCoopMedia/njpbs. environment release-production
//   or release-development, ref = the full source commit, task "release",
//   payload { schema: 1, source, release_id, tool, target }.
// - Status in_progress at the start. At the end one status success or failure
//   whose description is "failed=<n> seconds=<s> refused=<s>". A record with no
//   end status (a failed record write, a stopped host) does not count.
// - release-drift.yml runs carry release_id in their run name ("[<id>]"). The
//   first one is the check before the first write, the last the check after.
//
// A release counts when all nine conditions of the release reliability plan hold:
//  1. One release-production record for the commit; it ended success, failed=0.
//  2. A drift run with its ID ended green before the production CMS run started.
//  3. One production cms-deploy.yml run inside the record: attempt 1, success.
//  4. A later drift run with its ID ended green after the CMS run.
//  5. The live site named the commit: read by that drift run (4).
//  6. The tool commit is on jawn-ops master.
//  7. The commit's first release-development record ended success, failed=0.
//  8. Consecutive: a release that does not count ends the streak, and production
//     CMS runs with no record count as one release that does not count.
//  9. At its start, the oldest commit the release brought was at most 5 days old (Tue and Thu releases, Joe, Nov. 26).

const REPO = "CenterCoopMedia/njpbs";
const TOOL_REPO = "jamditis/jawn-ops";
const MAX_BEHIND_DAYS = 5;
const DAY = 86400e3;

export function parseEnd(description) {
  const m = /^failed=(\d+) seconds=(\d+(?:\.\d+)?) refused=(\d+(?:\.\d+)?)/.exec(description ?? "");
  return m ? { failed: Number(m[1]), seconds: Number(m[2]), refused: Number(m[3]) } : null;
}

const ended = (s) => s.state === "success" || s.state === "failure" || s.state === "error";
const runId = (url) => Number(/\/actions\/runs\/(\d+)/.exec(url ?? "")?.[1] ?? 0);
const short = (sha) => (sha ?? "").slice(0, 8);
const easternDate = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function list(get, path, key) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body = await get(`${path}${sep}per_page=100&page=${page}`);
    const items = key ? body?.[key] ?? [] : body ?? [];
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error(`more than 1000 items at ${path}; pass a later --since`);
}

async function records(get, environment, since) {
  const deployments = (await list(get, `repos/${REPO}/deployments?environment=${environment}`)).filter((d) => d.created_at >= since);
  return Promise.all(deployments.map(async (d) => {
    const statuses = await get(`repos/${REPO}/deployments/${d.id}/statuses?per_page=100`);
    const end = statuses.find(ended);
    return { id: d.id, sha: d.sha, start: d.created_at, payload: d.payload ?? {}, end: end ? { state: end.state, at: end.created_at, ...parseEnd(end.description) } : null };
  }));
}

// Production CMS runs: the cms-deploy.yml runs whose job used the production
// environment. GitHub links each environment deployment to its job.
async function productionCMSRuns(get, since) {
  const runs = (await list(get, `repos/${REPO}/actions/workflows/cms-deploy.yml/runs?created=%3E%3D${since.slice(0, 10)}`, "workflow_runs"));
  const deployments = (await list(get, `repos/${REPO}/deployments?environment=production`)).filter((d) => d.created_at >= since);
  const production = new Map();
  for (const d of deployments) {
    const statuses = await get(`repos/${REPO}/deployments/${d.id}/statuses?per_page=100`);
    const id = runId(statuses.at(-1)?.target_url);
    if (id) production.set(id, d.sha);
  }
  return runs.filter((r) => production.has(r.id))
    .map((r) => ({ id: r.id, created: r.created_at, updated: r.updated_at, conclusion: r.conclusion, attempt: r.run_attempt, sha: production.get(r.id) }))
    .sort((a, b) => a.created.localeCompare(b.created));
}

async function driftRuns(get, since) {
  try {
    return await list(get, `repos/${REPO}/actions/workflows/release-drift.yml/runs?created=%3E%3D${since.slice(0, 10)}`, "workflow_runs");
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function onMaster(get, tool) {
  if (!/^[0-9a-f]{40}$/.test(tool ?? "")) return false;
  const compare = await get(`repos/${TOOL_REPO}/compare/master...${tool}`);
  return compare.status === "behind" || compare.status === "identical";
}

// The commits a release brings: those after the previous production source.
async function oldestBrought(get, previous, source) {
  if (!previous) return null;
  const compare = await get(`repos/${REPO}/compare/${previous}...${source}`);
  const dates = (compare.commits ?? []).map((c) => c.commit.committer.date).sort();
  return { count: compare.ahead_by ?? dates.length, oldest: dates[0] ?? null };
}

async function judge(get, release, ctx) {
  const why = [];
  const { record, cms, previous } = release;
  if (!record) {
    why.push(`no release-production record (${cms.length} production CMS run${cms.length === 1 ? "" : "s"}: ${cms.map((r) => `${r.id} ${r.conclusion}`).join(", ")})`);
    return why;
  }
  // 1
  const same = ctx.production.filter((r) => r.sha === record.sha);
  if (same.length > 1) why.push(`${same.length} release-production records for the commit`);
  if (!record.end) why.push("record has no end status");
  else if (record.end.state !== "success" || record.end.failed !== 0) why.push(`record ended ${record.end.state}${record.end.failed == null ? "" : `, failed=${record.end.failed}`}`);
  // 3
  if (cms.length !== 1) why.push(`${cms.length} production CMS runs inside the record, not 1`);
  const run = cms[0];
  if (run && (run.conclusion !== "success" || run.attempt !== 1)) why.push(`CMS run ${run.id} ${run.conclusion}, attempt ${run.attempt}`);
  // 2 and 4
  const id = record.payload.release_id;
  const drift = id ? ctx.drift.filter((d) => (d.display_title ?? d.name ?? "").includes(`[${id}]`)).sort((a, b) => a.created_at.localeCompare(b.created_at)) : [];
  const before = drift[0];
  if (!before || before.conclusion !== "success" || !run || before.updated_at > run.created) why.push("no green drift check before the CMS run");
  const after = drift.length > 1 ? drift.at(-1) : null;
  if (!after || after.conclusion !== "success" || !run || after.created_at < run.updated) why.push("no green drift check after the release (conditions 4 and 5)");
  // 6
  if (!(await onMaster(get, record.payload.tool))) why.push(`tool ${short(record.payload.tool) || "unnamed"} is not on jawn-ops master`);
  // 7
  const dev = ctx.development.filter((r) => r.sha === record.sha && r.start < record.start).sort((a, b) => a.start.localeCompare(b.start))[0];
  if (!dev) why.push("no earlier release-development record");
  else if (dev.end?.state !== "success" || dev.end.failed !== 0) why.push("first release-development record did not succeed");
  // 9 and "already live"
  const brought = await oldestBrought(get, previous, record.sha);
  if (brought && brought.count === 0) why.push("the commit was already live");
  else if (brought?.oldest && (Date.parse(record.start) - Date.parse(brought.oldest)) / DAY > MAX_BEHIND_DAYS) {
    why.push(`production was ${Math.floor((Date.parse(record.start) - Date.parse(brought.oldest)) / DAY)} days behind main`);
  }
  return why;
}

export async function releaseStreak(get, { need, since }) {
  const [production, development, cmsRuns, drift] = await Promise.all([
    records(get, "release-production", since), records(get, "release-development", since),
    productionCMSRuns(get, since), driftRuns(get, since),
  ]);
  // Each record is one release; production CMS runs outside every record form
  // releases without a record, one per stretch between records.
  const inside = (run, r) => run.created >= r.start && (!r.end || run.created <= r.end.at);
  const events = [
    ...production.map((r) => ({ at: r.start, record: r, cms: cmsRuns.filter((run) => inside(run, r)) })),
  ];
  let loose = null;
  for (const run of cmsRuns) {
    if (production.some((r) => inside(run, r))) { loose = null; continue; }
    const recordBetween = loose && production.some((r) => r.start > loose.cms.at(-1).created && r.start < run.created);
    if (!loose || recordBetween) events.push(loose = { at: run.created, record: null, cms: [] });
    loose.cms.push(run);
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  events.forEach((e, i) => { e.previous = events.slice(i + 1).find((o) => o.record?.end?.state === "success")?.record.sha ?? events[i + 1]?.cms.at(-1)?.sha ?? null; });

  const ctx = { production, development, drift };
  const releases = [];
  let count = 0;
  for (const e of events) {
    const why = await judge(get, e, ctx);
    const sha = e.record?.sha ?? e.cms.at(-1)?.sha;
    releases.push({ at: e.at, sha, counted: why.length === 0, why });
    if (why.length) break;
    count++;
    if (count >= need) break;
  }
  return { need, count, met: count >= need, releases };
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
  if (!Number.isInteger(need) || need < 1) throw new Error("usage: release-streak.mjs --need <n> [--since YYYY-MM-DD] [--json]");
  const since = new Date(arg("--since") ?? Date.now() - 60 * DAY).toISOString();
  const result = await releaseStreak(githubGet(process.env.GH_TOKEN || process.env.GITHUB_TOKEN), { need, since });
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 1));
  else {
    console.log(`count ${result.count} of ${need}`);
    for (const r of result.releases) console.log(`${r.counted ? "counted" : "not counted"}: ${easternDate(r.at)} ET ${short(r.sha)}${r.why.length ? ": " + r.why.join("; ") : ""}`);
  }
  return result.met ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
