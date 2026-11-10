import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { loadFunctionSource } from "../../scripts/lib/functions-deploy-inventory.mjs";
import { checkSecretIam, secretRequirements, eventTriggerRequirements } from "../../scripts/check-cms-secret-iam.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const deploy = "firebase-adminsdk-fbsvc@njpbs-site.iam.gserviceaccount.com";
const media = "boardwalk-s3-media@njpbs-site.iam.gserviceaccount.com";
const defaultRuntime = "123456789-compute@developer.gserviceaccount.com";
const expected = [
  "CMS_ANALYTICS_CF_TOKEN", "CMS_ANALYTICS_MAILCHIMP_KEY", "CMS_BUG_REPORT_GITHUB_TOKEN",
  "CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET", "CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN",
  "CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET", "CMS_EDGE_ORIGIN_SECRET", "CMS_MEDIA_CACHE_PURGE_TOKEN",
  "CMS_MEDIA_R2_ACCESS_KEY_ID", "CMS_MEDIA_R2_SECRET_ACCESS_KEY", "CMS_PRIVATE_VIDEO_R2_READ_ACCESS_KEY_ID",
  "CMS_PRIVATE_VIDEO_R2_READ_SECRET_ACCESS_KEY", "CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID",
  "CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY", "CMS_PUBLISH_GITHUB_TOKEN", "CMS_STAFF_EMAIL_API_TOKEN",
  "CMS_TRANSCRIPTION_CREDENTIAL_KEY", "CMS_VOICEOVER_R2_ACCESS_KEY_ID", "CMS_VOICEOVER_R2_SECRET_ACCESS_KEY",
  "CUEZ_STORYDESK_API_KEY", "PUBLISHED_POST_READER_HMAC_KEY", "UGC_R2_ACCESS_KEY_ID", "UGC_R2_SECRET_ACCESS_KEY",
];
const requirements = secretRequirements(loadFunctionSource("njpbs-site"), "123456789");
const events = eventTriggerRequirements(loadFunctionSource("njpbs-site"), "123456789");
const fixture = mkdtempSync(join(tmpdir(), "cms-secret-iam-"));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));
mkdirSync(join(fixture, "scripts/lib"), { recursive: true });
for (const path of ["functions", "firebase.json", "scripts/check-cms-secret-iam.mjs", "scripts/prepare-cloud-publication-wake.mjs", "scripts/deploy-cms-function-batches.mjs", "scripts/lib"]) {
  cpSync(join(root, path), join(fixture, path), { recursive: true, filter: path => !path.includes("node_modules") });
}
symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
const policies = Object.fromEntries([...requirements].map(([name, accounts]) => [name, { bindings: [
  // Exercise least-privilege deploy access: two secrets are viewer-only;
  // the publish token additionally permits adding a version.
  { role: ["CMS_PUBLISH_GITHUB_TOKEN", "CMS_TRANSCRIPTION_CREDENTIAL_KEY"].includes(name)
    ? "roles/secretmanager.viewer" : "roles/secretmanager.admin", members: [`serviceAccount:${deploy}`] },
  { role: "roles/secretmanager.secretAccessor", members: [...accounts].map(account => `serviceAccount:${account}`) },
  ...(name === "CMS_PUBLISH_GITHUB_TOKEN" ? [{ role: "roles/secretmanager.secretVersionAdder", members: [`serviceAccount:${deploy}`] }] : []),
] }]));
writeFileSync(join(fixture, "policies.json"), JSON.stringify(policies));
writeFileSync(join(fixture, "gcloud"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.IAM_CALLS, JSON.stringify(args)+'\\n');
if (args[0] === 'auth') console.log(args[1] === 'print-access-token' ? 'fixture-metadata-token' : process.env.IAM_MODE === 'wrong-deployer' ? 'other@example.com' : '${deploy}');
else if (args[0] === 'projects' && args[1] === 'describe') console.log('123456789');
else if (args[0] === 'projects' && args[1] === 'get-iam-policy') {
  console.log(JSON.stringify({bindings: [
    {role:'roles/eventarc.eventReceiver', members:process.env.IAM_MODE === 'missing-event' ? [] : ${JSON.stringify([...new Set(events.map(event => `serviceAccount:${event.account}`))])}},
    {role:'roles/run.invoker', members:(process.env.IAM_MODE?.startsWith('service-') || process.env.IAM_MODE?.startsWith('first-')) ? [] : ${JSON.stringify([...new Set(events.map(event => `serviceAccount:${event.account}`))])}}
  ]}));
}
else if (args[0] === 'functions' && args[1] === 'describe') {
  if (args.includes('--format=value(eventTrigger.serviceAccountEmail)')) {
    console.log(process.env.IAM_MODE === 'first-account-drift' ? 'other@njpbs-site.iam.gserviceaccount.com' :
      ${JSON.stringify(Object.fromEntries(events.map(event => [event.name, event.account])))}[args[2]]);
    process.exit(0);
  }
  const project = process.env.IAM_MODE === 'service-wrong-project' ? 'other-project' : 'njpbs-site';
  console.log('projects/'+project+'/locations/us-central1/services/'+args[2].toLowerCase());
}
else if (args[0] === 'run' && args[1] === 'services' && args[2] === 'get-iam-policy') {
  if (process.env.IAM_MODE === 'service-read-exhausted' ||
      process.env.IAM_MODE === 'service-read-transient' && fs.readFileSync(process.env.IAM_CALLS, 'utf8').split('\\n').filter(line => line.includes('get-iam-policy') && line.includes('services')).length === 1) process.exit(7);
  const account = ${JSON.stringify(Object.fromEntries(events.map(event => [event.name.toLowerCase(), event.account])))}[args[3]];
  console.log(JSON.stringify({bindings:[{role:'roles/run.invoker', members:
    args[3] === 'ondatasetrefresh' && process.env.IAM_MODE?.startsWith('first-') && process.env.IAM_MODE !== 'first-granted'
      ? [] : ['serviceAccount:'+account]}]}));
}
else if (args[0] === 'secrets' && args[1] === 'get-iam-policy') {
  const secret = args[2];
  if (secret === process.env.IAM_SECRET && process.env.IAM_MODE === 'unreadable') process.exit(1);
  if (secret === process.env.IAM_SECRET && process.env.IAM_MODE === 'malformed') { console.log('{'); process.exit(0); }
  const policy = JSON.parse(fs.readFileSync(process.env.IAM_POLICIES))[secret];
  if (!policy) process.exit(2);
  if (secret === process.env.IAM_SECRET) {
    const index = process.env.IAM_ROLE === 'runtime' ? 1 : 0;
    if (process.env.IAM_MODE === 'viewer') policy.bindings[0].role = 'roles/secretmanager.viewer';
    if (process.env.IAM_MODE === 'missing') policy.bindings.splice(index, 1);
    if (process.env.IAM_MODE === 'conditional') policy.bindings[index].condition = {expression:'true'};
    if (process.env.IAM_MODE === 'wrong-runtime') policy.bindings[1].members = ['serviceAccount:${deploy}'];
  }
  console.log(JSON.stringify(policy));
} else process.exit(9);
`);
chmodSync(join(fixture, "gcloud"), 0o700);
writeFileSync(join(fixture, "inventory-network.mjs"), `
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.origin !== 'https://cloudfunctions.googleapis.com' || init.headers.Authorization !== 'Bearer fixture-metadata-token') throw Error('Unexpected inventory request');
    if (process.env.IAM_MODE === 'first-inventory-denied') return new Response(null, { status: 403 });
    if (!url.searchParams.get('fields')?.includes('unreachable') || !url.searchParams.get('fields')?.includes('nextPageToken')) throw Error('Incomplete inventory field mask');
    if (process.env.IAM_MODE === 'first-malformed-name') return Response.json({ functions: [{ environment: 'GEN_2' }] });
    if (process.env.IAM_MODE === 'first-malformed') return Response.json({ functions: {} });
    if (process.env.IAM_MODE === 'first-inventory-unreachable') return Response.json({ unreachable: ['us-central1'] });
    if (process.env.IAM_MODE === 'first-empty' || url.pathname.includes('/v1/')) return Response.json({});
    const rows = ${JSON.stringify(events.map(event => ({ name: `projects/njpbs-site/locations/${event.region}/functions/${event.name}`, environment: 'GEN_2' })))};
    if (process.env.IAM_MODE === 'first-paged-existing') {
      return Response.json(url.searchParams.has('pageToken') ? { functions: rows.filter(row => row.name.endsWith('/onDatasetRefresh')) } :
        { functions: rows.filter(row => !row.name.endsWith('/onDatasetRefresh')), nextPageToken: 'fixture-next-page' });
    }
    return Response.json({ functions: rows.filter(row => !row.name.endsWith('/onDatasetRefresh')) });
  };
