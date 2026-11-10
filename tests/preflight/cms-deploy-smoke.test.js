import { readCmsDeployWorkflow } from "../helpers/cms-deploy-workflow.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import {
  assertProductionManifest,
  AUTHENTICATED_POST_FUNCTION_NAMES,
  WORKER_FUNCTION_NAMES,
  PREMIERE_FUNCTION_NAMES,
  DEVICE_PAIRING_FUNCTION_NAMES,
  DEPLOYED_FUNCTION_NAMES,
  extractProductionExports,
  runCmsFunctionSmoke,
} from "../../scripts/smoke-cms-functions.mjs";
import { ENDPOINTS } from "../../cms-api/src/config.ts";
import { assertR2Lifecycle } from "../../scripts/assert-r2-lifecycle.mjs";
import { configurationInputs, CONFIGURATION_INPUTS, NATIVE_CONFIGURATION } from "../../scripts/lib/functions-configuration.mjs";
import { classifyPath } from "../../.github/scripts/ci-classifier.mjs";

const FUNCTIONS_INDEX = fileURLToPath(
  new URL("../../functions/index.js", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEPLOY_WORKFLOW = fileURLToPath(
  new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url),
);
const FIREBASE_CI = fileURLToPath(
  new URL("../../.github/workflows/firebase-ci.yml", import.meta.url),
);

const BASE_URL = "https://api.example.org";
const FUNCTIONS_ORIGIN = "https://us-central1-njpbs-site.cloudfunctions.net";
const ADMIN_ORIGIN = "https://admin.njpbs.org";
const VOICEOVER_FUNCTION_NAMES = Object.freeze([
  "cmsVoiceoverReview",
  "cmsGetVoiceoverAudio",
]);

function expectedResponseFor(url, init = {}) {
  const parsedUrl = new URL(url);
  if (parsedUrl.origin === ADMIN_ORIGIN) {
    return { status: 200, headers: new Headers() };
  }
  if (parsedUrl.origin === FUNCTIONS_ORIGIN) {
    return { status: 403, headers: new Headers() };
  }
  const endpoint = parsedUrl.pathname.slice(1);
  if (endpoint === "health") return { status: 200, headers: new Headers() };
  if ([...PREMIERE_FUNCTION_NAMES, ...DEVICE_PAIRING_FUNCTION_NAMES].includes(endpoint) && init.method === "GET") {
    return { status: 405, headers: new Headers() };
  }
  if (endpoint === "deactivateStaff" && init.method === "GET") {
    return { status: 405, headers: new Headers() };
  }
  if (endpoint === "deactivateStaff" && init.method === "OPTIONS") {
    return {
      status: 204,
      headers: new Headers({
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
        "access-control-allow-origin": ADMIN_ORIGIN,
      }),
    };
  }
  if (endpoint === "submitStaffAccessRequest" && init.method === "OPTIONS") {
    return {
      status: 204,
      headers: new Headers({
        "access-control-allow-headers":
          "authorization,content-type,x-firebase-appcheck",
        "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
        "access-control-allow-origin": ADMIN_ORIGIN,
      }),
    };
  }
  if (
    ["cmsUploadMedia", "cmsSubmitBugReport"].includes(endpoint) &&
    init.method === "OPTIONS"
  ) {
    return {
      status: 204,
      headers: new Headers({
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
        "access-control-allow-origin": ADMIN_ORIGIN,
      }),
    };
  }
  return { status: 401, headers: new Headers() };
}

function extractLiteralRunBlocks(workflow) {
  const lines = workflow.split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const runMatch = lines[index].match(/^(\s*)run:\s*\|\s*$/);
    if (!runMatch) continue;
    const runIndent = runMatch[1].length;
    const content = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const lineIndent = line.match(/^\s*/)[0].length;
      if (line.trim() !== "" && lineIndent <= runIndent) {
        index -= 1;
        break;
      }
      content.push(line);
    }
    const contentIndent = Math.min(
      ...content
        .filter((line) => line.trim() !== "")
        .map((line) => line.match(/^\s*/)[0].length),
    );
    blocks.push(
      content
        .map((line) => (line.trim() === "" ? "" : line.slice(contentIndent)))
        .join("\n"),
    );
  }

  return blocks;
}

// Skip installed dependencies before descending, as params.test.js does.
function runtimeParametersUnder(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return runtimeParametersUnder(path, `${relativePath}/`);
    if (!entry.name.endsWith(".js")) return [];
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(/define(?:String|Float|Int|Boolean|List)\(\s*["']([A-Z0-9_]+)["']/g)]
      .map(([, name]) => ({ path: relativePath, name }));
  });
}

let functionDiscovery;
function discoverFunctions() {
  // One isolated process keeps the SDK registry clean and shares the costly
  // entry-point load. Firebase discovery resolves every export, including getters.
  functionDiscovery ??= JSON.parse(execFileSync(process.execPath, ["-e", [
    'const params = require("firebase-functions/params");',
    "params.clearParams();",
    "delete process.env.FUNCTIONS_EMULATOR;",
    'const functions = require("./functions/index.js");',
    "for (const name of Object.keys(functions)) {",
    '  if (typeof functions[name] !== "function") throw new Error(`Missing Function ${name}`);',
    "}",
    "const secrets = params.declaredParams",
    "  .map((param) => param.toSpec?.() ?? param)",
    '  .filter((param) => param.type === "secret")',
    "  .map((param) => param.name)",
    "  .sort();",
    "const reader = functions.cmsGetPublishedPost.__endpoint;",
    "process.stdout.write(JSON.stringify({ secrets, reader }));",
  ].join("\n")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, METADATA_SERVER_DETECTION: "none" },
  }));
  return functionDiscovery;
}

