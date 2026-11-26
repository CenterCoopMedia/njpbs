// Contract test of the drift check at the network boundary, with states recorded from production
// (tests/scripts/fixtures/release-drift/recorded-states.json names each source).
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkReleaseDrift } from "../../scripts/lib/release-drift.mjs";

const fixtures = new URL("./fixtures/release-drift/", import.meta.url);
const recorded = JSON.parse(readFileSync(new URL("recorded-states.json", fixtures), "utf8"));
// The Oct. 8 snippet file, as the Snippets API returned it inside its multipart answer before the Nov. 26 deploy.
const oct8Snippet = readFileSync(new URL("snippet-oct8.js", fixtures));
const multipart = () => { const form = new FormData(); form.append("files", new Blob([oct8Snippet], { type: "application/javascript+module" }), "legacy_redirects_260.js"); return form; };
const registry = JSON.parse(readFileSync(new URL("../../config/release-surfaces.json", import.meta.url), "utf8"));
const main = "ec7f48a199b53b42e7aa66d43f83c7fdf7963561", functionsCommit = "a83aed8924b63d2e4d078e62cf5b7eaac1f0141f";
const exported = new Set(registry.functions.find(row => row.entrypoint === "functions/index.js").exports.map(e => e.name));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ type: "service_account", project_id: "njpbs-site", client_email: "deploy@example.test",
    token_uri: "https://oauth2.example.test/token", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }),
  CLOUDFLARE_ACCOUNT_ID: "test-account", CMS_ANALYTICS_CF_ZONE_ID: "test-zone",
  CLOUDFLARE_API_TOKEN: "cloudflare-test-token", CMS_ADMIN_ACCESS_API_TOKEN: "access-test-token",
  CMS_PREVIEW_SMOKE_TARGET: JSON.stringify({ editor: "/content/post/6afdc0cf0abb8dba4e23441deab3f47a/edit", heading: "Fixture" }),
};
const source = (snippetSha256 = recorded.snippetSourceSha256) => ({
  sha: main, exported, functionsSha: functionsCommit, rendererSha: functionsCommit,
  files: { "firestore.rules": "rules_version = '2';", "storage.rules": "rules_version = '2';" },
  snippetSha256, exportsAt: async () => exported, behind: async () => ({ commits: 0, days: 0 }),
});

// One fake provider: answers the reads the check makes, from the recorded states.
function provider({ functions = recorded.functions, fixture = recorded.fixtureArchived, workerVariables = recorded.workerVariables } = {}) {
  const calls = [];
  const json = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const cf = result => json({ success: true, result });
  const http = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const u = new URL(url), path = u.pathname;
    if (u.host === "oauth2.example.test") return json({ access_token: "google-test-token" });
    if (u.host === "cloudfunctions.googleapis.com") return json(functions);
    if (u.host === "firestore.googleapis.com") {
      if (path.endsWith("/cmsPosts/6afdc0cf0abb8dba4e23441deab3f47a")) return json(fixture);
      if (path.endsWith("/system/publicDeployment")) return json(recorded.pointer);
      if (path.endsWith("/system/cmsPublicationRuntime")) return json(recorded.runtime);
      if (path.endsWith("/system/cmsPreviewRuntime")) return json(recorded.previewRuntime);
    }
    if (url.includes(":testIamPermissions")) return json({ permissions: JSON.parse(init.body).permissions });
    if (u.host === "firebaserules.googleapis.com") {
      if (path.endsWith("/releases")) return json({ releases: [{ name: "projects/njpbs-site/releases/cloud.firestore", rulesetName: "projects/njpbs-site/rulesets/f" },
        { name: "projects/njpbs-site/releases/firebase.storage/njpbs-site.firebasestorage.app", rulesetName: "projects/njpbs-site/rulesets/s" }] });
      return json({ source: { files: [{ content: "rules_version = '2';" }] } });
    }
    if (u.host === "njpbs.org") return json({ commitSha: recorded.publicationCommit });
    if (u.host === "api.cloudflare.com") {
      const script = /\/workers\/scripts\/([^/]+)\/settings$/.exec(path)?.[1];
      if (script) return cf({ bindings: (workerVariables[script] ?? []).map(([name, text]) => ({ type: "plain_text", name, text })) });
      if (path.endsWith("/snippets/snippet_rules")) return cf(recorded.snippetRulesBefore.result);
      if (path.endsWith("/content")) return new Response(multipart());
      if (path.endsWith("/access/apps")) return cf([{ id: "app", type: "self_hosted", domain: "admin.njpbs.org" }]);
      if (/\/pages\/projects\/[^/]+$/.test(path)) return cf({ canonical_deployment: { latest_stage: { name: "deploy", status: "success" }, deployment_trigger: { metadata: { commit_hash: main } } } });
      return cf([]);
    }
    return new Response("not recorded", { status: 404 });
  };
  return { http, calls };
}
const run = (fake, options = {}) => checkReleaseDrift({ target: { environment: "production", projectId: "njpbs-site", publicOrigin: "https://njpbs.org" },
  registry, source: source(options.snippetSha256), env, http: fake.http, after: options.after ?? false });
