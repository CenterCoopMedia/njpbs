import { describe, expect, it, vi } from "vitest";
import { PublicWorkerActivationOperatorError } from "../../site/scripts/activate-public-worker-candidate";
import { checkPublicWorkerActivationAccess } from "../../site/scripts/check-public-worker-activation-access";

const ACCOUNT = "https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKER_NAME = "njpbs-production";
const WORKER_TAG = "d".repeat(32);
const TOKEN = "t".repeat(40);

// Provider replies as the production account returned them on October 13, 2026.
const replies: Record<string, unknown> = {
  [`${ACCOUNT}/workers/scripts`]: { success: true, result: [{ id: WORKER_NAME, tag: WORKER_TAG }] },
  [`${ACCOUNT}/builds/workers/${WORKER_TAG}/triggers`]: { success: true, result: [{
    trigger_uuid: "11111111-1111-4111-8111-111111111111", external_script_id: WORKER_TAG,
    deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc", root_directory: "/", branch_includes: ["production"], branch_excludes: [],
  }] },
  [`${ACCOUNT}/workers/scripts/${WORKER_NAME}/subdomain`]: { success: true, result: { enabled: false, previews_enabled: false } },
  [`${ACCOUNT}/workers/scripts/${WORKER_NAME}/deployments`]: { success: true, result: { deployments: [{
    id: "33333333-3333-4333-8333-333333333333", versions: [{ version_id: "22222222-2222-4222-8222-222222222222", percentage: 100 }],
  }] } },
};

function provider(overrides: Record<string, unknown | Error> = {}) {
  return vi.fn(async (request: { url: string; method: string; token: string }) => {
    const reply = request.url in overrides ? overrides[request.url] : replies[request.url];
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error(`unexpected request ${request.url}`);
    return reply;
  });
}

describe("activation access check", () => {
  it("passes all four reads and sends reads only", async () => {
    const requestJson = provider();
    const checks = await checkPublicWorkerActivationAccess({ cloudflareApiToken: TOKEN, requestJson });
    expect(checks).toEqual([
      { read: "worker-identity", ok: true },
      { read: "build-trigger", ok: true },
      { read: "worker-subdomain", ok: true },
      { read: "active-deployment", ok: true },
    ]);
    expect(requestJson.mock.calls.map(([request]) => request.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(requestJson.mock.calls.every(([request]) => request.token === TOKEN && !("body" in request))).toBe(true);
  });

  it("names the build trigger read when the token cannot make it and still reports the other reads", async () => {
    const requestJson = provider({
      [`${ACCOUNT}/builds/workers/${WORKER_TAG}/triggers`]: new PublicWorkerActivationOperatorError("The Cloudflare API returned HTTP 403"),
    });
    const checks = await checkPublicWorkerActivationAccess({ cloudflareApiToken: TOKEN, requestJson });
    expect(checks).toEqual([
      { read: "worker-identity", ok: true },
      { read: "build-trigger", ok: false, reason: "The Cloudflare API returned HTTP 403" },
      { read: "worker-subdomain", ok: true },
      { read: "active-deployment", ok: true },
    ]);
    expect(JSON.stringify(checks)).not.toContain(TOKEN);
  });

  it("refuses a trigger that can deploy, an enabled subdomain and an unreadable deployment", async () => {
    const requestJson = provider({
      [`${ACCOUNT}/builds/workers/${WORKER_TAG}/triggers`]: { success: true, result: [{
        trigger_uuid: "11111111-1111-4111-8111-111111111111", external_script_id: WORKER_TAG,
        deploy_command: "npx wrangler deploy", root_directory: "/", branch_includes: ["production"], branch_excludes: [],
      }] },
      [`${ACCOUNT}/workers/scripts/${WORKER_NAME}/subdomain`]: { success: true, result: { enabled: true, previews_enabled: false } },
      [`${ACCOUNT}/workers/scripts/${WORKER_NAME}/deployments`]: { success: true, result: { deployments: [] } },
    });
    const checks = await checkPublicWorkerActivationAccess({ cloudflareApiToken: TOKEN, requestJson });
    expect(checks.map(entry => [entry.read, entry.ok])).toEqual([
      ["worker-identity", true], ["build-trigger", false], ["worker-subdomain", false], ["active-deployment", false],
    ]);
    expect(checks[1].reason).toBe("The Cloudflare production trigger is not upload-only");
    expect(checks[2].reason).toBe("The production Worker subdomain is not disabled");
  });

  it("does not ask for the trigger when the Worker identity is not read, and hides unknown error text", async () => {
    const requestJson = provider({ [`${ACCOUNT}/workers/scripts`]: new Error(`socket failed for Bearer ${TOKEN}`) });
    const checks = await checkPublicWorkerActivationAccess({ cloudflareApiToken: TOKEN, requestJson });
    expect(checks.slice(0, 2)).toEqual([
      { read: "worker-identity", ok: false, reason: "The read did not complete" },
      { read: "build-trigger", ok: false, reason: "The Worker identity was not read" },
    ]);
    expect(requestJson.mock.calls.map(([request]) => request.url)).not.toContain(`${ACCOUNT}/builds/workers/${WORKER_TAG}/triggers`);
    expect(JSON.stringify(checks)).not.toContain(TOKEN);
  });
});
