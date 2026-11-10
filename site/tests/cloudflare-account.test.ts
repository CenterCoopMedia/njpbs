// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflareAccount, cloudflareR2Endpoint, cloudflarePublicZone, cloudflarePublicWorkerTag } from "../scripts/cloudflare-account.mjs";
import { workerApiPath } from "../scripts/public-worker-cloudflare";
import { createCmsPublicationCloudStorage } from "../scripts/cms-publication-cloud-storage";
import { createBootstrapS3Reads } from "../scripts/public-release-bootstrap-s3-read";
import { createSpotlightImageStorage } from "../scripts/spotlight-image-cache.mjs";
import { previewPairConfiguration } from "../scripts/deploy-cms-preview-pair";

const account = "0123456789abcdef0123456789abcdef";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("cloud account configuration", () => {
  it.each([
    ["CLOUDFLARE_PUBLIC_ZONE_ID", cloudflarePublicZone],
    ["CLOUDFLARE_PUBLIC_WORKER_TAG", cloudflarePublicWorkerTag],
  ] as const)("requires an explicit valid resource pin for %s", (name, resolve) => {
    expect(resolve({ [name]: account })).toBe(account);
    for (const value of [undefined, "", "REPLACE_ME", "a".repeat(31), "a".repeat(33),
      "A".repeat(32), `${account}\n`, `${account}.example.org`]) {
      expect(() => resolve({ [name]: value })).toThrow(`${name} must be configured`);
    }
    vi.stubEnv(name, account);
    expect(resolve()).toBe(account);
  });
  it("resolves an account and R2 endpoint from explicit configuration", () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: account };
    expect(cloudflareAccount(env)).toBe(account);
    expect(cloudflareR2Endpoint(env)).toBe(`https://${account}.r2.cloudflarestorage.com`);
  });
  it.each([undefined, "", "REPLACE_ME_CLOUDFLARE_ACCOUNT_ID", "a".repeat(31), "a".repeat(33),
    "A".repeat(32), `${account}\n`, `${account}.example.org`])("rejects missing or malformed account settings (%#)", value => {
    expect(() => cloudflareAccount({ CLOUDFLARE_ACCOUNT_ID: value })).toThrow("CLOUDFLARE_ACCOUNT_ID must be configured");
  });
  it("refuses an API path before any fetch when the account is missing", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => workerApiPath("/workers/scripts")).toThrow("CLOUDFLARE_ACCOUNT_ID must be configured");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the configured account for API paths", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", account);
    expect(workerApiPath("/workers/scripts")).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`);
  });
  it("supplies the same account to preview deployment and its runtime binding", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", account);
    const imageDigest = `sha256:${"a".repeat(64)}`;
    const config = previewPairConfiguration({ schemaVersion: 2, pairId: "preview-fixture", serializerId: "preview-fixture",
      rendererSha: "a".repeat(40), workerName: "njpbs-preview-fixture", applicationName: "njpbs-preview-fixture",
      workerVersion: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", imageDigest,
      requirements: { previewRequest: 1, postChrome: 1, settings: 1, capabilities: 1, adminSession: 1 },
      capabilities: { dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 1 } },
      { main: "/fixture/preview-renderer/worker.ts", image: `registry.cloudflare.com/fixture@${imageDigest}` });
    expect(config.account_id).toBe(account);
    expect(config.vars.CLOUDFLARE_ACCOUNT_ID).toBe(account);
  });
  it("refuses publication storage before creating an unconfigured cloud client", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    expect(() => createCmsPublicationCloudStorage({ accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" }))
      .toThrow("CLOUDFLARE_ACCOUNT_ID must be configured");
  });
  it("refuses bootstrap storage before reading credentials", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    const readCredential = vi.fn();
    expect(() => createBootstrapS3Reads({ environment: "production", readCredential }))
      .toThrow("CLOUDFLARE_ACCOUNT_ID must be configured");
    expect(readCredential).not.toHaveBeenCalled();
  });
  it("allows the unconfigured image-cache fallback, and validates only when cloud writes are configured", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    expect(createSpotlightImageStorage(undefined)).toBeUndefined();
    expect(() => createSpotlightImageStorage({ accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" }))
      .toThrow("CLOUDFLARE_ACCOUNT_ID must be configured");
  });
});
