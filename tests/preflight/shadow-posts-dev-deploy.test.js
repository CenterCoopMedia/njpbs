import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { forwardPublishedPostRead } from "../../workers/src/published-post-reader-worker.ts";

const source = readFileSync(new URL("../../.github/workflows/shadow-posts-dev-deploy.yml", import.meta.url), "utf8");
const workflow = parse(source);
const steps = workflow.jobs.deploy.steps;
const step = (name) => steps.find((entry) => entry.name === name);
const pilot = "nj-pbs-announces-six-staff-appointments";
const staffHeaders = "Cache-Control: private, no-store\r\nX-Robots-Tag: noindex, nofollow, noarchive\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n";
const testKey = "example-test-key-for-local-process-boundary-only";

// Fake only the CLI/network boundary. Execute the workflow's actual shell.
function runStep(name, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shadow-deploy-"));
  try {
    writeFileSync(join(dir, "npx"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args.includes('deploy')) {
  const path = args[args.indexOf('--config') + 1];
  fs.appendFileSync(process.env.CONFIGS, JSON.stringify({ path, body: JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\\s*\\/\\/.*$/gm, '')) }) + '\\n');
}
if (args.includes('secret')) {
  const input = fs.readFileSync(0, 'utf8');
  if (input !== process.env.PUBLISHED_POST_READER_HMAC_KEY || args.includes(input)) process.exit(1);
}
`, { mode: 0o755 });
    writeFileSync(join(dir, "curl"), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const status = process.env.STATUS || '401';
if (process.argv.includes('--include')) {
  process.stdout.write('HTTP/2 ' + status + '\\r\\n' + (process.env.RESPONSE_HEADERS || '') + '\\r\\n' + (process.env.RESPONSE_BODY || ''));
} else process.stdout.write(status);
process.exit(Number(process.env.CURL_EXIT || 0));
`, { mode: 0o755 });
    writeFileSync(join(dir, "calls"), "");
    writeFileSync(join(dir, "configs"), "");
    writeFileSync(join(dir, "summary"), "");
    const result = spawnSync("bash", ["-c", step(name).run], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: join(dir, "calls"),
        CONFIGS: join(dir, "configs"),
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
        GITHUB_SHA: "a".repeat(40), CMS_DEV_ACCESS_ORIGIN: "https://access.example.org",
        PUBLISHED_POST_READER_HMAC_KEY: testKey,
        ...extraEnv,
      },
    });
    return {
      ...result,
      calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
      summary: readFileSync(join(dir, "summary"), "utf8"),
      configs: readFileSync(join(dir, "configs"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runRouteOperation({ mode = "remove", script = "njpbs-shadow-posts", absent = false,
  gateway = true, owner = "njpbs-staff-sites", duplicateParent = false,
  parentAfter = "unchanged", publishEnabled = "", remains = false, failure = "" } = {}) {
  const routeStep = step(mode === "remove" ? "Remove and verify the configured dev shadow route"
    : "Verify configured dev shadow route admission");
  const account = "a".repeat(32);
  const zone = "b".repeat(32);
  const routeId = "c".repeat(32);
  const routes = [
    ...(gateway ? [{ id: "d".repeat(32), pattern: "dev-public.example.org/*", script: owner }] : []),
    ...(duplicateParent ? [{ id: "f".repeat(32), pattern: "dev-public.example.org/*", script: "njpbs-staff-sites" }] : []),
    { id: "e".repeat(32), pattern: "njpbs.org/*", script: "njpbs-production" },
    ...(absent ? [] : [{ id: routeId, pattern: "https://dev-public.example.org/posts/*", script }]),
  ];
  const boundary = `
let fakeRoutes = ${JSON.stringify(routes)};
globalThis.fetch = async (url, options) => {
  if (options.headers.Authorization !== 'Bearer example-test-token' || options.redirect !== 'error') throw new Error('Bad API admission');
  console.log(JSON.stringify({url, method: options.method}));
  if (${JSON.stringify(failure)} === 'http') return new Response(JSON.stringify({success:false}), {status:403});
  if (${JSON.stringify(failure)} === 'api') return new Response(JSON.stringify({success:false}), {status:200});
  let result;
  if (url === 'https://api.cloudflare.com/client/v4/zones?name=njpbs.org&account.id=${account}') {
    result = [{id:'${zone}', name:'njpbs.org', account:{id:'${account}'}}];
  } else if (url === 'https://api.cloudflare.com/client/v4/zones/${zone}/workers/routes' && options.method === 'GET') {
    result = fakeRoutes;
  } else if (url === 'https://api.cloudflare.com/client/v4/zones/${zone}/workers/routes/${routeId}' && options.method === 'DELETE') {
    if (!${JSON.stringify(remains)}) fakeRoutes = fakeRoutes.filter(r => r.id !== '${routeId}');
    if (${JSON.stringify(parentAfter)} === 'missing') fakeRoutes = fakeRoutes.filter(r => r.pattern !== 'dev-public.example.org/*');
    else if (${JSON.stringify(parentAfter)} !== 'unchanged') fakeRoutes = fakeRoutes.map(r =>
      r.pattern === 'dev-public.example.org/*' ? {...r, script: ${JSON.stringify(parentAfter)}} : r);
    result = {id:'${routeId}'};
  } else throw new Error('Unexpected API request');
  return new Response(JSON.stringify({success:true, result}));
};
`;
  const result = spawnSync("bash", ["-c", routeStep.run], {
    encoding: "utf8",
    env: { PATH: process.env.PATH,
      NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(boundary).toString("base64")}`,
      CLOUDFLARE_API_TOKEN: "example-test-token", CLOUDFLARE_ACCOUNT_ID: account,
      CMS_DEV_PUBLISH_ENABLED: publishEnabled },
  });
  return {
    ...result,
    calls: result.stdout.split("\n").filter((line) => line.startsWith("{")).map(JSON.parse),
  };
}

describe("dev shadow deployment boundary", () => {
  it("allows only the configured deploy owner on main and defaults to a disabled manual deploy", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
      expect(input.type).toBe("boolean");
      expect(input.default).toBe(false);
    }
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("(vars.CMS_DEPLOY_OWNER != '' && github.triggering_actor == vars.CMS_DEPLOY_OWNER) && github.ref == 'refs/heads/main'");
      for (const [owner, actor, ref, admitted] of [
        ["fixture-owner", "fixture-owner", "refs/heads/main", true],
        ["fixture-owner", "other", "refs/heads/main", false],
        ["", "fixture-owner", "refs/heads/main", false],
        ["", "", "refs/heads/main", false],
        ["fixture-owner", "fixture-owner", "refs/heads/feature", false],
      ]) expect(runInNewContext(job.if, { vars: { CMS_DEPLOY_OWNER: owner },
        github: { triggering_actor: actor, ref } })).toBe(admitted);
    }
    expect(steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(step("Build matched shadow renderer and assets").run).toBe("npm --prefix site run build:shadow");
    expect(step("Build matched shadow renderer and assets").if).toBe("${{ !inputs.remove }}");
    expect(workflow.env).toEqual({
      CLOUDFLARE_DEV_PUBLIC_WORKER: "${{ vars.CLOUDFLARE_DEV_PUBLIC_WORKER }}",
      CMS_DEV_ADMIN_ORIGIN: "${{ vars.CMS_DEV_ADMIN_ORIGIN }}",
      CMS_DEV_ADMIN_PAGES: "${{ vars.CMS_DEV_ADMIN_PAGES }}",
      CMS_DEV_API_ORIGIN: "${{ vars.CMS_DEV_API_ORIGIN }}",
      CMS_DEV_API_WORKER: "${{ vars.CMS_DEV_API_WORKER }}",
      CMS_DEV_MEDIA_BUCKET: "${{ vars.CMS_DEV_MEDIA_BUCKET }}",
      CMS_DEV_MEDIA_ORIGIN: "${{ vars.CMS_DEV_MEDIA_ORIGIN }}",
      CMS_DEV_PREVIEW_BUCKET: "${{ vars.CMS_DEV_PREVIEW_BUCKET }}",
      CMS_DEV_PREVIEW_ORIGIN: "${{ vars.CMS_DEV_PREVIEW_ORIGIN }}",
      CMS_DEV_PREVIEW_RENDERER: "${{ vars.CMS_DEV_PREVIEW_RENDERER }}",
      CMS_DEV_PREVIEW_STAFF_WORKER: "${{ vars.CMS_DEV_PREVIEW_STAFF_WORKER }}",
      CMS_DEV_PREVIEW_WORKER: "${{ vars.CMS_DEV_PREVIEW_WORKER }}",
      CMS_DEV_PUBLIC_ORIGIN: "${{ vars.CMS_DEV_PUBLIC_ORIGIN }}",
      CMS_DEV_SITE_PAGES: "${{ vars.CMS_DEV_SITE_PAGES }}",
      CMS_PRODUCTION_API_ORIGIN: "${{ vars.CMS_PRODUCTION_API_ORIGIN }}",
      CMS_DEPLOY_OWNER: "${{ vars.CMS_DEPLOY_OWNER }}",
      CMS_DEV_ACCESS_ORIGIN: "${{ vars.CMS_DEV_ACCESS_ORIGIN }}",
    });
    expect(workflow.jobs.deploy.env).toBeUndefined();
    for (const entry of steps.filter((entry) => entry.run?.includes("wrangler"))) {
      expect(entry.env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN }}");
      expect(entry.env.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    }
  });

  it("deploys the private relay with the URL admitted by its existing check", async () => {
    const result = runStep("Deploy the private published Post relay", {
      PUBLISHED_POST_FUNCTION_URL: "https://us-central1-njpbs-site.cloudfunctions.net/cmsGetPublishedPost",
    });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([[
      "--no-install", "wrangler", "deploy", "--config", "workers/wrangler.published-post-reader.jsonc",
      "--var", "PUBLISHED_POST_FUNCTION_URL:https://us-central1-njpbs-site.cloudfunctions.net/cmsGetPublishedPost",
    ]]);
    const config = parse(readFileSync(new URL("../../workers/wrangler.published-post-reader.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    expect(config.name).toBe("njpbs-shadow-published-posts-reader");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toBeUndefined();
    expect(config.vars.PUBLISHED_POST_FUNCTION_URL).toBe("");
    const functionUrl = result.calls[0].at(-1).slice("PUBLISHED_POST_FUNCTION_URL:".length);
    const response = await forwardPublishedPostRead(
      new Request(`https://published-posts.internal/posts/${pilot}/`),
      { PUBLISHED_POST_FUNCTION_URL: functionUrl },
      async (request) => {
        expect(request.url).toBe(`https://us-central1-njpbs-site.cloudfunctions.net/cmsGetPublishedPost/posts/${pilot}/`);
        return new Response(null, { status: 200 });
      },
    );
    expect(response.status).toBe(200);
  });

  it("refuses missing or short keys before mutation and puts the matching key only through stdin", () => {
    for (const key of ["", "short"]) {
      expect(runStep("Require the matching reader secret", { PUBLISHED_POST_READER_HMAC_KEY: key }).status).toBe(1);
    }
    expect(runStep("Require the matching reader secret").status).toBe(0);
    const result = runStep("Put the shadow reader secret through stdin");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([[
      "--no-install", "wrangler", "secret", "put", "PUBLISHED_POST_READER_HMAC_KEY", "--config", "workers/wrangler.shadow-posts.jsonc",
    ]]);
    expect(result.stdout + result.stderr).not.toContain(testKey);
    expect(steps.indexOf(step("Require the matching reader secret"))).toBeLessThan(steps.indexOf(step("Deploy the private published Post relay")));
    expect(steps.indexOf(step("Put the shadow reader secret through stdin"))).toBeLessThan(steps.indexOf(step("Deploy the dev shadow Post Worker")));
  });

  it.each([false, true])("deploys enabled=%s with exactly the approved flag and slug list", (enabled) => {
    const deploy = step("Deploy the dev shadow Post Worker");
    expect(deploy.env.SHADOW_POSTS_ENABLED).toBe("${{ inputs.enabled && 'true' || 'false' }}");
    expect(deploy.env.SHADOW_POST_SLUGS).toBe(`\${{ inputs.enabled && '${pilot}' || '' }}`);
    const result = runStep(deploy.name, { SHADOW_POSTS_ENABLED: String(enabled), SHADOW_POST_SLUGS: enabled ? pilot : "" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([[
      "--no-install", "wrangler", "deploy", "--config", result.configs[0].path,
      "--var", `SHADOW_POSTS_ENABLED:${enabled}`, "--var", `SHADOW_POST_SLUGS:${enabled ? pilot : ""}`,
    ]]);
    expect(existsSync(result.configs[0].path)).toBe(false);
    const config = result.configs[0].body;
    expect(config.env).toBeUndefined();
    expect(config.vars).toEqual({ SHADOW_POSTS_ENABLED: "false", SHADOW_POST_SLUGS: "" });
    expect(config.routes).toEqual([{ pattern: "https://dev-public.example.org/posts/*", zone_name: "njpbs.org" }]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });

  it("gives removal precedence, skips building/secrets/deployment and deletes the caller before the relay", () => {
    for (const entry of steps.filter((entry) => /build:shadow|prefix site ci|wrangler deploy|wrangler secret|at least 32/.test(entry.run))) {
      expect(entry.if).toBe("${{ !inputs.remove }}");
    }
    expect(step("Remove and verify the configured dev shadow route").if).toBe("${{ inputs.remove }}");
    expect(step("Remove the dev shadow Workers").if).toBe("${{ inputs.remove }}");
    expect(steps.indexOf(step("Remove and verify the configured dev shadow route"))).toBeLessThan(steps.indexOf(step("Remove the dev shadow Workers")));
    const env = { PUBLISHED_POST_READER_HMAC_KEY: "", CLOUDFLARE_API_TOKEN: "example-test-token", CLOUDFLARE_ACCOUNT_ID: "d".repeat(32) };
    const result = runStep("Remove the dev shadow Workers", { ...env, STATUS: "200" });
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call[0] === "--no-install")).toEqual([
      ["--no-install", "wrangler", "delete", "--config", "workers/wrangler.shadow-posts.jsonc"],
      ["--no-install", "wrangler", "delete", "--config", "workers/wrangler.published-post-reader.jsonc"],
    ]);
    expect(result.calls.filter((call) => call[0] !== "--no-install").map((call) => call.at(-1))).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${"d".repeat(32)}/workers/scripts/njpbs-shadow-posts`,
      `https://api.cloudflare.com/client/v4/accounts/${"d".repeat(32)}/workers/scripts/njpbs-shadow-published-posts-reader`,
    ]);

    // A rerun after a partial removal treats an absent Worker as removed.
    const absent = runStep("Remove the dev shadow Workers", { ...env, STATUS: "404" });
    expect(absent.status).toBe(0);
    expect(absent.calls.filter((call) => call[0] === "--no-install")).toEqual([]);
    expect(absent.stdout).toContain("njpbs-shadow-posts is already absent");
    expect(absent.stdout).toContain("njpbs-shadow-published-posts-reader is already absent");

    const unknown = runStep("Remove the dev shadow Workers", { ...env, STATUS: "500" });
    expect(unknown.status).not.toBe(0);
    expect(unknown.calls.filter((call) => call[0] === "--no-install")).toEqual([]);
    expect(unknown.stdout + unknown.stderr).not.toContain("example-test-token");
  });

  it("checks route admission before the first deploy mutation", () => {
    const admission = step("Verify configured dev shadow route admission");
    expect(admission.if).toBe("${{ !inputs.remove }}");
    expect(steps.indexOf(admission)).toBeLessThan(steps.indexOf(step("Deploy the private published Post relay")));
    expect(admission.env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(admission.env.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    expect(admission.env.CMS_DEV_PUBLISH_ENABLED).toBe("${{ vars.CMS_DEV_PUBLISH_ENABLED }}");
  });

  describe.each(["njpbs-staff-sites", "njpbs-dev-staff-sites"])("dev publication guard with %s", (owner) => {
    it.each(["true", "unexpected"])("refuses deployment when publication flag is %s", (publishEnabled) => {
      const result = runRouteOperation({ mode: "check", owner, publishEnabled });
      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.stderr).toContain("Keep dev publication disabled");
    });

    it("accepts deployment when publication is explicitly disabled", () => {
      const result = runRouteOperation({ mode: "check", owner, publishEnabled: "false" });
      expect(result.status).toBe(0);
      expect(result.calls.map(call => call.method)).toEqual(["GET", "GET"]);
    });

    it("allows shadow removal during dev publication", () => {
      const result = runRouteOperation({ owner, publishEnabled: "true" });
      expect(result.status).toBe(0);
      expect(result.calls.map(call => call.method)).toEqual(["GET", "GET", "DELETE", "GET"]);
    });
  });

  describe.each(["check", "remove"])("%s parent admission", (mode) => {
    it.each(["njpbs-staff-sites", "njpbs-dev-staff-sites"])("accepts configured owner %s", (owner) => {
      const result = runRouteOperation({ mode, owner });
      expect(result.status).toBe(0);
      expect(result.calls.map(call => call.method)).toEqual(mode === "check"
        ? ["GET", "GET"] : ["GET", "GET", "DELETE", "GET"]);
      if (mode === "remove") expect(result.calls[2].url).toBe(
        `https://api.cloudflare.com/client/v4/zones/${"b".repeat(32)}/workers/routes/${"c".repeat(32)}`);
    });

    it.each([
      { owner: "foreign-worker" }, { owner: null }, { gateway: false }, { duplicateParent: true },
    ])("refuses an unknown, unassigned, missing or duplicate parent: %s", (input) => {
      const result = runRouteOperation({ mode, ...input });
      expect(result.status).toBe(1);
      expect(result.calls.map(call => call.method)).toEqual(["GET", "GET"]);
      expect(result.stderr).toContain("Expected one dev staff gateway route with a configured owner");
    });

    it("refuses a shadow route owned by another Worker", () => {
      const result = runRouteOperation({ mode, script: "another-worker" });
      expect(result.status).toBe(1);
      expect(result.calls.map(call => call.method)).toEqual(["GET", "GET"]);
      expect(result.stderr).toContain("Unexpected shadow route ownership or identity");
    });

    it.each(["njpbs-staff-sites", "njpbs-dev-staff-sites"])("accepts an absent shadow route with parent %s", (owner) => {
      const result = runRouteOperation({ mode, owner, absent: true });
      expect(result.status).toBe(0);
      expect(result.calls.map(call => call.method)).toEqual(mode === "check"
        ? ["GET", "GET"] : ["GET", "GET", "GET"]);
    });
  });

  it.each(["missing", "foreign-worker", "njpbs-dev-staff-sites"])("stops Worker deletion if the parent changes to %s during removal", (parentAfter) => {
    const result = runRouteOperation({ parentAfter });
    expect(result.status).toBe(1);
    expect(result.calls.map(call => call.method)).toEqual(["GET", "GET", "DELETE", "GET"]);
    expect(result.stderr).toContain(parentAfter === "njpbs-dev-staff-sites"
      ? "Dev staff gateway changed during removal"
      : "Expected one dev staff gateway route with a configured owner");
  });

  it.each(["njpbs-shadow-posts", null])("removes only the configured route with script %s and verifies absence", (script) => {
    const result = runRouteOperation({ script });
    expect(result.status).toBe(0);
    expect(result.calls.map((call) => call.method)).toEqual(["GET", "GET", "DELETE", "GET"]);
    expect(result.calls[2].url).toBe(`https://api.cloudflare.com/client/v4/zones/${"b".repeat(32)}/workers/routes/${"c".repeat(32)}`);
    expect(result.stdout + result.stderr).not.toContain("example-test-token");
  });

  it("accepts an already absent route without deleting any other route", () => {
    const result = runRouteOperation({ absent: true });
    expect(result.status).toBe(0);
    expect(result.calls.map((call) => call.method)).toEqual(["GET", "GET", "GET"]);
  });

  it.each([{ script: "another-worker" }, { gateway: false }])("refuses removal for unexpected ownership or a missing staff gateway: %s", (input) => {
    const result = runRouteOperation(input);
    expect(result.status).toBe(1);
    expect(result.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(result.stderr).toContain(input.gateway === false
      ? "Expected one dev staff gateway route with a configured owner"
      : "Unexpected shadow route ownership or identity");
  });

  it("refuses Worker deletion when the route is still present after its DELETE", () => {
    const result = runRouteOperation({ remains: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The shadow route remains; Workers will not be deleted");
  });

  it.each(["http", "api"])("fails route removal closed for a %s error without disclosing the token", (failure) => {
    const result = runRouteOperation({ failure });
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain("example-test-token");
  });

  it.each(["401", "403"])("records both signed-out %s refusals without credentials or redirects", (status) => {
    const readback = step("Verify signed-out staff admission");
    expect(readback.env).toBeUndefined();
    const result = runStep(readback.name, { STATUS: status, RESPONSE_HEADERS: staffHeaders,
      RESPONSE_BODY: status === "401" ? "Unauthorized" : "Site access unavailable" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([pilot, "_shadow-assets/_astro"].map((slug) => [
      "--disable", "--silent", "--show-error", "--max-time", "30", "--include",
      "--suppress-connect-headers", `https://dev-public.example.org/posts/${slug}/`,
    ]));
    expect(result.summary).toContain(`| /posts/${pilot}/ | ${status} | yes |`);
    expect(result.summary).toContain(`| /posts/_shadow-assets/_astro/ | ${status} | yes |`);
  });

  it("accepts the observed Access redirect without logging its login query", () => {
    const result = runStep("Verify signed-out staff admission", {
      STATUS: "302",
      RESPONSE_HEADERS: "Location: https://access.example.org/cdn-cgi/access/login/dev-public.example.org?token=private-fixture\r\n",
      RESPONSE_BODY: "<html>\n<head><title>302 Found</title></head>\n<body>\n<center><h1>302 Found</h1></center>\n<hr><center>cloudflare</center>\n</body>\n</html>\n",
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr + result.summary).not.toContain("private-fixture");
  });

  it.each([
    "https://access.example.org.evil.test/cdn-cgi/access/login/dev-public.example.org",
    "https://access.example.org@evil.test/cdn-cgi/access/login/dev-public.example.org",
    "http://access.example.org/cdn-cgi/access/login/dev-public.example.org",
    "https://access.example.org/another-path",
    "https://admin.njpbs.org/",
    "https://dev-public.example.org/posts/",
    "not a URL",
    "",
  ])("rejects an unapproved 302 location: %s", (location) => {
    const result = runStep("Verify signed-out staff admission", {
      STATUS: "302", RESPONSE_HEADERS: `Location: ${location}\r\n`,
    });
    expect(result.status).toBe(1);
  });

  it.each(["200", "204", "301", "307", "404", "503", "000"])("fails signed-out status %s while recording both results", (status) => {
    const result = runStep("Verify signed-out staff admission", { STATUS: status });
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(2);
    expect(result.summary).toContain(`| /posts/${pilot}/ | ${status} | no |`);
    expect(result.summary).toContain(`| /posts/_shadow-assets/_astro/ | ${status} | no |`);
  });

  it.each(["401", "403", "302"])("rejects leaked HTML/assets and renderer evidence even on %s", (status) => {
    const location = "Location: https://access.example.org/cdn-cgi/access/login/dev-public.example.org\r\n";
    for (const body of ["<article>Private fixture</article>", "body {color:red}", "export default 'asset'"]) {
      const result = runStep("Verify signed-out staff admission", { STATUS: status, RESPONSE_HEADERS: location + staffHeaders, RESPONSE_BODY: body });
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr + result.summary).not.toContain(body);
    }
    expect(runStep("Verify signed-out staff admission", { STATUS: status,
      RESPONSE_BODY: status === "401" ? "Unauthorized" : status === "403" ? "Site access unavailable" : "",
      RESPONSE_HEADERS: location + staffHeaders + "X-Njpbs-Renderer-Sha: " + "a".repeat(40) + "\r\n",
    }).status).toBe(1);
  });

  it.each(["", "Forbidden", "error code: 1010", "error code: 1020"])("rejects a generic edge 403 body: %s", (body) => {
    expect(runStep("Verify signed-out staff admission", { STATUS: "403", RESPONSE_BODY: body }).status).toBe(1);
  });

  it.each(["401", "403"])("requires staff gateway headers for %s", (status) => {
    expect(runStep("Verify signed-out staff admission", { STATUS: status,
      RESPONSE_BODY: status === "401" ? "Unauthorized" : "Site access unavailable",
    }).status).toBe(1);
  });

  it("fails on a network error and records 000 without credentials", () => {
    const result = runStep("Verify signed-out staff admission", { CURL_EXIT: "7" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Signed-out transport failed: exit=7; signal=none; code=none");
    expect(result.summary.match(/\| 000 \| no \|/g)).toHaveLength(2);
  });
});