describe("CMS deployment smoke gate", () => {
  it("requires the complete current export manifest and refuses unknown names", () => {
    const current = readFileSync(FUNCTIONS_INDEX, "utf8");
    expect(() => assertProductionManifest(current)).not.toThrow();
    const source = names => names.map(name => `exports.${name} = handler;`).join("\n");
    for (const missing of DEPLOYED_FUNCTION_NAMES) {
      expect(() => assertProductionManifest(source(DEPLOYED_FUNCTION_NAMES.filter(name => name !== missing)))).toThrow("missing:");
    }
    expect(() => assertProductionManifest(source([...DEPLOYED_FUNCTION_NAMES, "unexpectedHandler"]))).toThrow("unexpected: unexpectedHandler");
  });

  const runtimeParameters = runtimeParametersUnder(join(REPO_ROOT, "functions"));
  it.each([
    ["runtime record only", "", "", "", 0],
    ["default off", "false", "", "", 0],
    ["admission paused", "false", "pilot-post", "njpbs-pilot-background", 0],
    ["admission enabled", "true", "pilot-post", "njpbs-pilot-background", 0],
    ["invalid flag", "yes", "", "", 1],
    ["invalid ID", "false", "pilot/post", "njpbs-pilot-background", 1],
    ["invalid bucket", "false", "pilot-post", "private/bucket", 1],
    ["missing ID", "true", "", "njpbs-pilot-background", 1],
    ["orphan bucket", "false", "", "njpbs-pilot-background", 1],
    ["enabled without settings", "true", "", "", 1],
    ["missing bucket", "true", "pilot-post", "", 1],
    ["incomplete paused settings", "false", "pilot-post", "", 1],
  ])("writes every declared runtime parameter for noninteractive deployment: %s", (_label, enabled, postId, bucket, expectedStatus) => {
    const workflow = readCmsDeployWorkflow();
    const step = parse(workflow).jobs.firebase.steps.find(step => step.name === "Configure functions runtime params");
    const env = configurationInputs({});
    Object.assign(env, {
      CMS_MEDIA_R2_BUCKET: "fixture-media", CMS_MEDIA_CLOUDFLARE_ZONE_ID: "d".repeat(32),
      CMS_ADMIN_BUILD_REVISION: "a".repeat(40), CMS_PREVIEW_RENDERER_SHA: "b".repeat(40),
      VITE_LIVE_PRODUCTION_ENABLED: "false", VITE_CMS_STUDIO_CONFIGURATION: "",
      CMS_ANALYTICS_CF_ZONE_ID: "a".repeat(32),
      CMS_ANALYTICS_GA4_PROPERTY_ID: "",
      CMS_ANALYTICS_MAILCHIMP_AUDIENCE_ID: "b".repeat(10),
      CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
      CMS_BUG_REPORT_TELEGRAM_CHAT_ID: "12345",
      CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP: '{"12345":"fixture-user"}',
      TVSS_CALLSIGN: "teststation",
      PROXY_EXTRA_ORIGINS: "https://fixture.example",
      SHADOW_POST_READER_ENABLED: "true",
      SHADOW_POST_READER_SLUGS: "nj-pbs-announces-six-staff-appointments",
      NO_BUILD_POST_ENABLED: enabled,
      NO_BUILD_POST_ID: postId,
      NO_BUILD_POST_BACKGROUND_BUCKET: bucket,
    });
    const root = mkdtempSync(join(tmpdir(), "cms-deploy-params-"));
    try {
      mkdirSync(join(root, "functions"));
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "config"));
      copyFileSync(join(REPO_ROOT, "config/functions-deployment.json"), join(root, "config/functions-deployment.json"));
      copyFileSync(join(REPO_ROOT, "scripts/resolve-media-purge.sh"), join(root, "scripts/resolve-media-purge.sh"));
      copyFileSync(
        join(REPO_ROOT, "scripts/resolve-cost-ledger-pulls.sh"),
        join(root, "scripts/resolve-cost-ledger-pulls.sh"),
      );
      // The parameter block invokes the production title-file serializer.
      for (const filename of ["scripts/lib/studio-title-files.mjs", "agents/vmix/configuration.mjs"]) {
        mkdirSync(dirname(join(root, filename)), { recursive: true });
        copyFileSync(join(REPO_ROOT, filename), join(root, filename));
      }
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/component-runner.mjs"), "functions", "configure"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(expectedStatus);
      if (expectedStatus !== 0) {
        expect(result.stderr).toMatch(/Invalid (?:instant publication configuration|Functions configuration: NO_BUILD_POST_(?:ENABLED|ID|BACKGROUND_BUCKET))/);
        expect(existsSync(join(root, "functions/.env.njpbs-site"))).toBe(false);
        return;
      }
      const output = readFileSync(join(root, "functions/.env.njpbs-site"), "utf8");
      const written = new Set([...output.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
      for (const { path, name } of runtimeParameters) {
        expect(written.has(name), `${path}: ${name} missing from deploy environment`).toBe(true);
      }
      expect(output).toContain(`CMS_ANALYTICS_CF_ZONE_ID=${env.CMS_ANALYTICS_CF_ZONE_ID}\n`);
      expect(CONFIGURATION_INPUTS.SHADOW_POST_READER_ENABLED).toMatchObject({ variable: "SHADOW_POST_READER_ENABLED", default: "false" });
      expect(step.env.CMS_DEPLOYMENT_VARIABLES_JSON).toBe("${{ toJSON(vars) }}");
      expect(output).toContain('SHADOW_POST_READER_ENABLED=true\n');
      expect(output).toContain('SHADOW_POST_READER_SLUGS=nj-pbs-announces-six-staff-appointments\n');
      if (!enabled && !postId && !bucket) {
        expect(output).not.toMatch(/^NO_BUILD_POST_/m);
      } else {
        expect(output).toContain(`NO_BUILD_POST_ENABLED=${enabled}\n`);
        expect(output).toContain(`NO_BUILD_POST_ID=${postId}\n`);
        expect(output).toContain(`NO_BUILD_POST_BACKGROUND_BUCKET=${bucket}\n`);
      }
      expect(output).not.toMatch(/^PUBLISHED_POST_READER_HMAC_KEY=/m);
      const example = readFileSync(join(REPO_ROOT, "functions/.env.example"), "utf8");
      expect(example).toContain('SHADOW_POST_READER_ENABLED=false\n');
      expect(example).toContain('SHADOW_POST_READER_SLUGS=\n');
      expect(JSON.parse(readFileSync(join(root, "functions/cost-ledger-pulls.generated.json"), "utf8"))).toEqual({
        COST_LEDGER_GCP_PULL: false, COST_LEDGER_CLOUDFLARE_PULL: false,
        COST_LEDGER_AWS_PULL: false, COST_LEDGER_GITHUB_PULL: false,
      });
      const firebaseJob = workflow.split(/^  firebase:\s*$/m)[1].split(/^  [a-z][a-z-]*:\s*$/m)[0];
      const resolveAt = firebaseJob.indexOf("node scripts/component-runner.mjs functions configure");
      const deployAt = firebaseJob.indexOf("node scripts/component-runner.mjs functions deploy");
      expect(resolveAt).toBeGreaterThan(-1);
      expect(deployAt).toBeGreaterThan(resolveAt);
      expect(output).toContain("TVSS_CALLSIGN=teststation\n");
      expect(output).toContain("PROXY_EXTRA_ORIGINS=https://fixture.example\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it("passes Firebase deployment credentials to the secret metadata lookup", () => {
    const workflow = readCmsDeployWorkflow();
    const step = parse(workflow).jobs.firebase.steps.find(step => step.name === "Configure functions runtime params");
    const env = configurationInputs({});
    Object.assign(env, {
      CMS_MEDIA_R2_BUCKET: "fixture-media", CMS_MEDIA_CLOUDFLARE_ZONE_ID: "d".repeat(32),
      CMS_ADMIN_BUILD_REVISION: "a".repeat(40), CMS_PREVIEW_RENDERER_SHA: "b".repeat(40),
      VITE_LIVE_PRODUCTION_ENABLED: "false", VITE_CMS_STUDIO_CONFIGURATION: "",
      CMS_ANALYTICS_CF_ZONE_ID: "a".repeat(32),
      CMS_ANALYTICS_GA4_PROPERTY_ID: "",
      CMS_ANALYTICS_MAILCHIMP_AUDIENCE_ID: "b".repeat(10),
      CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
      CMS_BUG_REPORT_TELEGRAM_CHAT_ID: "12345",
      CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP: '{"12345":"fixture-user"}',
      TVSS_CALLSIGN: "teststation",
      PROXY_EXTRA_ORIGINS: "https://fixture.example",
      COST_LEDGER_GCP_PULL: "true",
      COST_LEDGER_GCP_PROJECT: "njpbs-site",
      COST_LEDGER_GCP_BILLING_TABLE: "njpbs-site.billing.gcp_billing_export_v1",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/firebase-service-account.json",
      NO_BUILD_POST_ENABLED: "false",
      NO_BUILD_POST_ID: "",
      NO_BUILD_POST_BACKGROUND_BUCKET: "",
    });
    const root = mkdtempSync(join(tmpdir(), "cms-deploy-cost-pulls-"));
    const bin = join(root, "bin");
    const marker = join(root, "gcloud-credential-path");
    try {
      mkdirSync(join(root, "functions"));
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "config"));
      copyFileSync(join(REPO_ROOT, "config/functions-deployment.json"), join(root, "config/functions-deployment.json"));
      copyFileSync(join(REPO_ROOT, "scripts/resolve-media-purge.sh"), join(root, "scripts/resolve-media-purge.sh"));
      mkdirSync(bin);
      copyFileSync(
        join(REPO_ROOT, "scripts/resolve-cost-ledger-pulls.sh"),
        join(root, "scripts/resolve-cost-ledger-pulls.sh"),
      );
      // The parameter block invokes the production title-file serializer.
      for (const filename of ["scripts/lib/studio-title-files.mjs", "agents/vmix/configuration.mjs"]) {
        mkdirSync(dirname(join(root, filename)), { recursive: true });
        copyFileSync(join(REPO_ROOT, filename), join(root, filename));
      }
      writeFileSync(
        join(bin, "gcloud"),
        `#!/usr/bin/node
if(process.env.CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP)process.exit(8); require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE); console.log("ENABLED");
`,
      );
      chmodSync(join(bin, "gcloud"), 0o755);
      execFileSync(process.execPath, [join(REPO_ROOT, "scripts/component-runner.mjs"), "functions", "configure"], {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          COST_PULL_CREDENTIAL_MARKER: marker,
          ...env,
        },
      });
      expect(readFileSync(marker, "utf8")).toBe("/tmp/firebase-service-account.json");
      expect(JSON.parse(readFileSync(join(root, "functions/cost-ledger-pulls.generated.json"), "utf8")).COST_LEDGER_GCP_PULL).toBe(true);
      expect(readFileSync(join(root, "functions/.env.njpbs-site"), "utf8")).toContain(
        "COST_LEDGER_GCP_PULL=true\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts lazyExport names alongside assignment exports", () => {
    expect(
      extractProductionExports(
        'lazyExport("cmsGetAnalytics", "./analytics");\nexports.health = health;\n',
      ),
    ).toEqual(["cmsGetAnalytics", "health"]);
  });

  it("keeps the smoke manifest equal to the production Firebase exports", () => {
    const indexSource = readFileSync(FUNCTIONS_INDEX, "utf8");

    expect(extractProductionExports(indexSource)).toEqual(
      [...DEPLOYED_FUNCTION_NAMES].sort(),
    );
  });

  it("requires an enabled reader secret version before deploy mutations without reading or provisioning a key", () => {
    const workflow = readCmsDeployWorkflow();
    const start = workflow.indexOf("- name: Require the provisioned published Post reader secret");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(workflow.indexOf("- name: Verify Admin App Check registration"));
    const script = extractLiteralRunBlocks(workflow.slice(start))[0];
    const root = mkdtempSync(join(tmpdir(), "cms-reader-secret-"));
    try {
      const command = join(root, "gcloud");
      writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "$*" > "$READER_CALL_LOG"\nprintf "%s" "$READER_SECRET_STATE"\nexit "$READER_SECRET_STATUS"\n');
      chmodSync(command, 0o700);
      const callLog = join(root, "calls.txt");
      const run = (state, status = "0", targets = "functions:cmsGetPublishedPost") =>
        execFileSync("bash", ["-c", script], { cwd: root, stdio: "pipe", env: {
          PATH: `${root}:${process.env.PATH}`, FUNCTION_TARGETS: targets,
          READER_SECRET_STATE: state, READER_SECRET_STATUS: status, READER_CALL_LOG: callLog,
        } });
      expect(() => run("ENABLED")).not.toThrow();
      expect(readFileSync(callLog, "utf8")).toBe(
        "secrets versions describe latest --secret=PUBLISHED_POST_READER_HMAC_KEY --project=njpbs-site --format=value(state)\n",
      );
      for (const state of ["DISABLED", "DESTROYED", ""]) expect(() => run(state)).toThrow();
      expect(() => run("", "1")).toThrow();
      rmSync(callLog);
      expect(() => run("", "1", "functions:health")).not.toThrow();
      expect(readdirSync(root)).not.toContain("calls.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("probes the pilot reader only with an unsigned GET that must return 403", async () => {
    const requests = [];
    const url = `${FUNCTIONS_ORIGIN}/cmsGetPublishedPost/posts/nj-pbs-announces-six-staff-appointments/`;
    const run = (status) => runCmsFunctionSmoke({ request: async (target, init = {}) => {
      requests.push({ url: target, init });
      return target === url ? { status } : expectedResponseFor(target, init);
    } });
    await expect(run(403)).resolves.toEqual({ checked: 296 });
    expect(requests.filter(({ url: target }) => target.includes("cmsGetPublishedPost"))).toEqual([
      { url, init: { method: "GET", redirect: "manual" } },
    ]);
    await expect(run(200)).rejects.toThrow();
    await expect(run(404)).rejects.toThrow();
  });

  it("keeps the CMS edge allowlist equal to the deployed client Functions", () => {
    // In production the Admin app reaches Cloud Functions only through the CMS
    // API worker, whose endpointPolicy 404s any path it does not know.
    // A missing route is unreachable; an extra route targets an undeployed
    // Function. The production manifest check above binds this list to exports.
    expect(Object.keys(ENDPOINTS).sort()).toEqual(
      [...AUTHENTICATED_POST_FUNCTION_NAMES, ...WORKER_FUNCTION_NAMES, ...PREMIERE_FUNCTION_NAMES, ...DEVICE_PAIRING_FUNCTION_NAMES].sort(),
    );
    for (const name of [
      "cmsGetAuthorProfile",
      "cmsUpdateAuthorProfile",
      "cmsSetAuthorProfileVisibility",
      "cmsListAuthorProfiles",
      "cmsAdminUpdateAuthorProfile",
    ]) {
      expect(AUTHENTICATED_POST_FUNCTION_NAMES).toContain(name);
      expect(ENDPOINTS[name].contentType).toBe("json");
      // Only account recovery is reachable without a verified caller.
      expect(ENDPOINTS[name].auth).toBeUndefined();
    }
  });

  it("keeps machine transcription endpoints on dedicated edge routes", () => {
    expect(WORKER_FUNCTION_NAMES).toEqual([
      "videoTranscriptWorkerClaim", "videoTranscriptWorkerHeartbeat",
      "videoTranscriptWorkerComplete", "videoTranscriptWorkerFail",
    ]);
    for (const endpoint of WORKER_FUNCTION_NAMES) {
      expect(DEPLOYED_FUNCTION_NAMES).toContain(endpoint);
      expect(AUTHENTICATED_POST_FUNCTION_NAMES).not.toContain(endpoint);
      expect(ENDPOINTS[endpoint]).toMatchObject({ contentType: "json", rateClass: "worker", auth: "worker" });
    }
  });

  it("routes manifest-scoped cleanup through the original attempt runner", () => {
    const workflow = readCmsDeployWorkflow();
    expect(workflow).toContain("Prepare the original Functions retirement plan");
    expect(workflow).toContain("node scripts/component-runner.mjs functions prepare");
    expect(workflow).toContain("node scripts/component-runner.mjs functions deploy");
    expect(workflow).not.toContain("firebase functions:delete");
    expect(workflow).not.toContain("rollback_without_staff_site:");
  });

  it("probes desktop and studio pairing methods without creating codes or requiring enabled features", async () => {
    expect(PREMIERE_FUNCTION_NAMES).toEqual([
      "cmsStartPremierePairing", "cmsApprovePremierePairing", "cmsPollPremierePairing",
      "cmsPremiereRequest", "cmsRevokePremiereSession",
    ]);
    const requests = [];
    await runCmsFunctionSmoke({
      request: async (url, init = {}) => {
        requests.push({ url, init });
        return expectedResponseFor(url, init);
      },
    });
    expect(DEVICE_PAIRING_FUNCTION_NAMES).toEqual(["cmsPairLiveProductionDevice"]);
    for (const name of [...PREMIERE_FUNCTION_NAMES, ...DEVICE_PAIRING_FUNCTION_NAMES]) {
      expect(AUTHENTICATED_POST_FUNCTION_NAMES).not.toContain(name);
      const probes = requests.filter(({ url }) => new URL(url).pathname === `/${name}`);
      expect(probes).toEqual([
        { url: `${BASE_URL}/${name}`, init: {
          method: "GET", redirect: "manual", headers: { origin: ADMIN_ORIGIN },
        } },
        { url: `${FUNCTIONS_ORIGIN}/${name}`, init: {
          method: "POST", redirect: "manual",
          headers: { "content-type": "application/json", origin: ADMIN_ORIGIN }, body: "{}",
        } },
      ]);
    }
  });

  // #2652: Discovery took 13.7 s under load. Keep the 60 s allowance
  // for shared discovery, with the same runaway guard on the child.
  it("keeps preview discovery from declaring the deferred billing alert secret", () => {
    const discovered = discoverFunctions().secrets;

    // Existing names were characterized from origin/main. The private video
    // pair scopes remain explicit in the endpoint contract.
    // Keep the undeployed billing alert absent and cover every lazy export.
    expect(discovered).toEqual([
      "CMS_ANALYTICS_CF_TOKEN",
      "CMS_ANALYTICS_MAILCHIMP_KEY",
      "CMS_BUG_REPORT_GITHUB_TOKEN",
      "CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET",
      "CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN",
      "CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET",
      "CMS_EDGE_ORIGIN_SECRET",
      "CMS_MEDIA_CACHE_PURGE_TOKEN",
      "CMS_MEDIA_R2_ACCESS_KEY_ID",
      "CMS_MEDIA_R2_SECRET_ACCESS_KEY",
      "CMS_PRIVATE_VIDEO_R2_READ_ACCESS_KEY_ID",
      "CMS_PRIVATE_VIDEO_R2_READ_SECRET_ACCESS_KEY",
      "CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID",
      "CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY",
      "CMS_PUBLISH_GITHUB_TOKEN",
      "CMS_STAFF_EMAIL_API_TOKEN",
      "CMS_TRANSCRIPTION_CREDENTIAL_KEY",
      "CMS_VOICEOVER_R2_ACCESS_KEY_ID",
      "CMS_VOICEOVER_R2_SECRET_ACCESS_KEY",
      "CUEZ_STORYDESK_API_KEY",
      "PUBLISHED_POST_READER_HMAC_KEY",
      "UGC_R2_ACCESS_KEY_ID",
      "UGC_R2_SECRET_ACCESS_KEY",
    ]);
  }, 60_000);

  it("exports the pilot reader with the approved account, public invoker and named secret", () => {
    const endpoint = discoverFunctions().reader;
    expect(endpoint).toMatchObject({
      serviceAccountEmail: "njpbs-published-post-reader@njpbs-site.iam.gserviceaccount.com",
      httpsTrigger: { invoker: ["public"] },
      secretEnvironmentVariables: [{ key: "PUBLISHED_POST_READER_HMAC_KEY" }],
    });
    expect(DEPLOYED_FUNCTION_NAMES).toContain("cmsGetPublishedPost");
    expect(ENDPOINTS).not.toHaveProperty("cmsGetPublishedPost");
  });

  it("uses only unauthenticated probes without real staff or content targets", async () => {
    const requests = [];
    const request = vi.fn(async (url, init = {}) => {
      requests.push({ url, init });
      return expectedResponseFor(url, init);
    });

    await expect(
      runCmsFunctionSmoke({
        baseUrl: BASE_URL,
        adminOrigin: ADMIN_ORIGIN,
        request,
      }),
    ).resolves.toEqual({ checked: 296 });

    expect(requests.map(({ url }) => new URL(url).pathname.slice(1))).toEqual([
      "health",
      "cmsCuezStatus",
      "cmsCuezListDestinations",
      "cmsCuezPrepareExport",
      "cmsCuezSendExport",
      "cmsCuezOperationStatus",
      "cmsCuezListImportCandidates",
      "cmsCuezPreviewImport",
      "cmsCuezConfirmImport",
      "cmsCuezRetry",
      "cmsCuezReconcile",
      "grantRole",
      "revokeRole",
      "setStaffAccessLevel",
      "deactivateStaff",
      "reactivateStaff",
      "registerStaffProfile",
      "cmsSetNavigationPreferences",
      "submitStaffAccessRequest",
      "requestStaffPasswordReset",
      "getStaffAccessStatus",
      "listStaffAccessRequests",
      "decideStaffAccessRequest",
      "cmsSaveContent",
      "cmsGetContent",
      "cmsPostTemplates",
      "cmsDatasets",
      "cmsElectionResultsSources",
      "cmsLiveProduction",
      "cmsRundownSource",
      "cmsRundownParser",
      "cmsRundownReview",
      "cmsLiveProductionAgent",
      "cmsLiveProductionDevices",
      "cmsGetBroadcastSchedule",
      "cmsGetNewsroomBanner",
      "cmsVoiceoverReview",
      "cmsGetVoiceoverAudio",
      "cmsGetSettings",
      "cmsGetCoverageLabels",
      "cmsPublishSettings",
      "cmsSaveSettings",
      "cmsCostLedger",
      "cmsListRevisions",
      "cmsGetRevision",
      "cmsRestoreRevision",
      "cmsTransitionContent",
      "cmsListContent",
      "cmsListMedia",
      "cmsListBinnedMedia",
      "cmsRestoreMedia",
      "cmsReplaceMediaBinary",
      "cmsListMediaSources",
      "cmsListSourceMedia",
      "cmsListMediaFavorites",
      "cmsSetMediaFavorite",
      "cmsSetMediaFavorites",
      "cmsListMediaCollections",
      "cmsListMediaCollectionItems",
      "cmsMutateMediaCollection",
      "cmsSetMediaCollectionItems",
      "cmsGetMediaReview",
      "cmsSaveMediaReview",
      "cmsListMediaComments",
      "cmsMutateMediaComment",
      "cmsCreateSourceMediaRead",
      "cmsSourceMediaOriginal",
      "cmsPublishSourceVideo",
      "cmsRequestVideoClip",
      "cmsGetVideoClip",
      "cmsCreateVideoClipRead",
      "cmsCancelVideoClip",
      "cmsRequestVideoTranscript",
      "cmsGetVideoTranscript",
      "cmsGetVideoSearchCorpus",
      "cmsCreateVideoTranscriptRead",
      "cmsSaveVideoTranscript",
      "cmsRequestVideoTranscriptAlignment",
      "cmsCancelVideoTranscriptAlignment",
      "cmsRequestVideoOrientationExport",
      "cmsListVideoOrientationExports",
      "cmsListTranscriptionCredentials",
      "cmsSaveTranscriptionCredential",
      "cmsDisconnectTranscriptionCredential",
      "cmsGetTranscriptionOptions",
      "cmsRequestByokVideoTranscript",
      "cmsListVideoTranscripts",
      "cmsStartSourceMediaUpload",
      "cmsSignSourceMediaUploadParts",
      "cmsResumeSourceMediaUpload",
      "cmsCompleteSourceMediaUpload",
      "cmsCancelSourceMediaUpload",
      "cmsGetSourceVideoReplacement",
      "cmsRollbackSourceVideoReplacement",
      "cmsDeleteSourceMedia",
      "cmsUpdateSourceMediaMetadata",
      "cmsListMediaUsage",
      "cmsListMediaCategories",
      "cmsMutateMediaCategory",
      "cmsUpdateMediaMetadata",
      "cmsCreateMediaDownload",
      "cmsUploadMedia",
      "cmsListUgcSubmissions",
      "cmsGetUgcSubmissionPreview",
      "cmsRejectUgcSubmission",
      "cmsImportUgcSubmission",
      "cmsSubmitBugReport",
      "cmsListBugReports",
      "cmsNudgeBugReport",
      "cmsGetBugReport",
      "cmsGetBugReportEvidence",
      "cmsListGithubIssues",
      "cmsGetGithubIssue",
      "cmsScanMediaUsage",
      "cmsBulkArchiveContent",
      "cmsAssignContent",
      "cmsListAudit",
      "cmsGetAnalytics",
      "cmsCollectBoardwalkUsage",
      "cmsGetBoardwalkUsage",
      "cmsPreview",
      "cmsPreviewStatus",
      "cmsPublish",
      "cmsRecheckPublication",
      "cmsGetAuthorProfile",
      "cmsUpdateAuthorProfile",
      "cmsSetAuthorProfileVisibility",
      "cmsListBylineAuthors",
      "cmsListAuthorPagePosts",
      "cmsListAuthorProfiles",
      "cmsAdminUpdateAuthorProfile",
      "cmsCuezStatus",
      "cmsCuezListDestinations",
      "cmsCuezPrepareExport",
      "cmsCuezSendExport",
      "cmsCuezOperationStatus",
      "cmsCuezListImportCandidates",
      "cmsCuezPreviewImport",
      "cmsCuezConfirmImport",
      "cmsCuezRetry",
      "cmsCuezReconcile",
      "grantRole",
      "revokeRole",
      "setStaffAccessLevel",
      "deactivateStaff",
      "reactivateStaff",
      "registerStaffProfile",
      "cmsSetNavigationPreferences",
      "submitStaffAccessRequest",
      "requestStaffPasswordReset",
      "getStaffAccessStatus",
      "listStaffAccessRequests",
      "decideStaffAccessRequest",
      "cmsSaveContent",
      "cmsGetContent",
      "cmsPostTemplates",
      "cmsDatasets",
      "cmsElectionResultsSources",
      "cmsLiveProduction",
      "cmsRundownSource",
      "cmsRundownParser",
      "cmsRundownReview",
      "cmsLiveProductionAgent",
      "cmsLiveProductionDevices",
      "cmsGetBroadcastSchedule",
      "cmsGetNewsroomBanner",
      "cmsVoiceoverReview",
      "cmsGetVoiceoverAudio",
      "cmsGetSettings",
      "cmsGetCoverageLabels",
      "cmsPublishSettings",
      "cmsSaveSettings",
      "cmsCostLedger",
      "cmsListRevisions",
      "cmsGetRevision",
      "cmsRestoreRevision",
      "cmsTransitionContent",
      "cmsListContent",
      "cmsListMedia",
      "cmsListBinnedMedia",
      "cmsRestoreMedia",
      "cmsReplaceMediaBinary",
      "cmsListMediaSources",
      "cmsListSourceMedia",
      "cmsListMediaFavorites",
      "cmsSetMediaFavorite",
      "cmsSetMediaFavorites",
      "cmsListMediaCollections",
      "cmsListMediaCollectionItems",
      "cmsMutateMediaCollection",
      "cmsSetMediaCollectionItems",
      "cmsGetMediaReview",
      "cmsSaveMediaReview",
      "cmsListMediaComments",
      "cmsMutateMediaComment",
      "cmsCreateSourceMediaRead",
      "cmsSourceMediaOriginal",
      "cmsPublishSourceVideo",
      "cmsRequestVideoClip",
      "cmsGetVideoClip",
      "cmsCreateVideoClipRead",
      "cmsCancelVideoClip",
      "cmsRequestVideoTranscript",
      "cmsGetVideoTranscript",
      "cmsGetVideoSearchCorpus",
      "cmsCreateVideoTranscriptRead",
      "cmsSaveVideoTranscript",
      "cmsRequestVideoTranscriptAlignment",
      "cmsCancelVideoTranscriptAlignment",
      "cmsRequestVideoOrientationExport",
      "cmsListVideoOrientationExports",
      "cmsListTranscriptionCredentials",
      "cmsSaveTranscriptionCredential",
      "cmsDisconnectTranscriptionCredential",
      "cmsGetTranscriptionOptions",
      "cmsRequestByokVideoTranscript",
      "cmsListVideoTranscripts",
      "cmsStartSourceMediaUpload",
      "cmsSignSourceMediaUploadParts",
      "cmsResumeSourceMediaUpload",
      "cmsCompleteSourceMediaUpload",
      "cmsCancelSourceMediaUpload",
      "cmsGetSourceVideoReplacement",
      "cmsRollbackSourceVideoReplacement",
      "cmsDeleteSourceMedia",
      "cmsUpdateSourceMediaMetadata",
      "cmsListMediaUsage",
      "cmsListMediaCategories",
      "cmsMutateMediaCategory",
      "cmsUpdateMediaMetadata",
      "cmsCreateMediaDownload",
      "cmsUploadMedia",
      "cmsListUgcSubmissions",
      "cmsGetUgcSubmissionPreview",
      "cmsRejectUgcSubmission",
      "cmsImportUgcSubmission",
      "cmsSubmitBugReport",
      "cmsListBugReports",
      "cmsNudgeBugReport",
      "cmsGetBugReport",
      "cmsGetBugReportEvidence",
      "cmsListGithubIssues",
      "cmsGetGithubIssue",
      "cmsScanMediaUsage",
      "cmsBulkArchiveContent",
      "cmsAssignContent",
      "cmsListAudit",
      "cmsGetAnalytics",
      "cmsCollectBoardwalkUsage",
      "cmsGetBoardwalkUsage",
      "cmsPreview",
      "cmsPreviewStatus",
      "cmsPublish",
      "cmsRecheckPublication",
      "cmsGetAuthorProfile",
      "cmsUpdateAuthorProfile",
      "cmsSetAuthorProfileVisibility",
      "cmsListBylineAuthors",
      "cmsListAuthorPagePosts",
      "cmsListAuthorProfiles",
      "cmsAdminUpdateAuthorProfile",
      ...WORKER_FUNCTION_NAMES.flatMap((name) => [name, name]),
      ...PREMIERE_FUNCTION_NAMES.flatMap((name) => [name, name]),
      ...DEVICE_PAIRING_FUNCTION_NAMES.flatMap((name) => [name, name]),
      "cmsReaderV1",
      "cmsReaderV2",
      "cmsReadPairCurrentCodeV2",
      "cmsGetPublicPage",
      "cmsValidateSiteAccess",
      "ugcGetConfig",
      "ugcStartSubmission",
      "ugcCompleteSubmission",
      "cmsGetPublishedPost/posts/nj-pbs-announces-six-staff-appointments/",
      "deactivateStaff",
      "deactivateStaff",
      "submitStaffAccessRequest",
      "cmsUploadMedia",
      "cmsSubmitBugReport",
      "",
    ]);

    for (const { init } of requests) {
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
    }

    const posts = requests.filter(({ init }) => init.method === "POST");
    expect(posts).toHaveLength(282);
    const multipartPosts = posts.filter(
      ({ url }) =>
        new URL(url).origin === BASE_URL &&
        ["/cmsUploadMedia", "/cmsReplaceMediaBinary", "/cmsSubmitBugReport"].includes(
          new URL(url).pathname,
        ),
    );
    expect(multipartPosts).toHaveLength(3);
    for (const multipartPost of multipartPosts) {
      expect(multipartPost.init.body).toBeInstanceOf(FormData);
      expect(new Headers(multipartPost.init.headers).has("content-type")).toBe(
        false,
      );
    }

    const jsonPosts = posts.filter((post) => !multipartPosts.includes(post));
    expect(jsonPosts).toHaveLength(279);
    const privatePosts = jsonPosts.filter(
      ({ url }) =>
        (new URL(url).origin === FUNCTIONS_ORIGIN &&
          ["/cmsReaderV1", "/cmsReaderV2", "/cmsReadPairCurrentCodeV2", "/cmsGetPublicPage", "/cmsValidateSiteAccess", "/ugcGetConfig",
            "/ugcStartSubmission", "/ugcCompleteSubmission"].includes(new URL(url).pathname)) ||
        WORKER_FUNCTION_NAMES.includes(new URL(url).pathname.slice(1)),
    );
    expect(privatePosts).toHaveLength(16);
    for (const post of privatePosts) expect(new Headers(post.init.headers).has("origin")).toBe(false);
    for (const { init } of jsonPosts.filter((post) => !privatePosts.includes(post))) {
      expect(init.body).toBe("{}");
      expect(new Headers(init.headers).get("origin")).toBe(ADMIN_ORIGIN);
    }

    const preflight = requests.find(({ init }) => init.method === "OPTIONS");
    expect(
      new Headers(preflight.init.headers).get("access-control-request-headers"),
    ).toBe("authorization,content-type");

    const uploadPreflight = requests.find(
      ({ url, init }) =>
        init.method === "OPTIONS" &&
        new URL(url).pathname.slice(1) === "cmsUploadMedia",
    );
    expect(
      uploadPreflight,
      "cmsUploadMedia preflight probe missing",
    ).toBeDefined();
    const uploadPreflightHeaders = new Headers(uploadPreflight.init.headers);
    expect(uploadPreflightHeaders.get("origin")).toBe(ADMIN_ORIGIN);
    expect(uploadPreflightHeaders.get("access-control-request-method")).toBe(
      "POST",
    );
    expect(uploadPreflightHeaders.get("access-control-request-headers")).toBe(
      "authorization,content-type",
    );
    expect(
      requests.some(
        ({ url, init }) =>
          init.method === "OPTIONS" &&
          new URL(url).pathname === "/cmsSubmitBugReport",
      ),
      "cmsSubmitBugReport preflight probe missing",
    ).toBe(true);
  });

  it("fails immediately when an authorization boundary returns the wrong status", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 200 });

    await expect(
      runCmsFunctionSmoke({
        baseUrl: BASE_URL,
        adminOrigin: ADMIN_ORIGIN,
        request,
      }),
    ).rejects.toThrow(
      "cmsCuezStatus unauthenticated POST returned 200; expected 401",
    );
    expect(request).toHaveBeenCalledTimes(2);
    await expect(runCmsFunctionSmoke({ baseUrl: BASE_URL, request: async () => { throw Error("synthetic-private-provider-body"); } }))
      .rejects.toMatchObject({ message: "health request failed" });
  });

  it("refuses a configured functions URL other than the production bare origin", async () => {
    const request = vi.fn();

    await expect(
      runCmsFunctionSmoke({
        baseUrl: `${BASE_URL}/`,
        adminOrigin: ADMIN_ORIGIN,
        request,
      }),
    ).rejects.toThrow(
      "CMS API URL must match CMS_PRODUCTION_API_ORIGIN",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("fails when a 204 preflight omits browser-required CORS headers", async () => {
    const request = vi.fn(async (url, init = {}) => {
      const response = expectedResponseFor(url, init);
      if (init.method === "OPTIONS") {
        response.headers = new Headers({
          "access-control-allow-methods": "POST",
          "access-control-allow-origin": ADMIN_ORIGIN,
        });
      }
      return response;
    });

    await expect(
      runCmsFunctionSmoke({
        baseUrl: BASE_URL,
        adminOrigin: ADMIN_ORIGIN,
        request,
      }),
    ).rejects.toThrow(
      "deactivateStaff preflight missing access-control-allow-headers value authorization",
    );
  });

  it("keeps source, dependency and identity checks around component deployment", () => {
    const workflow = readCmsDeployWorkflow();
    const gateCheckout = workflow.indexOf("path: .cms-smoke-gate");
    const manifestCheck = workflow.indexOf(
      "node scripts/component-runner.mjs functions manifest",
    );
    const firebaseDeploy = workflow.indexOf(
      "Deploy Firebase rules, indexes, and functions",
    );
    const smoke = workflow.indexOf("node scripts/component-runner.mjs functions smoke");
    const edgeDeploy = workflow.indexOf("Deploy CMS API Worker");
    const edgeSecret = workflow.indexOf("Verify Functions configuration without provider writes");

    expect(gateCheckout).toBeGreaterThan(-1);
    expect(workflow).toContain(
      "ref: ${{ github.sha }}\n          path: .cms-smoke-gate",
    );
    expect(manifestCheck).toBeGreaterThan(gateCheckout);
    expect(firebaseDeploy).toBeGreaterThan(manifestCheck);
    expect(edgeDeploy).toBeGreaterThan(-1);
    expect(edgeSecret).toBeLessThan(edgeDeploy);
    expect(firebaseDeploy).toBeGreaterThan(-1);
    expect(firebaseDeploy).toBeGreaterThan(edgeSecret);
    const cmsApiJob = workflow.slice(
      workflow.indexOf("\n  cms-api:"),
      workflow.indexOf("\n  firebase:"),
    );
    const firebaseJob = workflow.slice(
      workflow.indexOf("\n  firebase:"),
      workflow.indexOf("\n  live-smoke:"),
    );
    const identityGate = firebaseJob.indexOf("Require pinned release and trusted workflow identities");
    const sourceScan = firebaseJob.indexOf(
      "node \"$RUNNER_TEMP/metered-api-gate\"/.github/scripts/metered-api-scan.mjs --target-root \"$GITHUB_WORKSPACE\"",
    );
    expect(identityGate).toBeGreaterThan(-1);
    expect(sourceScan).toBeGreaterThan(identityGate);
    expect(firebaseJob.indexOf("npm ci --ignore-scripts")).toBeGreaterThan(sourceScan);
    expect(firebaseJob.indexOf("node scripts/component-runner.mjs functions deploy")).toBeGreaterThan(sourceScan);
    expect(cmsApiJob).toContain(
      "needs: [admin-build, firebase-preflight, firebase]",
    );
    expect(firebaseJob).toContain(
      "needs: [admin-build, firebase-preflight, smoke-manifest, verify]",
    );
    expect(firebaseJob).not.toContain("needs: [admin-build, cms-api");
    const deployCommand = workflow.slice(firebaseDeploy, smoke);
    const targetValidation = deployCommand.indexOf('[[ ! "$FUNCTION_TARGETS" =~');
    const firestoreDeployStart = deployCommand.indexOf("npx --no-install firebase deploy");
    const functionDeployStart = deployCommand.indexOf("node scripts/component-runner.mjs functions deploy", firestoreDeployStart);
    expect(targetValidation).toBeGreaterThan(-1);
    expect(firestoreDeployStart).toBeGreaterThan(targetValidation);
    expect(functionDeployStart).toBeGreaterThan(firestoreDeployStart);
    const firestoreDeployInvocation = deployCommand.slice(firestoreDeployStart, functionDeployStart);
    expect(firestoreDeployInvocation).toContain('--only "firestore:rules,firestore:indexes,storage"');
    expect(firestoreDeployInvocation).toContain("--non-interactive");
    expect(firestoreDeployInvocation).not.toContain("--force");
    expect(deployCommand).not.toContain("firebase functions:delete");
    expect(smoke).toBeGreaterThan(firebaseDeploy);
    expect(workflow).toContain("node scripts/component-runner.mjs functions smoke");
    expect(workflow).not.toContain('if [ "$DEPLOY_SHA" != "$GATE_SHA" ]');
    expect(workflow).toContain("Boardwalk account alerts require a configured private recipient");
    expect(workflow).toContain(
      "VITE_FUNCTIONS_BASE_URL: ${{ vars.VITE_FUNCTIONS_BASE_URL || secrets.VITE_FUNCTIONS_BASE_URL }}",
    );
    expect(workflow).toContain(
      "VITE_CMS_PREVIEW_ENABLED: ${{ vars.VITE_CMS_PREVIEW_ENABLED || 'false' }}",
    );
    expect(workflow).toContain(
      "CMS_PREVIEW_ACCESS_VERIFIED: ${{ vars.CMS_PREVIEW_ACCESS_VERIFIED || 'false' }}",
    );
    expect(workflow).not.toContain("CMS_PREVIEW_WRITEBACK_CONFIGURED");
    expect(workflow).toContain(
      "CMS_PREVIEW_TRANSPORT: ${{ vars.CMS_PREVIEW_TRANSPORT || 'serializer' }}",
    );
    expect(workflow).toContain(
      "CMS_PREVIEW_SERIALIZER_READY: ${{ vars.CMS_PREVIEW_SERIALIZER_READY || 'false' }}",
    );
    expect(workflow).toContain(
      "CMS_PREVIEW_TRANSPORT must be serializer",
    );
    expect(workflow).toContain("Verify the report relay");
    expect(workflow).toContain("getMe");
    expect(workflow).toContain("getWebhookInfo");
    expect(workflow).toContain("CMS_BUG_REPORT_TELEGRAM_BOT_ID");
    expect(workflow).toContain("CMS_BUG_REPORT_TELEGRAM_BOT_USERNAME");
    expect(workflow).not.toContain("/setWebhook");
    expect(workflow).not.toContain("/deleteWebhook");
    expect(workflow).toContain(
      "CMS_PREVIEW_SERIALIZER_READY must be true for the serializer preview transport",
    );
    expect(CONFIGURATION_INPUTS).toHaveProperty("CMS_PREVIEW_TRANSPORT");
    expect(CONFIGURATION_INPUTS).toHaveProperty("CMS_PREVIEW_SERIALIZER_READY");
    expect(workflow).toContain(
      "CMS_PUBLISH_TRANSPORT: ${{ vars.CMS_PUBLISH_TRANSPORT || 'github' }}",
    );
    expect(workflow).toContain("github|serializer) ;;");
    expect(CONFIGURATION_INPUTS).toHaveProperty("CMS_PUBLISH_TRANSPORT");
    expect(workflow).toContain(
      "CLOUDFLARE_API_TOKEN: ${{ secrets.CMS_ADMIN_ACCESS_API_TOKEN }}",
    );
    expect(parse(workflow).jobs["smoke-manifest"].needs).toBe("admin-build");
    expect(parse(workflow).jobs["firebase-preflight"].needs).toEqual(["admin-build", "smoke-manifest", "verify"]);
    expect(workflow).toContain("force_firebase:");
    expect(workflow).toContain("node scripts/component-runner.mjs functions plan");
    expect(workflow).toContain("node scripts/component-runner.mjs functions verify");
    expect(workflow).toContain("CMS_FUNCTION_DEPLOY_TARGETS: ${{ vars.CMS_PREVIEW_CLOUD_ENABLED == 'true' && needs.firebase-preflight.outputs.preview_pause_late == 'true' && needs.firebase-preflight.outputs.functions_during_preview || needs.firebase-preflight.outputs.function_deploy_targets }}");
    expect(workflow).toContain("CMS_PREVIEW_RENDERER_SHA: ${{ needs.firebase-preflight.outputs.renderer_target_sha }}");
    expect(workflow.indexOf("Revalidate the selective release baseline before mutation"))
      .toBeLessThan(workflow.indexOf("Mark the Functions receipt in progress"));
    // The cms-api job plans its own Worker release, so a partial rerun recomputes
    // it. Only an explicit false skips the Worker; any other value deploys it.
    const workerJob = workflow.slice(workflow.indexOf("\n  cms-api:\n"), workflow.indexOf("\n  firebase:\n"));
    const planAt = workerJob.indexOf("- name: Plan the CMS API Worker release");
    expect(planAt).toBeGreaterThan(workerJob.indexOf("- name: Prepare CMS API Worker secrets file"));
    expect(planAt).toBeLessThan(workerJob.indexOf("- name: Mark the CMS API receipt in progress"));
    const plan = workerJob.slice(planAt, workerJob.indexOf("- name: Mark the CMS API receipt in progress"));
    expect(plan).toContain("component-runner.mjs cmsApi plan");
    expect(plan).not.toContain("FUNCTIONS_MUTATED:");
    expect(plan).toContain("--configuration-fingerprint-file");
    expect(plan).toContain("CMS_EDGE_ORIGIN_SECRET_FINGERPRINT: ${{ needs.firebase-preflight.outputs.edge_origin_secret_fingerprint }}");
    const functionsPlan = workflow.slice(workflow.indexOf("- name: Plan Functions and renderer release"),
      workflow.indexOf("- name: Verify the report relay", workflow.indexOf("- name: Plan Functions and renderer release")));
    expect(functionsPlan).toContain("CMS_EDGE_ORIGIN_SECRET: ${{ secrets.CMS_EDGE_ORIGIN_SECRET }}");
    expect(workflow).toContain("edge_origin_secret_fingerprint: ${{ steps.release_plan.outputs.edge_origin_secret_fingerprint }}");
    expect(workflow).toContain("functions_configuration_fingerprint: ${{ steps.release_plan.outputs.functions_configuration_fingerprint }}");
    const functionsRecord = workflow.slice(workflow.indexOf("- name: Record the completed Functions receipt"),
      workflow.indexOf("- name: Verify live Functions inventory without mutating"));
    expect(functionsRecord).toContain("FUNCTIONS_CONFIGURATION_FINGERPRINT: ${{ needs.firebase-preflight.outputs.functions_configuration_fingerprint }}");
    expect(functionsRecord).toContain('--configuration-fingerprint "$FUNCTIONS_CONFIGURATION_FINGERPRINT"');
    for (const step of ["Mark the CMS API receipt in progress", "Deploy CMS API Worker", "Record the completed CMS API receipt"]) {
      const body = workerJob.slice(workerJob.indexOf(`- name: ${step}`));
      expect(body.split("\n")[1]).toContain("if: steps.cms_api_plan.outputs.mutated != 'false'");
    }
    const record = workerJob.slice(workerJob.indexOf("- name: Record the completed CMS API receipt"));
    expect(record.slice(0, record.indexOf("- name:", 10))).toContain("--configuration-fingerprint-file");
    const confirm = workerJob.slice(workerJob.indexOf("- name: Confirm the live CMS API identity"));
    expect(confirm).toContain("if: steps.cms_api_plan.outputs.mutated == 'false'");
    expect(confirm).toContain("component-runner.mjs cmsApi confirm");
    expect(workflow).not.toContain("cms_api_mutated");
    expect(workflow).toContain("Deploy Firestore and Storage rules without Functions");
    expect(workflow).toContain("firestore:rules,firestore:indexes,storage");
    expect(workflow).toContain("component-runner.mjs functions confirm");
    expect(workflow).toContain("component-runner.mjs renderer confirm");
    expect(workflow).toContain("node scripts/component-runner.mjs functions plan");
    expect(workflow).toContain("Recheck live Functions identity before Admin upload");
    expect(workflow).toContain("functions confirm --source-sha");
    expect(workflow).toContain(
      "RENDERER_TARGET_SHA: ${{ needs.firebase-preflight.outputs.renderer_target_sha }}",
    );
    expect(workflow).not.toContain("Stage current receipt helper");
    expect(parse(workflow).jobs["preview-renderer"].needs).toEqual(["admin-build", "firebase", "firebase-preflight"]);
    expect(workflow).toContain("# Deploy the origin functions first.");
    expect(workflow).toContain(
      "needs: [admin-build, firebase-preflight, firebase]",
    );
    expect(parse(workflow).jobs["admin-deploy"].needs).toEqual(["admin-build", "cms-api", "firebase", "preview-renderer", "firebase-preflight"]);
    expect(parse(workflow).jobs["firebase"].needs).toEqual(["admin-build", "firebase-preflight", "smoke-manifest", "verify"]);
    expect(parse(workflow).jobs["live-smoke"].needs).toEqual(["admin-build", "firebase", "admin-deploy"]);
    expect(workflow).toContain("node scripts/component-runner.mjs functions verify-config");
    expect(NATIVE_CONFIGURATION.databaseId).toBe("(default)");
    expect(NATIVE_CONFIGURATION.ttlField).toBe("expireAt");
    expect(NATIVE_CONFIGURATION.ttlCollections).toHaveLength(7);
    expect(NATIVE_CONFIGURATION.ttlCollections).toContain("staffAccessRequests");
    expect(NATIVE_CONFIGURATION.ttlCollections).toContain("staffPasswordResetRequests");
  });



  it("keeps moving smoke code away from Firebase deploy credentials", () => {
    const workflow = readCmsDeployWorkflow();
    const smokeManifestStart = workflow.indexOf("\n  smoke-manifest:");
    const firebasePreflightStart = workflow.indexOf("\n  firebase-preflight:");
    const cmsApiStart = workflow.indexOf("\n  cms-api:");
    const firebaseStart = workflow.indexOf("\n  firebase:");
    const liveSmokeStart = workflow.indexOf("\n  live-smoke:");
    const adminDeployStart = workflow.indexOf("\n  admin-deploy:");

    expect(smokeManifestStart).toBeGreaterThan(-1);
    expect(firebasePreflightStart).toBeGreaterThan(smokeManifestStart);
    expect(cmsApiStart).toBeGreaterThan(firebasePreflightStart);
    expect(firebaseStart).toBeGreaterThan(cmsApiStart);
    expect(liveSmokeStart).toBeGreaterThan(firebaseStart);
    expect(adminDeployStart).toBeGreaterThan(liveSmokeStart);

    const smokeManifest = workflow.slice(
      smokeManifestStart,
      firebasePreflightStart,
    );
    const firebase = workflow.slice(firebaseStart, liveSmokeStart);
    const liveSmoke = workflow.slice(liveSmokeStart, adminDeployStart);
    expect(smokeManifest).toContain(
      "node scripts/component-runner.mjs functions manifest",
    );
    expect(smokeManifest).not.toContain("FIREBASE_SERVICE_ACCOUNT");
    expect(firebase).not.toContain(".cms-smoke-gate");
    expect(firebase).not.toContain("smoke-cms-functions.mjs");
    expect(firebase).toContain("Mark the Functions receipt in progress");
    expect(firebase).toContain("Record the completed Functions receipt");
    expect(firebase.indexOf("Mark the Functions receipt in progress"))
      .toBeLessThan(firebase.indexOf("Pause cloud preview admission before changing Functions"));
    expect(firebase.indexOf("Mark the renderer receipt in progress"))
      .toBeLessThan(firebase.indexOf("Pause cloud preview admission before changing Functions"));
    expect(workflow).toContain("Mark the CMS API receipt in progress");
    expect(workflow).toContain("Record the completed CMS API receipt");
    expect(workflow).toContain("Mark the renderer receipt in progress");
    expect(workflow).toContain("Record the completed renderer receipt");
    expect(workflow).toContain("scripts/component-runner.mjs");
    expect(workflow).not.toContain("cp \"$RUNNER_TEMP/metered-api-gate\"/scripts/component-runner.mjs");
    expect(workflow.split("--live").length).toBeGreaterThan(3);
    expect(liveSmoke).toContain("node scripts/component-runner.mjs functions smoke");
    expect(liveSmoke).not.toContain("FIREBASE_SERVICE_ACCOUNT");
    const adminDeploy = workflow.slice(adminDeployStart);
    expect(adminDeploy).toContain("Confirm the live Admin revision matches this deploy");
    expect(adminDeploy).not.toContain("\"$RUNNER_TEMP/metered-api-gate\"/scripts/confirm-admin-revision.mjs");
    expect(adminDeploy).toContain("scripts/confirm-admin-revision.mjs");
    expect(adminDeploy).toContain("workingDirectory: admin");
    expect(adminDeploy).toContain(
      "command: pages deploy dist --project-name=njpbs-admin",
    );
    expect(adminDeploy).toContain(
      "node scripts/check-admin-pages-security.mjs predeploy",
    );
    expect(adminDeploy).toContain(
      "node scripts/check-admin-pages-security.mjs postdeploy",
    );
    expect(adminDeploy).toContain(
      "if: hashFiles('admin/dist/guide-content/manifest.json') != ''",
    );
    expect(adminDeploy).toContain(
      "node scripts/check-admin-pages-security.mjs",
    );

    const gateCheckouts = workflow.match(
      /ref: \$\{\{ github\.sha \}\}\n\s+path: \.cms-smoke-gate/g,
    );
    expect(gateCheckouts).toHaveLength(3);
    expect(workflow).not.toContain(
      "ref: main\n          path: .cms-smoke-gate",
    );
  });

  it("keeps both private voiceover Functions in the authenticated current manifest", () => {
    for (const name of VOICEOVER_FUNCTION_NAMES) {
      expect(AUTHENTICATED_POST_FUNCTION_NAMES).toContain(name);
      expect(DEPLOYED_FUNCTION_NAMES).toContain(name);
    }
  });

  it("verifies the exact Admin App Check registration before preflight mutations", () => {
    const workflow = readCmsDeployWorkflow();
    const firebasePreflight = workflow.indexOf("\n  firebase-preflight:");
    const appCheckGate = workflow.indexOf(
      "Verify Admin App Check registration",
      firebasePreflight,
    );
    const firstMutation = workflow.indexOf(
      "Store the Studio connector in private media storage",
      firebasePreflight,
    );
    const cmsApi = workflow.indexOf("\n  cms-api:", firebasePreflight);
    const gate = workflow.slice(appCheckGate, firstMutation);

    expect(firebasePreflight).toBeGreaterThan(-1);
    expect(appCheckGate).toBeGreaterThan(firebasePreflight);
    expect(firstMutation).toBeGreaterThan(appCheckGate);
    expect(cmsApi).toBeGreaterThan(firstMutation);
    expect(gate).toContain(
      "FIREBASE_APP_ID: ${{ vars.VITE_FIREBASE_APP_ID || secrets.VITE_FIREBASE_APP_ID }}",
    );
    expect(gate).toContain(
      "FIREBASE_APPCHECK_SITE_KEY: ${{ vars.VITE_FIREBASE_APPCHECK_SITE_KEY || secrets.VITE_FIREBASE_APPCHECK_SITE_KEY }}",
    );
    expect(gate).toContain(
      "firebaseappcheck.googleapis.com/v1/projects/${project_number}/apps/${FIREBASE_APP_ID}/recaptchaEnterpriseConfig",
    );
    expect(gate).toContain("Authorization: Bearer $access_token");
    expect(gate).toContain("config.siteKey !== expectedSiteKey");
    expect(gate).toContain(
      "Firebase App Check registration does not match the Admin build",
    );
  });

  it("keeps every literal workflow run block valid bash", () => {
    const workflow = readCmsDeployWorkflow();
    const runBlocks = extractLiteralRunBlocks(workflow);

    expect(runBlocks.length).toBeGreaterThan(0);
    runBlocks.forEach((runBlock) => {
      expect(() =>
        execFileSync("bash", ["-n"], {
          input: runBlock,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ).not.toThrow();
    });
  });

  it("deploys Worker code and its origin secret in one live version", () => {
    const workflow = readCmsDeployWorkflow();
    const cmsApiJob = workflow.indexOf("\n  cms-api:");
    const firebaseJob = workflow.indexOf("\n  firebase:", cmsApiJob);
    const cmsApi = workflow.slice(cmsApiJob, firebaseJob);

    expect(cmsApi).toContain("Prepare CMS API Worker secrets file");
    const secretPreparation = cmsApi.slice(
      cmsApi.indexOf("- name: Prepare CMS API Worker secrets file"),
      cmsApi.indexOf("- name: Plan the CMS API Worker release"),
    );
    expect(secretPreparation).not.toContain("if: needs.firebase-preflight");
    expect(secretPreparation).toContain(
      "FIREBASE_WEB_API_KEY: ${{ vars.VITE_FIREBASE_API_KEY || secrets.VITE_FIREBASE_API_KEY }}",
    );
    expect(secretPreparation).toContain("if (!firebaseWebApiKey) throw new Error");
    expect(secretPreparation).toContain("FIREBASE_WEB_API_KEY: firebaseWebApiKey");
    expect(secretPreparation).toContain("CMS_EDGE_ORIGIN_SECRET: process.env.CMS_EDGE_ORIGIN_SECRET");
    expect(cmsApi).toContain("umask 077");
    expect(cmsApi).toContain('--secrets-file "$secrets_path"');
    expect(cmsApi).not.toContain("wrangler secret put");
    expect(cmsApi).toContain("Clean up CMS API Worker secrets file");
    expect(cmsApi).toContain("if: always()");
  });

  it("checks the newly activated settings publish boundary before a current Admin deploy", () => {
    const workflow = readCmsDeployWorkflow();
    const transitionProbe = workflow.indexOf(
      "Verify legacy settings transition boundaries before Admin",
    );
    const edgeDeploy = workflow.indexOf("Deploy CMS API Worker");
    const adminDeploy = workflow.indexOf("\n  admin-deploy:");
    expect(transitionProbe).toBeGreaterThan(edgeDeploy);
    expect(adminDeploy).toBeGreaterThan(transitionProbe);
    const transitionEnd = workflow.indexOf("\n      - name:", transitionProbe);
    expect(transitionEnd).toBeGreaterThan(transitionProbe);
    const transitionCommand = workflow.slice(transitionProbe, transitionEnd);
    expect(transitionCommand).toContain(
      "if: needs.admin-build.outputs.deploy_sha == github.sha",
    );
    expect(transitionCommand).toContain("cmsPublishSettings");
    expect(transitionCommand).not.toContain("cmsGetPublishedSettings");
    expect(transitionCommand).toContain(
      'expect_transition_status 401 "edge $endpoint"',
    );
    expect(transitionCommand).toContain(
      'expect_transition_status 403 "direct origin $endpoint"',
    );
    expect(transitionCommand).toContain("for attempt in {1..19}");
    expect(transitionCommand).toContain('[ "$status" = "$expected_status" ]');
    expect(transitionCommand).toContain('if [ "$attempt" -lt 19 ]');
    expect(transitionCommand).toContain("sleep 10");
    expect(transitionCommand).not.toContain(
      "retry_args=(--retry 18 --retry-delay 10",
    );
  });

  it("runs seed backfills before deploy and byline backfill after", () => {
    const workflow = readCmsDeployWorkflow();
    const mediaProvision = workflow.indexOf(
      "Provision and verify media store credentials",
    );
    const pageBackfill = workflow.indexOf("Backfill page seed media records");
    const mediaCategorySeed = workflow.indexOf(
      "Seed and verify the managed media-category registry",
    );
    const mediaCategoryBackfill = workflow.indexOf(
      "Backfill and verify media category assignments",
    );
    const authorBackfill = workflow.indexOf("Backfill author identities");
    const sectionSeed = workflow.indexOf(
      "Seed and verify the content section registry",
    );
    const firebaseDeploy = workflow.indexOf(
      "Deploy Firebase rules, indexes, and functions",
    );
    const bylineBackfill = workflow.indexOf("Backfill byline projections");
    const functionsReceipt = workflow.indexOf("Record the completed Functions receipt");

    expect(pageBackfill).toBeGreaterThan(mediaProvision);
    expect(mediaCategorySeed).toBeGreaterThan(pageBackfill);
    expect(mediaCategoryBackfill).toBeGreaterThan(mediaCategorySeed);
    expect(authorBackfill).toBeGreaterThan(mediaCategoryBackfill);
    expect(sectionSeed).toBeGreaterThan(authorBackfill);
    expect(firebaseDeploy).toBeGreaterThan(sectionSeed);
    expect(bylineBackfill).toBeGreaterThan(firebaseDeploy);
    expect(functionsReceipt).toBeGreaterThan(bylineBackfill);
    expect(workflow.split("- name: Backfill author identities")).toHaveLength(
      2,
    );
    expect(workflow).toContain("node scripts/backfill-page-seed-media.mjs");
    expect(workflow).toContain("node scripts/seed-media-categories.mjs");
    expect(readFileSync(join(REPO_ROOT, ".github/scripts/require-cms-release-sources.mjs"), "utf8")).toContain(
      '"scripts/seed-media-categories.mjs"',
    );
    expect(workflow).toContain(
      "node scripts/backfill-media-category-assignments.mjs",
    );
    expect(readFileSync(join(REPO_ROOT, ".github/scripts/require-cms-release-sources.mjs"), "utf8")).toContain(
      '"scripts/backfill-media-category-assignments.mjs"',
    );
    expect(workflow).toContain("node scripts/backfill-author-profiles.mjs");
    expect(workflow).toContain("node scripts/backfill-byline-projections.mjs");
  });

  it("seeds the content section registry before the strict Functions deploy", () => {
    // A record create names a registered desk and fails closed against the live `sections`
    // collection, so functions activated before the registry exists refuse every create and
    // every scoped grant. The seed is ordered ahead of the deploy for that reason; nothing
    // else in the workflow puts the registry in place.
    const workflow = readCmsDeployWorkflow();
    const credentials = workflow.indexOf("Configure Firebase credentials");
    const seed = workflow.indexOf(
      "Seed and verify the content section registry",
    );
    const firebaseDeploy = workflow.indexOf(
      "Deploy Firebase rules, indexes, and functions",
    );

    expect(seed).toBeGreaterThan(credentials);
    expect(firebaseDeploy).toBeGreaterThan(seed);
    expect(workflow).toContain("node scripts/seed-content-sections.mjs");
  });

  it("runs preflight tests when the gate script or deploy workflow changes", () => {
    const workflow = readFileSync(FIREBASE_CI, "utf8");
    const install = workflow.indexOf("- name: Install dependencies");
    const functionsLint = workflow.indexOf("- name: Functions lint");
    const functionsTests = workflow.indexOf("- name: Functions tests");

    expect(functionsLint).toBeGreaterThan(install);
    expect(functionsTests).toBeGreaterThan(functionsLint);
    expect(workflow).toContain("npm run lint -w njpbs-functions");
    for (const path of [
      "scripts/smoke-cms-functions.mjs",
      "scripts/assert-r2-lifecycle.mjs",
      "scripts/configure-cms-functions.mjs",
      "config/functions-configuration.json", "config/functions-deployment.json",
      "scripts/lib/functions-configuration.mjs", "scripts/lib/functions-secret-versions.mjs",
      "scripts/backfill-page-seed-media.mjs",
      "scripts/backfill-media-thumbnails.mjs",
      "scripts/backfill-byline-projections.mjs",
      "packages/content-core/src/content-model.ts",
      ".github/workflows/cms-staging-deploy.yml",
    ]) {
      expect(classifyPath(path)?.firebase, path).toBe(true);
    }
  });


  it("retries the CMS API edge probes while DNS propagation settles", () => {
    const workflow = readCmsDeployWorkflow();
    const smokeStart = workflow.indexOf("- name: Smoke-test CMS API edge");
    const smokeEnd = workflow.indexOf("\n  firebase:", smokeStart);
    const smoke = workflow.slice(smokeStart, smokeEnd);

    expect(smokeStart).toBeGreaterThan(-1);
    expect(smokeEnd).toBeGreaterThan(smokeStart);
    expect(smoke).toContain(
      "retry_args=(--retry 18 --retry-delay 10 --retry-max-time 180 --retry-all-errors --doh-url https://1.1.1.1/dns-query)",
    );
    expect(smoke.match(/curl \"\$\{retry_args\[@\]\}\"/g)).toHaveLength(2);
    expect(smoke.match(/expect_transition_status /g)).toHaveLength(2);
  });
});

describe("Functions receipt inventory", () => {
  it("collects all live inventory pages with the selected release helper", () => {
    const root = mkdtempSync(join(tmpdir(), "cms-release-receipt-"));
    try {
      for (const path of ["scripts/lib/cms-component-receipt.mjs", "scripts/lib/cms-release-plan.mjs",
        "scripts/lib/functions-configuration.mjs", "config/functions-configuration.json",
        "scripts/lib/studio-title-files.mjs", "agents/vmix/configuration.mjs",
        "scripts/lib/functions-deploy-inventory.mjs", "scripts/lib/repository-identity.mjs",
        "scripts/deploy-cms-function-batches.mjs",
        "scripts/render-development-config.mjs", "config/development-inputs.json"]) {
        const target = join(root, path);
        mkdirSync(join(target, ".."), { recursive: true });
        copyFileSync(join(REPO_ROOT, path), target);
      }
      const auth = join(root, "node_modules/google-auth-library");
      mkdirSync(auth, { recursive: true });
      writeFileSync(join(auth, "index.js"), `
        exports.GoogleAuth = class {
          async getClient() {
            return { request: async ({ url, params }) => {
              if (url !== "https://cloudfunctions.googleapis.com/v2/projects/njpbs-site/locations/us-central1/functions"
                  || params.pageSize !== 100) throw new Error("Unexpected inventory request");
              if (params.pageToken === undefined) return { data: {
                functions: [{ name: "functions/health", state: "ACTIVE" }], nextPageToken: "page-2",
              } };
              if (params.pageToken === "page-2") return { data: {
                functions: [{ name: "functions/cmsGetPage", state: "ACTIVE" }],
              } };
              throw new Error("Unexpected inventory page");
            } };
          }
        };
      `);
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { collectLiveIdentities } from "./scripts/lib/cms-component-receipt.mjs";
        console.log(JSON.stringify(await collectLiveIdentities("functions")));
      `], { cwd: root, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({
        region: "us-central1",
        activeCount: "2",
        inventoryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R2 lifecycle validation", () => {
  const lifecycle = (rules) => ({ success: true, result: { rules } });
  const deleteRule = (prefix, maxAge) => ({
    enabled: true,
    conditions: prefix === undefined ? {} : { prefix },
    deleteObjectsTransition: { condition: { type: "Age", maxAge } },
  });
  const CORRECT_STAGING = deleteRule("cms-media-staging/", 604800);

  it("accepts the required staging rule alone", () => {
    expect(() => assertR2Lifecycle(lifecycle([CORRECT_STAGING]))).not.toThrow();
  });

  it("rejects a missing or wrong-age staging retention rule", () => {
    expect(() =>
      assertR2Lifecycle(lifecycle([deleteRule("cms-media-staging/", 999999)])),
    ).toThrow();
    expect(() => assertR2Lifecycle(lifecycle([]))).toThrow();
  });

  it("rejects a delete rule whose prefix is a parent of cms-media/", () => {
    expect(() =>
      assertR2Lifecycle(
        lifecycle([CORRECT_STAGING, deleteRule("cms-media/", 604800)]),
      ),
    ).toThrow();
    expect(() =>
      assertR2Lifecycle(lifecycle([CORRECT_STAGING, deleteRule("", 604800)])),
    ).toThrow();
    expect(() =>
      assertR2Lifecycle(
        lifecycle([CORRECT_STAGING, deleteRule(undefined, 604800)]),
      ),
    ).toThrow();
  });

  it("rejects a delete rule whose prefix is a child of cms-media/", () => {
    expect(() =>
      assertR2Lifecycle(
        lifecycle([
          CORRECT_STAGING,
          deleteRule("cms-media/originals/", 999999),
        ]),
      ),
    ).toThrow();
  });

  it("rejects an overlapping staging rule that expires before seven days even with a correct rule present", () => {
    expect(() =>
      assertR2Lifecycle(
        lifecycle([
          CORRECT_STAGING,
          deleteRule("cms-media-staging/tmp/", 86400),
        ]),
      ),
    ).toThrow();
    expect(() =>
      assertR2Lifecycle(
        lifecycle([CORRECT_STAGING, deleteRule("cms-media-staging/", 86400)]),
      ),
    ).toThrow();
  });

  it("rejects a staging-overlapping rule with a non-Age expiry condition", () => {
    const dateRule = {
      enabled: true,
      conditions: { prefix: "cms-media-staging/" },
      deleteObjectsTransition: {
        condition: { type: "Date", date: "2026-01-01T00:00:00Z" },
      },
    };
    expect(() =>
      assertR2Lifecycle(lifecycle([CORRECT_STAGING, dateRule])),
    ).toThrow();
  });

  it("rejects a staging-overlapping Age rule that omits maxAge", () => {
    const noMaxAge = {
      enabled: true,
      conditions: { prefix: "cms-media-staging/" },
      deleteObjectsTransition: { condition: { type: "Age" } },
    };
    expect(() =>
      assertR2Lifecycle(lifecycle([CORRECT_STAGING, noMaxAge])),
    ).toThrow();
  });

  it("rejects an unsuccessful lifecycle response", () => {
    expect(() =>
      assertR2Lifecycle({ success: false, result: { rules: [] } }),
    ).toThrow();
    expect(() => assertR2Lifecycle({ success: true, result: {} })).toThrow();
  });
});
