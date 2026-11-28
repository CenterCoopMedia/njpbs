// Links fix-repository pull requests that shipped before reports followed the
// fix repository (issue #755). Each link is an attach_pull_request job in the
// report GitHub outbox, the same job an administrator's "Attach PR" action
// queues. The job worker reads the pull request, moves the report to the fix
// namespace and verifies whether the fix is live. This script never changes a
// report's status and queues no email.
//
// Dry run (default) reads only. --apply creates the planned outbox jobs; their
// ids are deterministic, so a rerun skips jobs that already exist.
//
//   node scripts/link-public-fix-pull-requests.mjs --fix-repository <owner/name> [--apply] 3<credentials.json
//
// The Firebase service account JSON arrives on fd 3 and is never written out.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { cmsTarget } from "./lib/cms-target.mjs";

export const SYSTEM_ACTOR = "system:public-fix-backfill";

// Report tracker issue -> fix pull requests named in its closing comment.
export const SHIPPED_FIXES = Object.freeze({
  5129: [710, 711, 717],
  5130: [710, 711, 717],
  5131: [722],
  5132: [727],
  5134: [734, 737, 738],
});

export function jobId(reportId, pullNumber) {
  return `${reportId}--public-fix-${pullNumber}`;
}

// One planned job for each mapped pull request not already linked in the fix
// namespace. Reports keep their status; resolved reports are listed too.
export function planLinks(reportsByIssue, fixRepository, fixes = SHIPPED_FIXES) {
  const plan = [];
  for (const [issueNumber, pullNumbers] of Object.entries(fixes)) {
    const reports = reportsByIssue.get(Number(issueNumber)) ?? [];
    if (!reports.length) plan.push({ issueNumber: Number(issueNumber), reportId: null, skip: "no report links this issue" });
    for (const report of reports) {
      const inFixNamespace = typeof report.fixPullRequestRepository === "string" &&
        report.fixPullRequestRepository.toLowerCase() === fixRepository.toLowerCase();
      const linked = new Set(inFixNamespace ? report.links?.pullRequestNumbers ?? [] : []);
      for (const pullNumber of pullNumbers) {
        plan.push({ issueNumber: Number(issueNumber), reportId: report.id, status: report.status, pullNumber,
          ...(linked.has(pullNumber) ? { skip: "already linked" } : { jobId: jobId(report.id, pullNumber) }) });
      }
    }
  }
  return plan;
}

export function outboxJob(entry, now) {
  return { reportId: entry.reportId, operation: "attach_pull_request", targetNumber: entry.pullNumber,
    requestedBy: SYSTEM_ACTOR, state: "pending", attemptCount: 0, nextAttemptAt: now, leaseUntil: null,
    lastError: null, createdAt: now, updatedAt: now };
}

async function readReports(firestore) {
  const reportsByIssue = new Map();
  for (const issueNumber of Object.keys(SHIPPED_FIXES).map(Number)) {
    const snapshot = await firestore.collection("bug_reports")
      .where("links.githubIssueNumbers", "array-contains", issueNumber).limit(20).get();
    reportsByIssue.set(issueNumber, snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  }
  return reportsByIssue;
}

async function applyPlan(firestore, plan, now) {
  const results = [];
  for (const entry of plan.filter((row) => row.jobId)) {
    const ref = firestore.collection("bugReportGithubOutbox").doc(entry.jobId);
    try {
      await ref.create(outboxJob(entry, now));
      results.push({ jobId: entry.jobId, result: "created" });
    } catch (error) {
      if (error?.code !== 6) throw error; // ALREADY_EXISTS
      results.push({ jobId: entry.jobId, result: "exists" });
    }
  }
  return results;
}

function describe(entry) {
  const report = entry.reportId ? `${entry.reportId.slice(0, 11)}… (${entry.status})` : "-";
  const action = entry.skip ? `skip: ${entry.skip}` : `attach PR #${entry.pullNumber}`;
  return `issue ${entry.issueNumber}  report ${report}  ${action}`;
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const fixRepository = argv[argv.indexOf("--fix-repository") + 1];
  if (!argv.includes("--fix-repository") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fixRepository ?? "")) {
    throw new Error("--fix-repository <owner/name> is required");
  }
  const credentials = JSON.parse(readFileSync(3, "utf8"));
  const app = initializeApp({ credential: cert(credentials), projectId: cmsTarget().projectId }, SYSTEM_ACTOR);
  try {
    const firestore = getFirestore(app);
    const plan = planLinks(await readReports(firestore), fixRepository);
    console.log(`${apply ? "Apply" : "Dry run"}: ${plan.filter((row) => row.jobId).length} attach jobs planned`);
    for (const entry of plan) console.log(describe(entry));
    if (apply) for (const row of await applyPlan(firestore, plan, new Date())) console.log(`${row.result} ${row.jobId}`);
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