const line = (lines, start) => lines.find(text => text.includes(start)) ?? "";

test("the Nov. 25-26 production states stop the release and name each cause", async () => {
  const fake = provider();
  const { lines, failed } = await run(fake);
  assert.equal(failed, true);
  assert.match(line(lines, "check 1"), /^FAIL check 1 leftover Functions: cmsGetBroadcastSchedule, cmsGetPublishedSettings are live/);
  assert.doesNotMatch(line(lines, "check 1"), /billingKillSwitch/, "a Function the registry lists outside the release is not a leftover");
  assert.equal(line(lines, "check 2"), "FAIL check 2 smoke fixture: the fixture is archived, not draft");
  assert.equal(line(lines, "check 3"), "ok   check 3 publication idle");
  assert.equal(line(lines, "check 5"), "ok   check 5 release credentials read");
  assert.match(line(lines, "Edge snippet"), /^diff Edge snippet: differs: live [0-9a-f]{12}, source bc9ede7fcefe$/);
  assert.match(line(lines, "CMS API Worker"), /^diff CMS API Worker: differs: live no CMS_API_SOURCE_SHA/);
  assert.equal(line(lines, "Public site"), "info Public site: equal ec7f48a199b5");
  assert.ok(fake.calls.every(call => call.startsWith("GET ") || call.includes(":testIamPermissions") || call.startsWith("POST https://oauth2.")),
    "the check makes no write");
});

test("a missing export fails after a release, except the cloud wake Functions", async () => {
  const { lines } = await run(provider(), { after: true });
  assert.match(line(lines, "FAIL Functions: "), /^FAIL Functions: differs: live not live: .*cmsGetContent/);
  assert.doesNotMatch(line(lines, "FAIL Functions: "), /onNoBuildCloudState/);
  assert.match(line(lines, "Cloud wake Functions not live"), /^info Cloud wake Functions not live: onNoBuildCloudCandidate, onNoBuildCloudRelease, onNoBuildCloudState$/);
});

test("after a release every part that differs fails", async () => {
  const { lines, failed } = await run(provider({ fixture: { fields: { type: { stringValue: "post" }, status: { stringValue: "draft" } } },
    functions: { functions: recorded.functions.functions.filter(fn => exported.has(fn.name.split("/").at(-1)) || fn.name.endsWith("/billingKillSwitch")) } }),
  { after: true });
  assert.equal(failed, true);
  assert.equal(line(lines, "check 1"), "ok   check 1 leftover Functions");
  assert.match(line(lines, "Edge snippet"), /^FAIL Edge snippet: differs/);
  assert.match(line(lines, "CMS API Worker"), /^FAIL CMS API Worker: differs/);
});

test("a target that equals the source passes, also after a release", async () => {
  // The source bundle equals the live one.
  const oct8 = createHash("sha256").update(oct8Snippet).digest("hex");
  const fake = provider({ fixture: { fields: { type: { stringValue: "post" }, status: { stringValue: "draft" } } },
    // Every export of the source live at the Functions commit, plus the Function the registry lists outside the release.
    functions: { functions: [...exported, "billingKillSwitch"].map(name => ({ name: `projects/njpbs-site/locations/us-central1/functions/${name}`,
      serviceConfig: { environmentVariables: name === "billingKillSwitch" ? {} : { CMS_ADMIN_BUILD_REVISION: functionsCommit } } })) },
    workerVariables: { ...recorded.workerVariables, "njpbs-cms-api": [["CMS_API_SOURCE_SHA", main]] } });
  const { lines, failed } = await run(fake, { after: true, snippetSha256: oct8 });
  assert.deepEqual(lines.filter(text => /^(FAIL|diff)/.test(text)), []);
  assert.equal(failed, false);
});
