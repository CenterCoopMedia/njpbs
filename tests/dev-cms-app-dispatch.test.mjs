import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { createInstallationTokenProvider } = require("../functions/lib/cms-dev-publish-app.js");
const { dispatchPublish, defaultDispatchUrl } = require("../functions/publish.js");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = privateKey.export({ type: "pkcs8", format: "pem" });
const installationId = "67890";
const TOKEN_URL = "https://api.github.com/app/installations/67890/access_tokens";
const credentials = { appId: "12345", privateKey: key };
const repository = "fixture-org/publication-target";
const dispatchUrl = `https://api.github.com/repos/${repository}/dispatches`;
const previousRepository = process.env.CMS_PUBLISH_GITHUB_REPOSITORY;

before(() => { process.env.CMS_PUBLISH_GITHUB_REPOSITORY = repository; });
after(() => {
  if (previousRepository === undefined) delete process.env.CMS_PUBLISH_GITHUB_REPOSITORY;
  else process.env.CMS_PUBLISH_GITHUB_REPOSITORY = previousRepository;
});

test("dev exchange signs bounded RS256 claims and scopes its token to the configured dispatch repository", async () => {
  const now = Date.UTC(2026, 9, 9, 12);
  let exchangeCount = 0;
  const provider = createInstallationTokenProvider({ installationId, now: () => now, fetchImpl: async (url, options) => {
    exchangeCount++;
    assert.equal(url, TOKEN_URL);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Accept, "application/vnd.github+json");
    assert.deepEqual(JSON.parse(options.body), { repositories: ["publication-target"], permissions: { contents: "write" } });
    const jwt = options.headers.Authorization.slice("Bearer ".length);
    const [header, claims, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), {
      iat: now / 1000 - 60, exp: now / 1000 + 540, iss: "12345",
    });
    assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey,
      Buffer.from(signature, "base64url")), true);
    return { ok: true, status: 201, json: async () => ({ token: "installation-token", expires_at: new Date(now + 3600000).toISOString() }) };
  } });
  const token = await provider(credentials);
  assert.equal(token, "installation-token");
  const payload = { event_type: "cms_dev_publish", client_payload: { queueId: "q" } };
  assert.equal(defaultDispatchUrl(), dispatchUrl);
  const dispatch = await dispatchPublish({ token, payload, redactError: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, dispatchUrl);
      assert.equal(options.headers.Authorization, "Bearer installation-token");
      assert.deepEqual(JSON.parse(options.body), payload);
      return { ok: true, status: 204 };
    } });
  assert.deepEqual(dispatch, { dispatched: true, status: 204 });
  assert.equal(exchangeCount, 1);
});

test("dev token exchange and dispatch refuse missing or invalid repository configuration", async () => {
  let exchanges = 0;
  const provider = createInstallationTokenProvider({ installationId, fetchImpl: async () => {
    exchanges++;
    return { ok: true, json: async () => ({ token: "installation-token", expires_at: new Date(Date.now() + 3600000).toISOString() }) };
  } });
  // Validate configuration even when this warm provider already has a token.
  await provider(credentials);
  try {
    for (const value of [undefined, "", "fixture-org/REPLACE_ME", "fixture-org/..", "fixture-org/target/extra"]) {
      if (value === undefined) delete process.env.CMS_PUBLISH_GITHUB_REPOSITORY;
      else process.env.CMS_PUBLISH_GITHUB_REPOSITORY = value;
      await assert.rejects(provider(credentials), /Publish dispatch repository is not approved/);
      assert.throws(defaultDispatchUrl, /Publish dispatch repository is not approved/);
    }
    assert.equal(exchanges, 1);
  } finally {
    process.env.CMS_PUBLISH_GITHUB_REPOSITORY = repository;
  }
});

test("dev token cache and concurrent exchanges stay bound to the configured repository", async () => {
  const scopes = [];
  const provider = createInstallationTokenProvider({ installationId, fetchImpl: async (_url, options) => {
    const target = JSON.parse(options.body).repositories[0];
    scopes.push(target);
    return { ok: true, json: async () => ({ token: `token-${target}`, expires_at: new Date(Date.now() + 3600000).toISOString() }) };
  } });
  try {
    const first = provider(credentials);
    process.env.CMS_PUBLISH_GITHUB_REPOSITORY = "fixture-org/second-target";
    const second = provider(credentials);
    assert.deepEqual(await Promise.all([first, second]), ["token-publication-target", "token-second-target"]);
    assert.equal(await provider(credentials), "token-second-target");
    assert.deepEqual(scopes, ["publication-target", "second-target"]);
  } finally {
    process.env.CMS_PUBLISH_GITHUB_REPOSITORY = repository;
  }
});