`);

execFileSync("git", ["init", "-q"], { cwd: fixture });
execFileSync("git", ["add", "."], { cwd: fixture });
execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Reviewed source"], { cwd: fixture });
const fixtureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
let invocation = 0;
writeFileSync(join(fixture, "credential.json"), JSON.stringify({ type: "service_account", project_id: "njpbs-site", client_email: deploy }));
function run(mode = "valid", secret = "CUEZ_STORYDESK_API_KEY", role = "deploy", args = [], overrides = {}, checker = "scripts/check-cms-secret-iam.mjs") {
  const calls = join(fixture, `calls-${++invocation}.jsonl`);
  const result = spawnSync(process.execPath, [checker, ...args], {
    cwd: fixture, encoding: "utf8", env: {
      FIREBASE_DEPLOY_SERVICE_ACCOUNT: deploy, PATH: `${fixture}:${process.env.PATH}`, IAM_CALLS: calls,
      IAM_POLICIES: join(fixture, "policies.json"), IAM_MODE: mode, IAM_SECRET: secret, IAM_ROLE: role,
      NODE_OPTIONS: `--import=${join(fixture, "inventory-network.mjs")}`,
      DEPLOY_SHA: fixtureSha, GOOGLE_APPLICATION_CREDENTIALS: join(fixture, "credential.json"),
      CLOUD_PUBLICATION_WAKE_ENVIRONMENT: "production", CLOUD_PUBLICATION_WAKE_ENABLED: "false", ...overrides,
    },
  });
  return { ...result, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [] };
}

describe("deployed Functions secret IAM", () => {
  it("extracts every real production binding and its actual runtime", () => {
    expect([...requirements.keys()].sort()).toEqual(expected);
    expect([...requirements.get("CUEZ_STORYDESK_API_KEY")]).toEqual([media]);
    expect(requirements.get("CMS_EDGE_ORIGIN_SECRET")).toContain(defaultRuntime);
    expect([...requirements.get("CMS_TRANSCRIPTION_CREDENTIAL_KEY")].sort()).toEqual([
      "cms-transcription-credentials@njpbs-site.iam.gserviceaccount.com",
      "cms-transcription-runner@njpbs-site.iam.gserviceaccount.com",
    ]);
    expect([...requirements.get("PUBLISHED_POST_READER_HMAC_KEY")]).toEqual([
      "njpbs-published-post-reader@njpbs-site.iam.gserviceaccount.com",
    ]);
  });

  it("includes generated optional secrets when the deployed source binds them", () => {
    writeFileSync(join(fixture, "functions/cost-ledger-pulls.generated.json"), JSON.stringify({
      COST_LEDGER_GCP_PULL: true, COST_LEDGER_CLOUDFLARE_PULL: true, COST_LEDGER_AWS_PULL: true, COST_LEDGER_GITHUB_PULL: true,
    }));
    writeFileSync(join(fixture, "functions/media-purge.generated.json"), JSON.stringify({
      schemaVersion: 1, projectId: "njpbs-site", enabled: true, realDeletesEnabled: false,
    }));
    try {
      const helper = pathToFileURL(join(fixture, "scripts/lib/functions-deploy-inventory.mjs")).href;
      const checker = pathToFileURL(join(fixture, "scripts/check-cms-secret-iam.mjs")).href;
      const names = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
        `import {loadFunctionSource} from ${JSON.stringify(helper)}; import {secretRequirements} from ${JSON.stringify(checker)};
         console.log(JSON.stringify([...secretRequirements(loadFunctionSource('njpbs-site'), '123456789').keys()]));`,
      ], { encoding: "utf8" }));
      expect(names.sort()).toEqual([...expected, "COST_LEDGER_GCP_BILLING_SA", "COST_LEDGER_CLOUDFLARE_API_TOKEN",
        "COST_LEDGER_AWS_ACCESS_KEY_ID", "COST_LEDGER_AWS_SECRET_ACCESS_KEY", "COST_LEDGER_GITHUB_TOKEN",
        "HEALTHCHECKS_MEDIA_PURGE_SWEEP", "CMS_MEDIA_PURGE_R2_ACCESS_KEY_ID", "CMS_MEDIA_PURGE_R2_SECRET_ACCESS_KEY"].sort());
    } finally {
      rmSync(join(fixture, "functions/cost-ledger-pulls.generated.json"));
      rmSync(join(fixture, "functions/media-purge.generated.json"));
    }
  });

  it("passes through a read-only fake gcloud process for all production secrets", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Verified deploy and runtime IAM for ${expected.length}`);
    expect(result.calls.filter(args => args[0] === "secrets").map(args => args[2]).sort()).toEqual(expected);
    expect(result.calls.every(args => ["auth", "projects"].includes(args[0]) ||
      args.join(" ").endsWith("--project=njpbs-site --format=json") && args[1] === "get-iam-policy")).toBe(true);
  });

  it("stops on missing event receiver IAM before reading secrets or running a mutation", () => {
    const result = run("missing-event");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("roles/eventarc.eventReceiver");
    expect(result.calls.map(args => args.slice(0, 2))).toEqual([
      ["auth", "list"], ["projects", "describe"], ["projects", "get-iam-policy"],
    ]);
  });

  it("checks actual Cloud Run service policies through read-only gcloud commands", () => {
    const result = run("service-invoker");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter(args => args[0] === "functions")).toHaveLength(events.length);
    const serviceCalls = result.calls.filter(args => args[0] === "run");
    expect(serviceCalls).toHaveLength(events.length);
    expect(serviceCalls.every(args => args[1] === "services" && args[2] === "get-iam-policy" &&
      args.slice(-3).join(" ") === "--region=us-central1 --project=njpbs-site --format=json")).toBe(true);
    expect(result.calls.every(args => args[1] === "list" || args[1] === "describe" ||
      args[1] === "get-iam-policy" || args[2] === "get-iam-policy")).toBe(true);
    const wrong = run("service-wrong-project");
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("Could not identify the Cloud Run service");
    expect(wrong.calls.some(args => args[0] === "run" || args[0] === "secrets")).toBe(false);
  });

  it("defers only the proved-new service without a plan or invocation mutation", () => {
    const preflight = run("first-new", undefined, undefined, [fixture, "--pre-deploy"]);
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(preflight.calls.some(args => args.includes("add-iam-policy-binding"))).toBe(false);
    expect(preflight.stdout).toContain("1 new service invocation grants require post-deploy verification");
  });

  it("refuses a missing invocation grant after deploy and names the exact authorized repair", () => {
    const result = run("first-created", undefined, undefined, [fixture, "--post-deploy"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`gcloud run services add-iam-policy-binding ondatasetrefresh --member=serviceAccount:${defaultRuntime} --role=roles/run.invoker --condition=None --region=us-central1 --project=njpbs-site`);
    expect(result.calls.some(args => args.includes("add-iam-policy-binding") || args[0] === "secrets")).toBe(false);
  });

  it("verifies all post-deploy identities and service grants with reads only", () => {
    const result = run("first-granted", undefined, undefined, [fixture, "--post-deploy"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter(args => args.includes("--format=value(eventTrigger.serviceAccountEmail)"))).toHaveLength(events.length);
    expect(result.calls.filter(args => args[0] === "run")).toHaveLength(events.length);
    expect(result.calls.every(args => args[1] === "describe" || args[1] === "get-iam-policy" || args[2] === "get-iam-policy")).toBe(true);
  });

  it("runs the post-deploy checker from exactly the workflow's sparse package", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8"));
    const checkout = workflow.jobs.firebase.steps.find(row => row.with?.path === ".cms-iam-gate");
    const files = checkout.with["sparse-checkout"].trim().split(/\s+/);
    const directory = mkdtempSync(join(tmpdir(), "cms-iam-sparse-"));
    try {
      for (const file of files) {
        const target = join(directory, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(root, file), target);
      }
      const result = run("first-granted", undefined, undefined, [fixture, "--post-deploy"], {}, join(directory, "scripts/check-cms-secret-iam.mjs"));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Verified receiver and invocation IAM after deployment for ${events.length} Functions event triggers`);
      expect(result.calls.filter(args => args[0] === "run")).toHaveLength(events.length);
      expect(result.calls.every(args => args[1] === "describe" || args[1] === "get-iam-policy" || args[2] === "get-iam-policy")).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["service-read-transient", "service-read-exhausted"])("bounds unavailable post-deploy policy reads: %s", mode => {
    const result = run(mode, undefined, undefined, [fixture, "--post-deploy"]);
    const policies = result.calls.filter(args => args[0] === "run");
    expect(result.status, result.stderr).toBe(mode.endsWith("exhausted") ? 1 : 0);
    expect(policies.filter(args => args[3] === events[0].name.toLowerCase())).toHaveLength(mode.endsWith("exhausted") ? 3 : 2);
    expect(result.calls.some(args => args.includes("add-iam-policy-binding"))).toBe(false);
  });

  it("refuses changed post-deploy identities, source pins and credentials without writes", () => {
    const drift = run("first-account-drift", undefined, undefined, [fixture, "--post-deploy"]);
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain("selected source identity");
    const source = run("first-granted", undefined, undefined, [fixture, "--post-deploy"], { DEPLOY_SHA: "f".repeat(40) });
    expect(source.status).toBe(1);
    expect(source.stderr).toContain("differs from its pin");
    expect(source.calls).toEqual([]);
    const credential = join(fixture, "wrong-credential.json");
    writeFileSync(credential, JSON.stringify({type:"service_account",project_id:"njpbs-site-dev",client_email:deploy}));
    const wrong = run("first-granted", undefined, undefined, [fixture, "--post-deploy"], { GOOGLE_APPLICATION_CREDENTIALS: credential });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("Invalid Firebase IAM read credential");
    expect(wrong.calls).toEqual([]);
    expect(drift.calls.some(args => args.includes("add-iam-policy-binding"))).toBe(false);
  });

  it("uses the enabled deployment wake artifact for every trigger and secret preflight", () => {
    const path = join(fixture, "functions/cloud-publication-wake.generated.json");
    const policiesPath = join(fixture, "policies.json");
    try {
      rmSync(path, { force: true });
      expect(existsSync(path)).toBe(false);
      writeFileSync(policiesPath, JSON.stringify({ ...policies, CMS_PUBLICATION_WAKE_TOKEN: { bindings: [
        { role: "roles/secretmanager.viewer", members: [`serviceAccount:${deploy}`] },
        { role: "roles/secretmanager.secretAccessor", members: [`serviceAccount:${defaultRuntime}`] },
      ] } }));
      const enabled = { CLOUD_PUBLICATION_WAKE_ENABLED: "true" };
      const result = run("first-new", undefined, undefined, [fixture, "--pre-deploy"], enabled);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, environment: "production", enabled: true });
      const inventory = pathToFileURL(join(fixture, "scripts/lib/functions-deploy-inventory.mjs")).href;
      const checker = pathToFileURL(join(fixture, "scripts/check-cms-secret-iam.mjs")).href;
      const wakeEvents = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
        `import { loadFunctionSource } from ${JSON.stringify(inventory)};
         import { eventTriggerRequirements } from ${JSON.stringify(checker)};
         console.log(JSON.stringify(eventTriggerRequirements(loadFunctionSource('njpbs-site'), '123456789')
           .filter(row => row.name.startsWith('onNoBuildCloud')).map(row => row.name).sort()));`,
      ], { cwd: fixture, encoding: "utf8" }));
      expect(wakeEvents).toEqual(["onNoBuildCloudCandidate", "onNoBuildCloudRelease", "onNoBuildCloudState"]);
      expect(result.stdout).toContain("4 new service invocation grants require post-deploy verification");
      expect(result.calls.some(args => args[0] === "secrets" && args[2] === "CMS_PUBLICATION_WAKE_TOKEN")).toBe(true);
      const denied = run("missing", "CMS_PUBLICATION_WAKE_TOKEN", "runtime", [fixture, "--pre-deploy"], enabled);
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain("Secret CMS_PUBLICATION_WAKE_TOKEN needs an unconditional roles/secretmanager.secretAccessor");
      expect(denied.calls.some(args => args.includes("add-iam-policy-binding") || args[1] === "deploy")).toBe(false);
    } finally { rmSync(path, { force: true }); writeFileSync(policiesPath, JSON.stringify(policies)); }
  });

  it.each([
    { CLOUD_PUBLICATION_WAKE_ENVIRONMENT: undefined },
    { CLOUD_PUBLICATION_WAKE_ENVIRONMENT: "development" },
    { CLOUD_PUBLICATION_WAKE_ENABLED: undefined },
  ])("refuses a missing or mismatched wake decision before provider reads: %j", overrides => {
    const result = run("first-new", undefined, undefined, [fixture, "--pre-deploy"], overrides);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An explicit production cloud wake decision is required");
    expect(result.calls).toEqual([]);
  });

  it("refuses before provider reads when the wake artifact cannot be created", () => {
    const path = join(fixture, "functions/cloud-publication-wake.generated.json");
    rmSync(path, { force: true });
    symlinkSync(join(fixture, "missing-wake-parent", "artifact.json"), path);
    try {
      const result = run("first-new", undefined, undefined, [fixture, "--pre-deploy"], { CLOUD_PUBLICATION_WAKE_ENABLED: "true" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ENOENT");
      expect(existsSync(path)).toBe(false);
      expect(result.calls).toEqual([]);
    } finally { rmSync(path, { force: true }); }
  });

  it.each(["first-inventory-denied", "first-malformed", "first-inventory-unreachable", "first-malformed-name", "first-empty", "first-paged-existing"])("refuses an unproved absence: %s", mode => {
    const result = run(mode, undefined, undefined, [fixture, "--pre-deploy"]);
    expect(result.status).toBe(1);
    expect(result.calls.some(args => args[0] === "secrets" || args.includes("add-iam-policy-binding"))).toBe(false);
  });

  it.each(["deploy", "runtime"])("rejects a missing %s binding on every secret", role => {
    for (const secret of expected) {
      const readPolicy = name => {
        const policy = structuredClone(policies[name]);
        if (name === secret) policy.bindings.splice(role === "deploy" ? 0 : 1, 1);
        return JSON.stringify(policy);
      };
      expect(() => checkSecretIam(requirements, readPolicy, deploy))
        .toThrow(`Secret ${secret} needs an unconditional ${role === "deploy"
          ? "roles/secretmanager.viewer or roles/secretmanager.admin" : "roles/secretmanager.secretAccessor"}`);
    }
  });

  it("accepts viewer-only deploy metadata access with runtime accessors, including Cuez", () => {
    expect(policies.CMS_TRANSCRIPTION_CREDENTIAL_KEY.bindings[0].role).toBe("roles/secretmanager.viewer");
    expect(policies.CMS_PUBLISH_GITHUB_TOKEN.bindings.map(binding => binding.role)).toContain("roles/secretmanager.secretVersionAdder");
    const result = run("viewer");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["CMS_TRANSCRIPTION_CREDENTIAL_KEY", "CMS_PUBLISH_GITHUB_TOKEN"])("rejects conditional viewer or missing runtime access on %s", secret => {
    expect(run("conditional", secret).status).toBe(1);
    expect(run("missing", secret, "runtime").status).toBe(1);
  });

  it.each(["deploy", "runtime"])("rejects a conditional %s binding", role => {
    expect(run("conditional", "CUEZ_STORYDESK_API_KEY", role).status).toBe(1);
  });

  it.each(["unreadable", "malformed", "wrong-runtime", "wrong-deployer"])("fails closed for %s", mode => {
    expect(run(mode).status).toBe(1);
  });

  it("names the missing binding for an empty IAM policy", () => {
    expect(() => checkSecretIam(new Map([["CUEZ_STORYDESK_API_KEY", new Set([media])]]), () => "{}", deploy))
      .toThrow("Secret CUEZ_STORYDESK_API_KEY needs an unconditional roles/secretmanager.viewer or roles/secretmanager.admin");
  });

  it("checks the selected source tree with the current native discovery tool", () => {
    const checker = join(root, "scripts/check-cms-secret-iam.mjs");
    const calls = join(fixture, "historical-calls.jsonl");
    const result = spawnSync(process.execPath, [checker, fixture], { encoding: "utf8", env: {
      FIREBASE_DEPLOY_SERVICE_ACCOUNT: deploy, PATH: `${fixture}:${process.env.PATH}`, IAM_CALLS: calls, IAM_POLICIES: join(fixture, "policies.json"),
    } });
    expect(result.status, result.stderr).toBe(0);
  });

  it("runs discovery and IAM checks before storage, preview or deploy mutations", () => {
    const workflow = readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8");
    const check = workflow.indexOf("node scripts/component-runner.mjs functions verify-config");
    expect(check).toBeGreaterThan(0);
    for (const marker of ["Store the Studio connector in private media storage", "Mark the Functions receipt in progress",
      "site/scripts/deploy-cms-preview-cloud.ts pause", "npx --no-install firebase deploy"]) {
      expect(workflow.indexOf(marker)).toBeGreaterThan(check);
    }
    const adapter = readFileSync(join(root, "scripts/configure-cms-functions.mjs"), "utf8");
    expect(adapter).toContain('"resolve-cost-ledger-pulls.sh"');
    expect(adapter).toContain('"resolve-media-purge.sh"');
    expect(workflow).not.toContain("gcloud secrets add-iam-policy-binding");
  });
  it("reuses Firebase authentication and checks IAM before receipt completion", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/cms-staging-deploy.yml"), "utf8"));
    const steps = workflow.jobs.firebase.steps;
    const checker = steps.find(step => step.name === "Check out the trusted post-deploy IAM checker");
    expect(checker.with.ref).toBe("${{ github.sha }}");
    expect(checker.with.path).toBe(".cms-iam-gate");
    expect(checker.with["persist-credentials"]).toBe(false);
    expect(checker.with["sparse-checkout-cone-mode"]).toBe(false);
    expect(checker.with["sparse-checkout"].trim().split("\n")).toEqual([
      "scripts/check-cms-secret-iam.mjs", "scripts/lib/functions-deploy-inventory.mjs",
    ]);
    const setup = steps.findIndex(step => step.name === "Set up Google Cloud CLI for Functions IAM");
    const deploy = steps.findIndex(step => step.id === "deploy_functions");
    const check = steps.findIndex(step => step.name === "Verify event trigger IAM after deployment");
    const receipt = steps.findIndex(step => step.name === "Record the completed Functions receipt");
    expect(steps.some(step => step.uses?.startsWith("google-github-actions/auth@"))).toBe(false);
    expect(steps.some(step => step.with?.name === "cms-event-trigger-first-deploy")).toBe(false);
    expect(steps[setup]).toMatchObject({ uses: "google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db", with: { project_id: "njpbs-site" } });
    const isolate = steps.findIndex(step => step.name === "Isolate trusted event IAM gate");
    expect(steps[isolate].run).toBe('mv .cms-iam-gate "$RUNNER_TEMP/cms-iam-gate"');
    expect(isolate).toBeGreaterThan(steps.indexOf(checker));
    expect(check).toBeGreaterThan(isolate);
    expect(steps[check].run).toBe('node "$RUNNER_TEMP/cms-iam-gate/scripts/check-cms-secret-iam.mjs" "$GITHUB_WORKSPACE" --post-deploy');
    expect(setup).toBeGreaterThan(-1); expect(deploy).toBeGreaterThan(setup);
    expect(check).toBeGreaterThan(deploy); expect(receipt).toBeGreaterThan(check);
  });

});
