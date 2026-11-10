import { generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import reportConfig from "../../functions/lib/bug-report-github-config.js";
import app from "../../functions/lib/cms-dev-publish-app.js";
import dispatch from "../../functions/lib/cms-publish-dispatch.js";

afterEach(() => vi.unstubAllEnvs());

describe("configured publication actors", () => {
  const production = { eventName: "repository_dispatch", action: "cms_publish", ref: "refs/heads/main",
    sender: "fixture-user", actor: "fixture-user", payload: { queueId: "A".repeat(20) } };
  const development = { ...production, action: "cms_dev_publish", sender: "fixture-dev[bot]", actor: "fixture-dev[bot]",
    payload: { ...production.payload, environment: "development", projectId: "njpbs-site-dev", transport: "github" } };

  it.each([undefined, "", "[]", "{}", "not-json", '["fixture-user",null]', '["invalid/actor"]'])(
    "denies both dispatch environments with invalid or empty actor configuration: %s", (value) => {
      vi.stubEnv("CMS_PUBLISH_GITHUB_TRUSTED_ACTORS", value);
      expect(() => dispatch.assertPublishDispatch(production, "production", "fixture-dev[bot]")).toThrow();
      expect(() => dispatch.assertPublishDispatch(development, "development", "fixture-dev[bot]")).toThrow();
    },
  );

  it("admits configured production and separate development actors while keeping identity and environment fences", () => {
    vi.stubEnv("CMS_PUBLISH_GITHUB_TRUSTED_ACTORS", JSON.stringify(["fixture-user", "fixture-reviewer"]));
    expect(() => dispatch.assertPublishDispatch(production, "production", "fixture-dev[bot]")).not.toThrow();
    expect(() => dispatch.assertPublishDispatch(development, "development", "fixture-dev[bot]")).not.toThrow();
    for (const value of [
      { ...production, actor: "fixture-reviewer" },
      { ...production, actor: "unknown", sender: "unknown" },
      { ...production, ref: "refs/heads/other" },
      { ...production, payload: development.payload },
    ]) expect(() => dispatch.assertPublishDispatch(value, "production", "fixture-dev[bot]")).toThrow();
    expect(() => dispatch.assertPublishDispatch({ ...development, sender: "fixture-user", actor: "fixture-user" },
      "development", "fixture-user")).toThrow();
  });
});

describe("private report destination", () => {
  it.each([undefined, "", " \n\t ", "owner/repo/extra", "https://example.org/repo"])(
    "refuses missing or malformed configuration: %s", (value) => {
      vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY", value);
      expect(() => reportConfig.githubRepository()).toThrow("A private report repository must be configured");
    },
  );

  it("uses only the explicitly configured report repository", () => {
    vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY", " example-owner/private-reports \n");
    expect(reportConfig.githubRepository()).toBe("example-owner/private-reports");
  });
});

describe("publication App installation", () => {
  it.each(["", " ", "not-an-id", "123/extra"])("refuses %s before signing or provider work", async (value) => {
    vi.stubEnv("CMS_PUBLISH_GITHUB_INSTALLATION_ID", value);
    const fetchImpl = vi.fn();
    await expect(app.createInstallationTokenProvider({ fetchImpl })({ appId: "123", privateKey: "unused" }))
      .rejects.toThrow("App credentials are not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("restricts the configured installation token to the publication repository and reuses it", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.parse("2026-01-01T00:00:00Z");
    vi.stubEnv("CMS_PUBLISH_GITHUB_INSTALLATION_ID", "123456");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      token: "synthetic-installation-token", expires_at: new Date(now + 3_600_000).toISOString(),
    })));
    const token = app.createInstallationTokenProvider({ fetchImpl, now: () => now });
    const credentials = { appId: "123", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) };
    await expect(token(credentials)).resolves.toBe("synthetic-installation-token");
    await expect(token(credentials)).resolves.toBe("synthetic-installation-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/123456/access_tokens");
    expect(JSON.parse(options.body)).toEqual({ repositories: ["njpbs"], permissions: { contents: "write" } });
    const parts = options.headers.Authorization.slice("Bearer ".length).split(".");
    expect(verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), publicKey,
      Buffer.from(parts[2], "base64url"))).toBe(true);
  });
});

// Separate processes exercise the cold-start parameter snapshot and SecretParam
// boundary without changing this process's module cache.
describe("publication App identity", () => {
  const directory = fileURLToPath(new URL("../..", import.meta.url));
  const env = { ...process.env, CMS_DEPLOYMENT_ENVIRONMENT: "development",
    CMS_PUBLISH_GITHUB_TOKEN: "", CMS_DEV_PUBLISH_APP_ID: "1234567",
    CMS_DEV_PUBLISH_APP_PRIVATE_KEY: "synthetic-key" };
  const check = (configured, expected) => execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const credentials = require("./functions/lib/cms-publish-credentials.js");
    ${expected}
  `], { cwd: directory, env: { ...env, CMS_PUBLISH_GITHUB_APP_ID: configured }, encoding: "utf8" });

  it.each(["", "invalid", "999"])("fails closed for missing, malformed or mismatched App identity: %s", value => {
    expect(check(value, 'assert.throws(() => credentials.readDevAppCredentials(), /App credentials are not configured/);')).toBe("");
  });

  it("pins the configured identity at cold start while keeping App credentials in secret params", () => {
    expect(check("1234567", `
      assert.deepEqual(credentials.readDevAppCredentials(), { appId: "1234567", privateKey: "synthetic-key" });
      process.env.CMS_PUBLISH_GITHUB_APP_ID = "999";
      assert.deepEqual(credentials.readDevAppCredentials(), { appId: "1234567", privateKey: "synthetic-key" });
      process.env.CMS_DEV_PUBLISH_APP_ID = "999";
      assert.throws(() => credentials.readDevAppCredentials(), /App credentials are not configured/);
    `)).toBe("");
  });
});
