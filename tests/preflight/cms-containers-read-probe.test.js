import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { probeCmsContainers } from "../../.github/scripts/cms-containers-read-probe.mjs";

beforeAll(() => vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32)));
afterAll(() => vi.unstubAllEnvs());

const root = new URL("../../", import.meta.url);
const token = "synthetic_containers_token";
const id = "12345678-1234-1234-1234-123456789abc";
const application = { id, name: "njpbs-cms-preview-renderer" };
const response = result => new Response(JSON.stringify({ success: true, result }));
const rollout = index => ({ id: `rollout-${index}`, created_at: "2026-10-29T12:00:00Z", status: "completed" });

describe("trusted Containers read gate", () => {
  it("runs the real workflow step beside an older selected source without the new command", () => {
    const directory = mkdtempSync(join(tmpdir(), "cms-containers-legacy-"));
    try {
      // The selected CLI contract before this PR (367457b78) has no new probe.
      mkdirSync(join(directory, "site/scripts"), { recursive: true });
      const legacy = 'if (!["preflight", "pause", "deploy", "confirm", "seed-context"].includes(process.argv[2])) throw new Error("Unsupported operation");';
      writeFileSync(join(directory, "site/scripts/deploy-cms-preview-cloud.ts"), legacy);
      expect(legacy).not.toContain("probe-containers");
      const runnerTemp = join(directory, "runner-temp");
      const gateDirectory = join(runnerTemp, "release-gate/.github/scripts");
      mkdirSync(gateDirectory, { recursive: true });
      writeFileSync(join(gateDirectory, "cms-containers-read-probe.mjs"),
        readFileSync(new URL(".github/scripts/cms-containers-read-probe.mjs", root)));
      const preload = join(directory, "fetch-fixture.mjs");
      writeFileSync(preload, `
        import { appendFileSync } from "node:fs";
        globalThis.fetch = async (url, options) => {
          if (options.method !== "GET" || options.redirect !== "error") throw new Error("Unsafe request");
          appendFileSync("requests.jsonl", JSON.stringify({url, method: options.method}) + "\\n");
          const result = url.endsWith("/applications") ? [${JSON.stringify(application)}]
            : url.endsWith("/${id}") ? ${JSON.stringify(application)} : [];
          return new Response(JSON.stringify({success: true, result}));
        };
      `);
      const workflow = parse(readFileSync(new URL(".github/workflows/cms-staging-deploy.yml", root), "utf8"));
      const step = workflow.jobs["firebase-preflight"].steps.find(row => row.name === "Check Containers reads before any provider mutation");
      const result = spawnSync("bash", ["-c", step.run], {
        cwd: directory, encoding: "utf8", timeout: 5000,
        env: { PATH: process.env.PATH, RUNNER_TEMP: runnerTemp, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("Cloud preview Containers reads verified\n");
      const requests = readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      expect(requests).toHaveLength(3);
      expect(requests.at(-1).url).toMatch(new RegExp(`/${id}/rollouts\\?limit=100$`));
      expect(result.stdout + result.stderr).not.toContain(token);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["transport", 408, 429, 503])("bounds transient %s failures to three GETs and two deferrals", async status => {
    const request = vi.fn(async () => {
      if (status === "transport") throw new Error("Provider request failed");
      return new Response("private provider response", { status });
    });
    const sleep = vi.fn(async () => {});
    await expect(probeCmsContainers(token, { request, sleep })).rejects.toThrow("could not be verified");
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10000], [10000]]);
    for (const [, options] of request.mock.calls) {
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([400, 401, 403])("does not retry permanent HTTP %s failures", async status => {
    const request = vi.fn(async () => new Response("private provider response", { status }));
    const sleep = vi.fn();
    await expect(probeCmsContainers(token, { request, sleep })).rejects.toThrow("could not be verified");
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers a transient read and permits a first installation", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(response([]));
    const sleep = vi.fn(async () => {});
    await expect(probeCmsContainers(token, { request, sleep })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[10000]]);
  });

  it("reads every rollout page without writing", async () => {
    const request = vi.fn().mockResolvedValueOnce(response([application])).mockResolvedValueOnce(response(application))
      .mockResolvedValueOnce(response(Array.from({ length: 100 }, (_, index) => rollout(index))))
      .mockResolvedValueOnce(response({ rollouts: [rollout(100)] }));
    await probeCmsContainers(token, { request });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.at(-1)[0]).toMatch(/\?limit=100&last=rollout-99$/);
    for (const [, options] of request.mock.calls) expect(options.method).toBe("GET");
  });

  it.each(["identity", "metadata", "repeated-page", "json"])("fails closed for invalid %s without deferring", async invalid => {
    const request = vi.fn().mockResolvedValueOnce(response([application]))
      .mockResolvedValueOnce(response(invalid === "identity" ? { id: "different" } : application));
    const page = Array.from({ length: 100 }, (_, index) => rollout(index));
    request.mockResolvedValueOnce(invalid === "json" ? new Response("invalid json")
      : response(invalid === "metadata" ? [{ id: "incomplete" }] : page));
    if (invalid === "repeated-page") request.mockResolvedValueOnce(response(page));
    const sleep = vi.fn();
    await expect(probeCmsContainers(token, { request, sleep })).rejects.toThrow("could not be verified");
    expect(sleep).not.toHaveBeenCalled();
  });
});
