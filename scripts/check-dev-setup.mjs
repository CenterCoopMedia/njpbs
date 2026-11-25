// Read-only check of the development grants a release run needs and nothing
// checks ahead of time: the release reader's project permissions and its
// object access to the development background bucket. It sends only
// testIamPermissions requests, which report the caller's own permissions.
//
// Usage: node scripts/check-dev-setup.mjs 3< <development publisher account key>
// fd 3 holds the development publisher's service account key. The same account
// is the jawn-ops development release reader.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseDevOperatorCredential } from "./lib/dev-proof-admission.mjs";

const require = createRequire(import.meta.url);
const { publicationTarget } = require("../functions/lib/publication-target");

const target = publicationTarget("development");
const SETUP = "docs/cms/deploy.md";

// Project permissions the release reader uses, with the role that grants each.
// The release's post-CMS smoke reads Functions and Scheduler metadata
// (Nov. 24, 2026: both were missing on development).
export const READER_PERMISSIONS = Object.freeze({
  "datastore.entities.get": "roles/datastore.viewer",
  "datastore.indexes.list": "roles/datastore.viewer",
  "cloudfunctions.functions.get": "roles/cloudfunctions.viewer",
  "cloudscheduler.jobs.get": "roles/cloudscheduler.viewer",
});
export const BUCKET_PERMISSIONS = Object.freeze(["storage.objects.create", "storage.objects.get", "storage.objects.list", "storage.objects.delete"]);

const BUCKET_FIX = `gcloud storage buckets create gs://${target.backgroundBucket} --project=${target.projectId} --location=US-CENTRAL1 ` +
  `--uniform-bucket-level-access --public-access-prevention (when absent), then gcloud storage buckets add-iam-policy-binding ` +
  `gs://${target.backgroundBucket} --member=serviceAccount:<dev publisher account> --role=roles/storage.objectUser`;

// A failed request proves no missing grant.
const RETRY = "the request did not complete or was refused; check the account key and network, then run the check again";

// request(url, init) resolves to { status, body }. A rejected request becomes
// a failed row, and the other checks still run.
async function read(request, url, init) {
  try { return await request(url, init); } catch (error) { return { status: 0, error: error?.name === "TimeoutError" ? "timed out" : "request failed" }; }
}
const failure = answer => answer.status === 0 ? answer.error : `HTTP ${answer.status}`;

export async function checkDevSetup(request) {
  const rows = [];
  const row = (name, ok, detail, fix) => rows.push({ name, ok, detail, ...(ok ? {} : { fix }) });

  const wanted = Object.keys(READER_PERMISSIONS);
  const project = await read(request, `https://cloudresourcemanager.googleapis.com/v1/projects/${target.projectId}:testIamPermissions`,
    { method: "POST", body: JSON.stringify({ permissions: wanted }) });
  const held = new Set(project.status === 200 ? project.body?.permissions ?? [] : []);
  const missing = wanted.filter(permission => !held.has(permission));
  row("release reader project permissions", project.status === 200 && !missing.length,
    project.status === 200 ? (missing.length ? `missing ${missing.join(", ")}` : "all held") : failure(project),
    project.status === 200 ? `grant ${[...new Set(missing.map(permission => READER_PERMISSIONS[permission]))].join(" and ")} on ${target.projectId} to the dev publisher account` : RETRY);

  const query = BUCKET_PERMISSIONS.map(permission => `permissions=${permission}`).join("&");
  const bucket = await read(request, `https://storage.googleapis.com/storage/v1/b/${target.backgroundBucket}/iam/testPermissions?${query}`);
  const bucketHeld = new Set(bucket.status === 200 ? bucket.body?.permissions ?? [] : []);
  const bucketMissing = BUCKET_PERMISSIONS.filter(permission => !bucketHeld.has(permission));
  row(`background bucket gs://${target.backgroundBucket}`, bucket.status === 200 && !bucketMissing.length,
    bucket.status === 404 ? "absent" : bucket.status === 200 ? (bucketMissing.length ? `missing ${bucketMissing.join(", ")}` : "objects writable") : failure(bucket),
    bucket.status === 200 || bucket.status === 404 ? BUCKET_FIX : RETRY);
  return rows;
}

export function formatDevSetup(rows) {
  return rows.map(({ name, ok, detail, fix }) => `${ok ? "pass" : "FAIL"} ${name}: ${detail}${fix ? `; fix: ${fix} (${SETUP})` : ""}`).join("\n");
}

async function main() {
  if (process.argv.length > 2) throw new Error("Usage: node scripts/check-dev-setup.mjs 3< <development publisher account key>");
  let input;
  try { input = readFileSync(3, "utf8"); } catch { throw new Error("Supply the development publisher account key on fd 3"); }
  const account = parseDevOperatorCredential(input);
  const { cert } = require("firebase-admin/app");
  const { access_token: token } = await cert(account).getAccessToken();
  const request = async (url, init = {}) => {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) } });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  const rows = await checkDevSetup(request);
  console.log(formatDevSetup(rows));
  return rows.every(row => row.ok) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 2; });
}
