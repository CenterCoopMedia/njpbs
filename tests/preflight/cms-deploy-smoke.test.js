import { copyImportClosure } from "../helpers/isolated-checkout.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

import {
  assertProductionManifest,
  AUTHENTICATED_POST_FUNCTION_NAMES,
  WORKER_FUNCTION_NAMES,
  PREMIERE_FUNCTION_NAMES,
  PRIVATE_RPC_FUNCTION_NAMES,
  DEVICE_PAIRING_FUNCTION_NAMES,
  DEPLOYED_FUNCTION_NAMES,
  extractProductionExports,
  runCmsFunctionSmoke,
} from "../../scripts/smoke-cms-functions.mjs";
import { componentFailureDiagnostic } from "../../scripts/component-runner.mjs";
import { CALLER_REFUSED } from "../../scripts/lib/provider-call.mjs";
import { ENDPOINTS } from "../../cms-api/src/config.ts";
import { assertR2Lifecycle } from "../../scripts/assert-r2-lifecycle.mjs";
import { configurationInputs, CONFIGURATION_INPUTS, NATIVE_CONFIGURATION } from "../../scripts/lib/functions-configuration.mjs";
import { classifyPath } from "../../.github/scripts/ci-classifier.mjs";

const FUNCTIONS_INDEX = fileURLToPath(
  new URL("../../functions/index.js", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
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

const UNSIGNED_READER_PATH = "cmsGetPublishedPost/posts/nj-pbs-announces-six-staff-appointments/";
const PRIVATE_RPC_POST_NAMES = PRIVATE_RPC_FUNCTION_NAMES.filter(
  name => name !== "cmsGetPublishedPost",
);

function probeTargets(origin, method, names) {
  return names.map(name => `${method} ${origin}/${name}`);
}

// These groups form the production manifest checked against functions/index.js.
const EXPECTED_PROBES = [
  `GET ${BASE_URL}/health`,
  ...probeTargets(BASE_URL, "POST", AUTHENTICATED_POST_FUNCTION_NAMES),
  ...probeTargets(FUNCTIONS_ORIGIN, "POST", AUTHENTICATED_POST_FUNCTION_NAMES),
  ...WORKER_FUNCTION_NAMES.flatMap(name => [
    `POST ${BASE_URL}/${name}`,
    `POST ${FUNCTIONS_ORIGIN}/${name}`,
  ]),
  ...[...PREMIERE_FUNCTION_NAMES, ...DEVICE_PAIRING_FUNCTION_NAMES].flatMap(name => [
    `GET ${BASE_URL}/${name}`,
    `POST ${FUNCTIONS_ORIGIN}/${name}`,
  ]),
  ...PRIVATE_RPC_FUNCTION_NAMES.map(name => name === "cmsGetPublishedPost"
    ? `GET ${FUNCTIONS_ORIGIN}/${UNSIGNED_READER_PATH}`
    : `POST ${FUNCTIONS_ORIGIN}/${name}`),
  `GET ${BASE_URL}/deactivateStaff`,
  ...probeTargets(BASE_URL, "OPTIONS", [
    "deactivateStaff", "submitStaffAccessRequest", "cmsUploadMedia", "cmsSubmitBugReport",
  ]),
  `HEAD ${FUNCTIONS_ORIGIN}/donationHealth`,
  `GET ${ADMIN_ORIGIN}`,
];

function expectedResponseFor(url, init = {}) {
  const parsedUrl = new URL(url);
  if (parsedUrl.origin === ADMIN_ORIGIN) {
    return { status: 200, headers: new Headers() };
  }
  if (parsedUrl.origin === FUNCTIONS_ORIGIN) {
    return { status: parsedUrl.pathname === "/donationHealth" ? 405 : 403, headers: new Headers() };
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

  it("probes the pilot reader only with an unsigned GET that must return 403", async () => {
    const requests = [];
    const url = `${FUNCTIONS_ORIGIN}/${UNSIGNED_READER_PATH}`;
    const run = (status) => runCmsFunctionSmoke({ request: async (target, init = {}) => {
      requests.push({ url: target, init });
      return target === url ? { status } : expectedResponseFor(target, init);
    } });
    await expect(run(403)).resolves.toEqual({ checked: EXPECTED_PROBES.length });
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
    ).resolves.toEqual({ checked: EXPECTED_PROBES.length });

    expect(
      requests.map(({ url, init }) => `${init.method ?? "GET"} ${url}`),
    ).toEqual(EXPECTED_PROBES);

    for (const { init } of requests) {
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
    }

    const posts = requests.filter(({ init }) => init.method === "POST");
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
    const privatePosts = jsonPosts.filter(({ url }) => {
      const { origin, pathname } = new URL(url);
      const name = pathname.slice(1);
      return (origin === FUNCTIONS_ORIGIN && PRIVATE_RPC_POST_NAMES.includes(name)) ||
        WORKER_FUNCTION_NAMES.includes(name);
    });
    expect(privatePosts).toHaveLength(PRIVATE_RPC_POST_NAMES.length + 2 * WORKER_FUNCTION_NAMES.length);
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
    await expect(runCmsFunctionSmoke({ baseUrl: BASE_URL, request: async () => { throw Error("synthetic-private-provider-body"); }, wait: async () => {} }))
      .rejects.toMatchObject({ message: "health request failed" });
  });

  it.each([["a marked refusal", CALLER_REFUSED, 1], ["an unmarked error", undefined, 5]])(
    "names the cause when the request callback throws %s", async (_name, code, attempts) => {
      const message = "method HEAD not allowed by the caller's request callback";
      const request = vi.fn(async () => { throw Object.assign(new Error(message), code && { code }); });
      const log = vi.spyOn(console, "error").mockReturnValue();
      const error = await runCmsFunctionSmoke({ baseUrl: BASE_URL, request, wait: vi.fn() }).catch(error => error);
      log.mockRestore();
      expect(request).toHaveBeenCalledTimes(attempts);
      expect(componentFailureDiagnostic(error)).toBe(`health request failed; cause: ${code ? `${code}: ` : ""}${message}`);
    });

  it("bounds direct-origin probes and keeps edge probes serial", async () => {
    const active = new Map(), peak = new Map();
    const request = async (url, init = {}) => {
      const { origin } = new URL(url);
      const count = (active.get(origin) ?? 0) + 1;
      active.set(origin, count);
      peak.set(origin, Math.max(peak.get(origin) ?? 0, count));
      await Promise.resolve();
      active.set(origin, active.get(origin) - 1);
      return expectedResponseFor(url, init);
    };
    await expect(runCmsFunctionSmoke({ baseUrl: BASE_URL, request })).resolves.toEqual({ checked: EXPECTED_PROBES.length });
    expect(peak.get(BASE_URL)).toBe(1);
    expect(peak.get(FUNCTIONS_ORIGIN)).toBe(4);
  });

  it("passes three consecutive smoke runs with both account IP buckets exhausted", async () => {
    const exhausted = new Map([
      [`${BASE_URL}/submitStaffAccessRequest`, "17500"],
      [`${BASE_URL}/requestStaffPasswordReset`, "120"],
    ]);
    const request = async (url, init) => {
      const retryAfter = exhausted.get(url);
      if (init?.method === "POST" && retryAfter) {
        return new Response(null, { status: 429, headers: {
          "retry-after": retryAfter, "x-rate-limit-scope": "ip",
        } });
      }
      return expectedResponseFor(url, init);
    };

    for (let run = 0; run < 3; run += 1) {
      await expect(runCmsFunctionSmoke({ request })).resolves.toEqual({ checked: EXPECTED_PROBES.length });
    }
  });

  it.each([
    ["submitStaffAccessRequest", 429, { "x-rate-limit-scope": "ip" }],
    ["submitStaffAccessRequest", 429, { "x-rate-limit-scope": "ip", "retry-after": "0" }],
    ["requestStaffPasswordReset", 429, { "retry-after": "120" }],
    ["requestStaffPasswordReset", 200, {}],
    ["cmsCuezStatus", 429, { "x-rate-limit-scope": "ip", "retry-after": "120" }],
  ])("rejects an unexpected account or ordinary edge response (%s, %i, %j)", async (endpoint, status, headers) => {
    const request = async (url, init) => url === `${BASE_URL}/${endpoint}` && init?.method === "POST"
      ? new Response(null, { status, headers })
      : expectedResponseFor(url, init);
    await expect(runCmsFunctionSmoke({ request, wait: async () => {} }))
      .rejects.toThrow(`${endpoint} unauthenticated POST returned ${status}; expected 401`);
  });

  it("fails a direct-origin batch when one authorization refusal is missing", async () => {
    const originPaths = [];
    const request = async (url, init = {}) => {
      const { origin, pathname } = new URL(url);
      if (origin === FUNCTIONS_ORIGIN) originPaths.push(pathname);
      if (origin === FUNCTIONS_ORIGIN && pathname === "/cmsCuezListDestinations") return { status: 200 };
      return expectedResponseFor(url, init);
    };
    await expect(runCmsFunctionSmoke({ baseUrl: BASE_URL, request }))
      .rejects.toThrow("cmsCuezListDestinations direct-origin refusal returned 200; expected 403");
    expect(originPaths).toEqual(["/cmsCuezStatus", "/cmsCuezListDestinations", "/cmsCuezPrepareExport", "/cmsCuezSendExport"]);
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

  it("keeps both private voiceover Functions in the authenticated current manifest", () => {
    for (const name of VOICEOVER_FUNCTION_NAMES) {
      expect(AUTHENTICATED_POST_FUNCTION_NAMES).toContain(name);
      expect(DEPLOYED_FUNCTION_NAMES).toContain(name);
    }
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
    ]) {
      expect(classifyPath(path)?.firebase, path).toBe(true);
    }
  });
});

describe("Functions receipt inventory", () => {
  it("collects all live inventory pages with the selected release helper", async () => {
    const root = mkdtempSync(join(tmpdir(), "cms-release-receipt-"));
    try {
      await copyImportClosure(REPO_ROOT, root, ["scripts/lib/cms-component-receipt.mjs"], {
        assets: ["config/functions-configuration.json"],
      });
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