test("dev installation token is cached and refreshed five minutes before expiry", async () => {
  let now = Date.UTC(2026, 9, 9, 12);
  let exchanges = 0;
  const provider = createInstallationTokenProvider({ installationId, now: () => now, fetchImpl: async () => {
    exchanges++;
    return { ok: true, json: async () => ({ token: `token-${exchanges}`, expires_at: new Date(now + 3600000).toISOString() }) };
  } });
  assert.deepEqual(await Promise.all([provider(credentials), provider(credentials)]), ["token-1", "token-1"]);
  assert.equal(exchanges, 1);
  now += 55 * 60000 - 1;
  assert.equal(await provider(credentials), "token-1");
  now += 1;
  assert.equal(await provider(credentials), "token-2");
  assert.equal(exchanges, 2);
});

test("dev exchange and dispatch failures reveal no credentials or response body", async () => {
  const secret = "fixture-private-key-or-token";
  const failed = createInstallationTokenProvider({ installationId, fetchImpl: async () => ({ ok: false, status: 403,
    text: async () => secret }) });
  await assert.rejects(failed(credentials), error => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    // The HTTP status separates a bad key (401), a removed installation (404)
    // and a missing permission (422) without exposing the response.
    assert.match(error.message, /failed with HTTP 403$/);
    return true;
  });
  await assert.rejects(createInstallationTokenProvider({ installationId, fetchImpl: async () => {
    throw new Error(secret);
  } })(credentials), /Development publication App token unavailable/);
  const rejected = await dispatchPublish({ token: secret, payload: {}, redactError: true,
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => secret }) });
  assert.deepEqual(rejected, { dispatched: false, skipped: false, status: 403,
    error: "Development GitHub dispatch rejected" });
  await assert.rejects(dispatchPublish({ token: secret, payload: {}, redactError: true,
    fetchImpl: async () => { throw new Error(secret); } }), /Development GitHub dispatch unavailable/);
});

test("production dispatch keeps its static bearer request and GitHub error body", async () => {
  const payload = { event_type: "cms_publish", client_payload: { queueId: "q", triggeredBy: "u" } };
  const result = await dispatchPublish({ token: "static-token", payload,
    fetchImpl: async (url, options) => {
      assert.equal(url, defaultDispatchUrl());
      assert.deepEqual(options.headers, {
        Authorization: "Bearer static-token", Accept: "application/vnd.github+json",
        "Content-Type": "application/json", "User-Agent": "njpbs-cms-publish",
      });
      assert.deepEqual(JSON.parse(options.body), payload);
      return { ok: false, status: 422, text: async () => "production response" };
    } });
  assert.deepEqual(result, { dispatched: false, skipped: false, status: 422, error: "production response" });
});

test("dev credential reader refuses a mixed static-token or installation configuration", () => {
  const script = 'require("./functions/lib/cms-publish-credentials").readDevAppCredentials()';
  const base = { ...process.env, CMS_DEPLOYMENT_ENVIRONMENT: "development", GCLOUD_PROJECT: "njpbs-site-dev",
    CMS_PUBLISH_GITHUB_APP_ID: "1234567", CMS_DEV_PUBLISH_APP_ID: "1234567", CMS_DEV_PUBLISH_APP_PRIVATE_KEY: key };
  for (const extra of [{ CMS_PUBLISH_GITHUB_TOKEN: "mixed-static-token" },
    { CMS_DEV_PUBLISH_APP_ID: "999" }]) {
    const run = spawnSync(process.execPath, ["-e", script], { cwd: new URL("../", import.meta.url),
      env: { ...base, ...extra }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /configuration is mixed or invalid|credentials are not configured/);
    assert.doesNotMatch(run.stderr, /mixed-static-token|BEGIN PRIVATE KEY/);
  }
});
