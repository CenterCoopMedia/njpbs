import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, vi } from "vitest";
import functionsEnv from "firebase-tools/lib/functions/env.js";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, cpSync, symlinkSync, writeFileSync, statSync, rmSync } from "node:fs";
import { loadFunctionSource } from "../../scripts/lib/functions-deploy-inventory.mjs";
import { DEPLOYMENT_COMPONENTS } from "../../scripts/lib/deployment-components.mjs";
import { configurationInputs, runtimeParameters, runtimeDotenv, validateDeploymentConfiguration,
  CMS_RELEASE_SECRET_NAMES, FUNCTION_SECRETS, NATIVE_CONFIGURATION, validateConfigurationTable, desiredSecret } from "../../scripts/lib/functions-configuration.mjs";
import { configurationRequirements, verifyOrProvision, mediaCanary, verifyMediaBindings, verifyNativeResources, nativeConfigurationProvider,
  provisionDiscoverySecrets, resolveDiscovery } from "../../scripts/configure-cms-functions.mjs";
import { prepareCloudPublicationWake } from "../../scripts/prepare-cloud-publication-wake.mjs";

const deploy = "deployer@example.iam.gserviceaccount.com", runtime = "runtime@example.iam.gserviceaccount.com";
const access = "CMS_MEDIA_R2_ACCESS_KEY_ID", secret = "CMS_MEDIA_R2_SECRET_ACCESS_KEY", edge = "CMS_EDGE_ORIGIN_SECRET";
const config = { projectId: "njpbs-site", region: "us-central1", codebase: "default", mediaCredentialVersions: {
  [access]: `projects/njpbs-site/secrets/${access}/versions/1`, [secret]: `projects/njpbs-site/secrets/${secret}/versions/1`,
} };
const ttlGroups = ["staffAccessRequests", "staffPasswordResetRequests", "bugReportEvidence", "ugcSubmissions",
  "bugReportGithubWebhookReceipts", "staffAccessNotificationCooldowns", "staffSignInRefusedCooldowns"];
const ttlName = group => `projects/njpbs-site/databases/(default)/collectionGroups/${group}/fields/expireAt`;
const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "fixture-api-token", CMS_MEDIA_R2_BUCKET: "fixture-media",
  CMS_EDGE_ORIGIN_SECRET: "e".repeat(32) };
function discovery() {
  return { CMS_MEDIA_PURGE_SWEEP_ENABLED: "false", CMS_MEDIA_PURGE_REAL_DELETES_ENABLED: "false", COST_LEDGER_GCP_PULL: "false",
    COST_LEDGER_CLOUDFLARE_PULL: "false", COST_LEDGER_AWS_PULL: "false", COST_LEDGER_GITHUB_PULL: "false", COST_LEDGER_GCP_PROJECT: "",
    COST_LEDGER_GCP_BILLING_TABLE: "", COST_LEDGER_CLOUDFLARE_ACCOUNT_ID: "", COST_LEDGER_GITHUB_ACCOUNT: "", COST_LEDGER_GITHUB_ACCOUNT_TYPE: "" };
}
function input() {
  return configurationInputs({ ...env, UGC_R2_BUCKET: "fixture-ugc", CMS_VOICEOVER_R2_BUCKET: "fixture-voiceover",
    CMS_ANALYTICS_CF_ZONE_ID: "b".repeat(32), CMS_MEDIA_CLOUDFLARE_ZONE_ID: "c".repeat(32), CMS_ANALYTICS_MAILCHIMP_AUDIENCE_ID: "d".repeat(10),
    CMS_ADMIN_BUILD_REVISION: "a".repeat(40), CMS_PREVIEW_RENDERER_SHA: "b".repeat(40),
    CMS_BUG_REPORT_TELEGRAM_CHAT_ID: "123", CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP: '{"123":"fixture-user"}',
    VITE_LIVE_PRODUCTION_ENABLED: "false" });
}
function fixture() {
  const requirements = new Map([edge, access, secret].map(name => [name, new Set([runtime])]));
  const values = { [edge]: env.CMS_EDGE_ORIGIN_SECRET, [access]: "a".repeat(32), [secret]: "b".repeat(64) };
  const versions = { [edge]: 1, [access]: 1, [secret]: 1 };
  const versionName = name => `projects/njpbs-site/secrets/${name}/versions/${versions[name]}`;
  const auth = { name: "projects/njpbs-site/config", signIn: { email: { enabled: true, passwordRequired: true } } };
  const ttl = ttlGroups.map(group => ({ name: ttlName(group), ttlConfig: { state: "ACTIVE" } }));
  const policies = Object.fromEntries([...requirements.keys()].map(name => [name, { bindings: [
    { role: "roles/secretmanager.admin", members: [`serviceAccount:${deploy}`] },
    { role: "roles/secretmanager.secretAccessor", members: [`serviceAccount:${runtime}`] },
  ] }]));
  const calls = [];
  const provider = { account: deploy, number: "123456789", client: { request: vi.fn(async ({ url, method, data }) => {
    const name = url.match(/\/secrets\/([^/:]+)/)?.[1];
    if (method === "POST") { versions[name]++; values[name] = Buffer.from(data.payload.data, "base64").toString(); return { data: { name: versionName(name), state: "ENABLED" } }; }
    if (url.endsWith("/versions/latest")) return { data: { name: versionName(name), state: "ENABLED" } };
    if (url.endsWith(":access")) return { data: { name: versionName(name), payload: { data: Buffer.from(values[name]).toString("base64") } } };
    throw new Error("unexpected fake provider request");
  }) },
    authSettings: vi.fn(async () => structuredClone(auth)),
    enableEmailAuth: vi.fn(async () => { auth.signIn.email = { enabled: true, passwordRequired: true }; }),
    ttlFields: vi.fn(async () => structuredClone(ttl)),
    enableTtl: vi.fn(async group => { ttl.find(field => field.name === ttlName(group)).ttlConfig.state = "CREATING"; }),
    version: vi.fn(async name => { calls.push(`version:${name}`); return { name: versionName(name), canonicalName: versionName(name), state: "ENABLED" }; }),
    payload: vi.fn(async name => Buffer.from(values[name])), lifecycle: vi.fn(async () => calls.push("lifecycle")),
    policy: vi.fn(name => JSON.stringify(policies[name])), ensureResource: vi.fn(),
    grant: vi.fn((name, account, role) => policies[name].bindings.push({ role, members: [`serviceAccount:${account}`] })) };
  const s3 = { send: vi.fn(async command => { calls.push(command.constructor.name); return {}; }), destroy: vi.fn() };
  return { requirements, values, versions, auth, ttl, policies, calls, provider, s3, createClient: vi.fn(() => s3) };
}

describe("Functions configuration contract", () => {
  it("takes the report repository only from its own variable and supplies the original buckets", () => {
    const variables = JSON.stringify({ CMS_BUG_REPORT_GITHUB_REPOSITORY: "example-owner/private-reports",
      CMS_MEDIA_ORIGINAL_BUCKETS: "fixture-originals,fixture-archive" });
    // The deploying repository can be public. It never becomes the report destination.
    expect(configurationInputs({ ...env, GITHUB_REPOSITORY: "example-owner/public-source" }).CMS_BUG_REPORT_GITHUB_REPOSITORY).toBe("");
    const supplied = configurationInputs({ ...env, GITHUB_REPOSITORY: "example-owner/public-source", CMS_DEPLOYMENT_VARIABLES_JSON: variables });
    expect(supplied.CMS_BUG_REPORT_GITHUB_REPOSITORY).toBe("example-owner/private-reports");
    expect(supplied.CMS_MEDIA_ORIGINAL_BUCKETS).toBe("fixture-originals,fixture-archive");
    expect(runtimeDotenv(runtimeParameters({ ...input(), CMS_MEDIA_ORIGINAL_BUCKETS: "fixture-originals,fixture-archive" }, discovery())))
      .toContain("CMS_MEDIA_ORIGINAL_BUCKETS=fixture-originals,fixture-archive\n");
    expect(() => runtimeParameters({ ...input(), CMS_MEDIA_ORIGINAL_BUCKETS: "Not A Bucket" }, discovery())).toThrow();
  });
  it("enables replacement only when the cleanup role and replica bucket can perform cleanup", () => {
    const module = fileURLToPath(new URL("../../functions/lib/media-source-runtime.js", import.meta.url));
    const cases = [
      { role: "", bucket: "fixture-replica", dryRun: "false" },
      { role: "fixture-role", bucket: "", dryRun: "false" },
      { role: "fixture-role", bucket: "fixture-replica", dryRun: "true" },
      { role: "fixture-role", bucket: "fixture-replica", dryRun: "false" },
    ];
    const result = spawnSync(process.execPath, ["-e", `
      const { videoReplacementRuntimeConfig } = require(process.argv[1]);
      const results = JSON.parse(process.argv[2]).map(({ role, bucket, dryRun }) => {
        process.env.CMS_VIDEO_REPLACEMENT_CLEANUP_ROLE_ARN = role;
        process.env.CMS_VIDEO_REPLACEMENT_REPLICA_BUCKET = bucket;
        process.env.CMS_VIDEO_REPLACEMENT_CLEANUP_DRY_RUN = dryRun;
        return videoReplacementRuntimeConfig();
      });
      process.stdout.write(JSON.stringify(results));
    `, module, JSON.stringify(cases)], { encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(result.status, result.stderr).toBe(0);
    const configs = JSON.parse(result.stdout);
    expect(configs.map(config => config.enabled)).toEqual([false, false, false, true]);
    expect(configs[3]).toEqual({ cleanupRoleArn: "fixture-role", replicaBucket: "fixture-replica", dryRun: false, enabled: true });
  });

  it("writes the same native dotenv values, including optional groups and private JSON punctuation", () => {
    const values = input();
    values.CMS_STAFF_EMAIL_FROM = "Fixture's \"Desk\" <sender@example.org>";
    values.CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP = JSON.stringify({ "123": "fixture # user's" }, null, 2);
    const parameters = runtimeParameters(values, discovery());
    for (const key of ["CMS_MEDIA_R2_ENDPOINT", "CMS_PRIVATE_VIDEO_R2_ENDPOINT", "CMS_VOICEOVER_R2_ENDPOINT"]) {
      expect(parameters[key]).toBe(`https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
    }
    expect(parameters.CMS_MEDIA_MASTER_R2_BUCKET).toBe("");
    expect(parameters.CMS_MEDIA_PUBLIC_ORIGIN).toBe("https://media.njpbs.org");
    expect(parameters.CMS_MEDIA_MAX_UPLOAD_BYTES).toBe("26214400");
    expect(parameters).not.toHaveProperty("NO_BUILD_POST_ENABLED");
    expect(functionsEnv.parseStrict(runtimeDotenv(parameters))).toEqual(parameters);
    expect(JSON.parse(parameters.CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP)).toEqual({ "123": "fixture # user's" });
    expect(runtimeDotenv(parameters)).toContain(`CMS_ADMIN_BUILD_REVISION=${"a".repeat(40)}\n`);
    expect(parameters.CMS_DEPLOYMENT_ENVIRONMENT).toBe("production");
    values.NO_BUILD_POST_ENABLED = "false"; values.NO_BUILD_POST_ID = "fixture-post"; values.NO_BUILD_POST_BACKGROUND_BUCKET = "fixture-background";
    expect(runtimeParameters(values, discovery()).NO_BUILD_POST_ID).toBe("fixture-post");
    expect(() => runtimeParameters({ ...values, NO_BUILD_POST_BACKGROUND_BUCKET: "" }, discovery())).toThrow(/instant publication/);
  });

  it("configures a private local dotenv file through the shared CLI without credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "functions-config-"));
    try {
      for (const path of ["functions", "scripts", "config"]) mkdirSync(join(directory, path));
      for (const path of ["config/functions-deployment.json", "scripts/resolve-media-purge.sh", "scripts/resolve-cost-ledger-pulls.sh"]) {
        copyFileSync(new URL(`../../${path}`, import.meta.url), join(directory, path));
      }
      const target = join(directory, "functions/.env.njpbs-site");
      writeFileSync(target, "old local fixture", { mode: 0o644 });
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/component-runner.mjs", import.meta.url)), "functions", "configure"], {
        cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH, ...input() },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^Configured [0-9]+ Functions runtime parameters\n$/);
      expect(functionsEnv.parseStrict(readFileSync(target, "utf8"))).toEqual(runtimeParameters(input(), discovery()));
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects unknown inputs, malformed scopes, missing required values, bad types and dotenv injection without echoing values", () => {
    for (const patch of [{ UNKNOWN_INPUT: "private-canary" }, { CMS_ANALYTICS_CF_ZONE_ID: "private-canary" },
      { CLOUDFLARE_ACCOUNT_ID: "" }, { CMS_PRIVATE_VIDEO_ENABLED: "private-canary" },
      { TVSS_CALLSIGN: "private-canary\nINJECTED=value" }, { CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP: '{"123":"bad/user"}' }]) {
      try { runtimeParameters({ ...input(), ...patch }, discovery()); throw new Error("accepted invalid input"); }
      catch (error) { expect(error.message).not.toContain("private-canary"); expect(error.message).not.toBe("accepted invalid input"); }
    }
    for (const bad of [{ ...config, UNKNOWN: true }, { ...config, projectId: "other" }, { ...config, region: "europe-west1" },
      { ...config, codebase: "other" }, { ...config, mediaCredentialVersions: { ...config.mediaCredentialVersions, [access]: `projects/other/secrets/${access}/versions/1` } }]) {
      expect(() => validateDeploymentConfiguration(bad)).toThrow();
    }
  });

  it("binds every configured parameter and current export secret through real SDK discovery", () => {
    const requirements = configurationRequirements(loadFunctionSource("njpbs-site"), "123456789", runtimeParameters(input(), discovery()));
    expect(requirements.has("CUEZ_STORYDESK_API_KEY")).toBe(true);
    expect([...requirements.keys()].every(name => Object.hasOwn(FUNCTION_SECRETS, name))).toBe(true);
    expect(CMS_RELEASE_SECRET_NAMES).toHaveLength(9);
    const unknown = { fn: { __endpoint: { platform: "gcfv2", secretEnvironmentVariables: [{ key: "UNKNOWN_SECRET" }] } } };
    expect(() => configurationRequirements(unknown, "123456789", {})).toThrow(/Unmapped/);
  });

  it("bootstraps requested optional secrets before rediscovery and maps enabled cloud wake through the real SDK", async () => {
    const root = mkdtempSync(join(tmpdir(), "functions-discovery-"));
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    const values = Object.fromEntries(Object.entries(FUNCTION_SECRETS).filter(([, row]) => row.discoveryFlag)
      .map(([name]) => [name, `fixture-${name}`]));
    const ready = new Set();
    const provider = { ensureResource: vi.fn(), version: vi.fn(async name => {
      if (!ready.has(name)) throw new Error(`Missing enabled version: ${name}`);
    }), client: { request: vi.fn(async ({ url, method }) => {
      const name = url.match(/\/secrets\/([^/:]+)/)[1];
      if (method === "POST") {
        ready.add(name); writeFileSync(join(root, name), "ENABLED");
        return { data: { name: `projects/njpbs-site/secrets/${name}/versions/1`, state: "ENABLED" } };
      }
      if (url.endsWith("/versions/latest")) throw { response: { status: 404 } };
      return { data: { name: `projects/njpbs-site/secrets/${name}` } };
    }) } };
    try {
      cpSync(join(repo, "functions"), join(root, "functions"), { recursive: true, filter: path => !path.includes("node_modules") });
      cpSync(join(repo, "firebase.json"), join(root, "firebase.json"));
      cpSync(join(repo, "scripts"), join(root, "scripts"), { recursive: true });
      symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
      symlinkSync(join(repo, "packages"), join(root, "packages"), "dir");
      writeFileSync(join(root, "gcloud"), `#!${process.execPath}\nconst {readFileSync}=require('node:fs');
        const name=process.argv.find(arg=>arg.startsWith('--secret=')).slice(9);
        try { process.stdout.write(readFileSync(${JSON.stringify(root)}+'/'+name)); } catch { process.exitCode=1; }\n`, { mode: 0o755 });
      const requested = { ...input(), ...values, PATH: `${root}:${process.env.PATH}`,
        COST_LEDGER_GCP_PULL: "true", COST_LEDGER_GCP_PROJECT: "fixture-project", COST_LEDGER_GCP_BILLING_TABLE: "fixture.billing.table",
        COST_LEDGER_CLOUDFLARE_PULL: "true", COST_LEDGER_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), COST_LEDGER_AWS_PULL: "true",
        COST_LEDGER_GITHUB_PULL: "true", COST_LEDGER_GITHUB_ACCOUNT: "fixture-user", COST_LEDGER_GITHUB_ACCOUNT_TYPE: "user",
        CMS_MEDIA_PURGE_SWEEP_ENABLED: "true", CMS_MEDIA_PURGE_REAL_DELETES_ENABLED: "false" };
      const execute = (command, args, options) => {
        const result = spawnSync(command, args, { ...options, cwd: root });
        if (result.status !== 0) throw new Error("Fake discovery failed");
        return result.stdout;
      };
      expect(resolveDiscovery(requested, execute).COST_LEDGER_AWS_PULL).toBe("false");
      await provisionDiscoverySecrets(requested, provider);
      const resolved = resolveDiscovery(requested, execute);
      for (const flag of new Set(Object.values(FUNCTION_SECRETS).map(row => row.discoveryFlag).filter(Boolean))) {
        expect(resolved[flag]).toBe("true");
      }
      await prepareCloudPublicationWake({ environment: "production", enabled: true, path: join(root, "functions/cloud-publication-wake.generated.json") });
      const requirements = configurationRequirements(loadFunctionSource("njpbs-site", pathToFileURL(`${root}/`)), "123456789",
        runtimeParameters(configurationInputs(requested), resolved));
      for (const name of [...Object.keys(values), "CMS_PUBLICATION_WAKE_TOKEN"]) expect(requirements.has(name)).toBe(true);
      expect(requirements.get("CMS_PUBLICATION_WAKE_TOKEN").size).toBeGreaterThan(0);
      expect(provider.ensureResource).toHaveBeenCalledTimes(Object.keys(values).length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves disabled optional integrations alone and refuses requested secrets without an enabled version", async () => {
    const provider = { ensureResource: vi.fn(), version: vi.fn().mockRejectedValue(new Error("missing enabled version")), client: { request: vi.fn() } };
    await provisionDiscoverySecrets({ COST_LEDGER_AWS_ACCESS_KEY_ID: "fixture-key" }, provider);
    expect(provider.version).not.toHaveBeenCalled();
    await expect(provisionDiscoverySecrets({ COST_LEDGER_AWS_PULL: "true" }, provider)).rejects.toThrow(/missing enabled version/);
    expect(provider.ensureResource).not.toHaveBeenCalled(); expect(provider.client.request).not.toHaveBeenCalled();
  });

  it("verifies all scoped IAM, values and pinned media references using reads only", async () => {
    const f = fixture();
    expect(await verifyOrProvision(config, env, f.requirements, f.provider, false, f.createClient)).toEqual(config.mediaCredentialVersions);
    expect(f.provider.ensureResource).not.toHaveBeenCalled(); expect(f.provider.grant).not.toHaveBeenCalled();
    expect(f.provider.enableEmailAuth).not.toHaveBeenCalled(); expect(f.provider.enableTtl).not.toHaveBeenCalled();
    expect(f.provider.client.request).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.endsWith("Command"))).toEqual(["HeadBucketCommand"]);
    expect(f.s3.destroy).toHaveBeenCalledOnce();
  });

  it("binds SDK and gcloud reads to the same verified credential file without a stored gcloud sign-in", async () => {
    const credentialFile = "/tmp/fixture-credentials.json";
    let options, identity = deploy;
    const request = vi.fn(async () => ({ data: { name: "projects/njpbs-site/config" } }));
    class Auth {
      constructor(value) { options = value; }
      async getCredentials() { return { client_email: identity }; }
      async getClient() { return { request }; }
    }
    const execute = vi.fn((command, args, options) => {
      expect(command).toBe("gcloud");
      expect(options.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).toBe(credentialFile);
      if (args[0] === "projects") return "123456789\n";
      if (args[0] === "firestore") return "[]";
      if (args[0] === "secrets") return '{"bindings":[]}';
      throw new Error("No credential-store sign-in is available");
    });
    const environment = { FIREBASE_DEPLOY_SERVICE_ACCOUNT: deploy, GOOGLE_APPLICATION_CREDENTIALS: credentialFile,
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/unrelated-credentials.json" };
    const provider = await nativeConfigurationProvider(environment, { execute, Auth });
    expect(options.keyFilename).toBe(credentialFile);
    expect(provider.number).toBe("123456789");
    await provider.authSettings(); provider.ttlFields(); provider.policy(edge);
    expect(execute.mock.calls).toHaveLength(3);
    expect(request.mock.calls[0][0]).toMatchObject({ timeout: 15000, retry: false, maxRedirects: 0 });
    execute.mockClear(); identity = runtime;
    await expect(nativeConfigurationProvider(environment, { execute, Auth })).rejects.toThrow(/credential identity differs/);
    expect(execute).not.toHaveBeenCalled();
    identity = deploy;
    await expect(nativeConfigurationProvider({ FIREBASE_DEPLOY_SERVICE_ACCOUNT: deploy }, {
      Auth, execute: () => runtime,
    })).rejects.toThrow(/deploy identity differs/);
  });

  it("fails closed for unknown/missing resources, wrong IAM, secret disagreement and unproven rotations", async () => {
    for (const mode of ["missing", "iam", "different-value", "unpinned", "drift", "lifecycle"]) {
      const f = fixture(); let deployment = structuredClone(config);
      if (mode === "missing") f.provider.version.mockRejectedValue(new Error(`Missing enabled version: ${edge}`));
      if (mode === "iam") f.provider.policy.mockReturnValue('{"bindings":[]}');
      if (mode === "different-value") f.values[edge] = "private-canary";
      if (mode === "unpinned") deployment.mediaCredentialVersions[access] = null;
      if (mode === "drift") f.provider.version.mockImplementation(async name => ({ name: "unused", canonicalName: `projects/njpbs-site/secrets/${name}/versions/2` }));
      if (mode === "lifecycle") f.provider.lifecycle.mockRejectedValue(new Error("retention refused"));
      await expect(verifyOrProvision(deployment, env, f.requirements, f.provider, false, f.createClient)).rejects.toThrow();
      expect(f.provider.ensureResource).not.toHaveBeenCalled(); expect(f.provider.grant).not.toHaveBeenCalled();
    }
  });

  it("returns native media pins only after explicit provisioning, IAM/value readback and the full canary", async () => {
    for (const wrongReadback of [false, true]) {
      const f = fixture(); let deleted = false;
      f.values[edge] = "old fixture value";
      for (const policy of Object.values(f.policies)) policy.bindings = [];
      if (wrongReadback) f.provider.payload.mockImplementation(async name => Buffer.from(name === edge ? "wrong value" : f.values[name]));
      f.s3.send.mockImplementation(async command => {
        f.calls.push(command.constructor.name);
        if (command.constructor.name === "DeleteObjectCommand") deleted = true;
        if (command.constructor.name === "HeadObjectCommand") {
          if (deleted) throw { $metadata: { httpStatusCode: 404 } };
          return { ContentLength: Buffer.byteLength("NJ PBS CMS media deployment preflight\n") };
        }
        return {};
      });
      const result = verifyOrProvision({ ...config, mediaCredentialVersions: { [access]: null, [secret]: null } }, env, f.requirements, f.provider, true, f.createClient);
      if (wrongReadback) await expect(result).rejects.toThrow(/differs/);
      else {
        expect(await result).toEqual(config.mediaCredentialVersions);
        expect(f.calls.filter(call => call.endsWith("Command"))).toEqual(["PutObjectCommand", "HeadObjectCommand", "DeleteObjectCommand", "HeadObjectCommand"]);
      }
      expect(f.provider.ensureResource).toHaveBeenCalledTimes(3);
      expect(f.provider.grant).toHaveBeenCalledWith(edge, deploy, "roles/secretmanager.admin");
      expect(f.provider.grant).toHaveBeenCalledWith(edge, runtime, "roles/secretmanager.secretAccessor");
      expect(f.provider.client.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    }
  });

  it("rejects incomplete or invalid media provisioning values before any write", async () => {
    for (const patch of [{ [access]: "a".repeat(32) }, { [secret]: "b".repeat(64) },
      { [access]: "A".repeat(32), [secret]: "b".repeat(64) }, { [access]: "a".repeat(31), [secret]: "b".repeat(64) },
      { [access]: "a".repeat(32), [secret]: "g".repeat(64) }, { [access]: "a".repeat(32), [secret]: "b".repeat(63) }]) {
      const f = fixture();
      await expect(verifyOrProvision(config, { ...env, ...patch }, f.requirements, f.provider, true, f.createClient)).rejects.toThrow();
      expect(f.provider.ensureResource).not.toHaveBeenCalled(); expect(f.provider.grant).not.toHaveBeenCalled();
      expect(f.provider.client.request).not.toHaveBeenCalled();
    }
  });

  it("accepts only wake tokens the deployed handler can use", () => {
    for (const value of ["a".repeat(32), "z_-".repeat(42)]) {
      expect(desiredSecret("CMS_PUBLICATION_WAKE_TOKEN", { CMS_PUBLICATION_WAKE_TOKEN: value })).toBe(value);
    }
    for (const value of ["short", "a".repeat(129), "a".repeat(31) + "!"]) {
      expect(() => desiredSecret("CMS_PUBLICATION_WAKE_TOKEN", { CMS_PUBLICATION_WAKE_TOKEN: value })).toThrow(/Invalid provisioning value/);
    }
  });

  it("checks auth and every required TTL state without writes, and resumes native asynchronous provisioning", async () => {
    expect(NATIVE_CONFIGURATION.ttlCollections).toEqual(ttlGroups);
    for (const mode of ["auth-disabled", "password-optional", "ttl-missing", "ttl-creating", "other-database"]) {
      const f = fixture();
      if (mode === "auth-disabled") f.auth.signIn.email.enabled = false;
      if (mode === "password-optional") f.auth.signIn.email.passwordRequired = false;
      if (mode === "ttl-missing") f.ttl.pop();
      if (mode === "ttl-creating") f.ttl[0].ttlConfig.state = "CREATING";
      if (mode === "other-database") f.ttl[0].name = f.ttl[0].name.replace("(default)", "other");
      await expect(verifyNativeResources(f.provider, false)).rejects.toThrow(/Firebase email|TTL policy/);
      expect(f.provider.enableEmailAuth).not.toHaveBeenCalled(); expect(f.provider.enableTtl).not.toHaveBeenCalled();
    }
    const f = fixture(); f.auth.signIn.email.enabled = false; f.ttl[0].ttlConfig.state = "STATE_UNSPECIFIED";
    await expect(verifyNativeResources(f.provider, true)).rejects.toThrow(ttlName(ttlGroups[0]));
    expect(f.provider.enableEmailAuth).toHaveBeenCalledOnce(); expect(f.provider.enableTtl).toHaveBeenCalledOnce();
    await expect(verifyNativeResources(f.provider, true)).rejects.toThrow(/wait for the native operation/);
    expect(f.provider.enableTtl).toHaveBeenCalledOnce();
    f.ttl[0].ttlConfig.state = "ACTIVE";
    await verifyNativeResources(f.provider, true);
    expect(f.provider.enableTtl).toHaveBeenCalledOnce();
  });

  it("refuses unknown fields in the declarative table", () => {
    const table = JSON.parse(readFileSync(new URL("../../config/functions-configuration.json", import.meta.url), "utf8"));
    for (const patch of [value => { value.UNKNOWN = {}; }, value => { value.inputs.TVSS_CALLSIGN.UNKNOWN = true; },
      value => { value.provider.UNKNOWN = true; }, value => { value.provider.emailSignIn.enabled = false; }]) {
      const changed = structuredClone(table); patch(changed);
      expect(() => validateConfigurationTable(changed)).toThrow();
    }
  });

  it("requires actual serving media versions to match the canary-proven pins before completion", () => {
    const source = { mediaFn: { __endpoint: { secretEnvironmentVariables: [{ key: access }, { key: secret }] } } };
    const binding = key => ({ key, secret: key, projectId: "123456789", version: "1" });
    const row = { name: "projects/njpbs-site/locations/us-central1/functions/mediaFn", serviceConfig: {
      secretEnvironmentVariables: [binding(access), binding(secret)],
    } };
    expect(() => verifyMediaBindings(config, source, [row], "123456789")).not.toThrow();
    for (const mode of ["missing-export", "missing-key", "unproven-version", "wrong-project", "other-region"]) {
      const live = structuredClone(row);
      if (mode === "missing-key") live.serviceConfig.secretEnvironmentVariables.pop();
      if (mode === "unproven-version") live.serviceConfig.secretEnvironmentVariables[0].version = "2";
      if (mode === "wrong-project") live.serviceConfig.secretEnvironmentVariables[0].projectId = "987654321";
      if (mode === "other-region") live.name = live.name.replace("us-central1", "europe-west1");
      expect(() => verifyMediaBindings(config, source, mode === "missing-export" ? [] : [live], "123456789")).toThrow();
    }
  });

  it("keeps provisioning explicit in the common runner and absent from the routine workflow", () => {
    const ops = DEPLOYMENT_COMPONENTS.functions.operations;
    expect(ops["verify-config"].args).toEqual(["verify"]);
    expect(ops["verify-deployed-config"].args).toEqual(["verify-deployed"]); expect(ops["provision-config"].args).toEqual(["provision"]);
    const workflow = readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8");
    expect(workflow).toContain("component-runner.mjs functions verify-config");
    expect(workflow.indexOf("functions verify-deployed-config")).toBeLessThan(workflow.indexOf("- name: Record the completed Functions receipt"));
    expect(workflow).not.toContain("functions provision-config");
    expect(workflow).not.toContain("gcloud secrets create"); expect(workflow).not.toContain("gcloud secrets add-iam-policy-binding");
    expect(workflow).not.toContain("functions:secrets:set");
    expect(workflow).not.toContain("--enable-ttl");
    expect(workflow).not.toContain("identitytoolkit.googleapis.com/admin/v2/projects/njpbs-site/config?updateMask=");
  });
});

it("settles the real Put/Head/Delete protocol, including uncertain writes and deletes, before returning pins", async () => {
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class HeadObjectCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  const commands = { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand };
  for (const mode of ["success", "lost-put", "wrong-size", "lost-delete", "not-absent", "forbidden"]) {
    const calls = []; let deleted = false;
    const client = { destroy: vi.fn(), send: vi.fn(async command => {
      calls.push(command.constructor.name);
      if (command instanceof PutObjectCommand && mode === "lost-put") throw new Error("private provider canary");
      if (command instanceof DeleteObjectCommand) { deleted = true; if (mode === "lost-delete") throw new Error(); return {}; }
      if (command instanceof HeadObjectCommand) {
        if (!deleted) return { ContentLength: mode === "wrong-size" ? 0 : Buffer.byteLength("NJ PBS CMS media deployment preflight\n") };
        if (mode === "not-absent") return {};
        throw { $metadata: { httpStatusCode: mode === "forbidden" ? 403 : 404 } };
      }
      return {};
    }) };
    const result = mediaCanary(client, commands, "fixture-media", "cms-media-staging/fixture");
    if (["success", "lost-delete"].includes(mode)) await result;
    else await expect(result).rejects.toThrow(/Media|media/);
    expect(calls).toContain("DeleteObjectCommand"); expect(calls.at(-1)).toBe("HeadObjectCommand");
    expect(client.destroy).toHaveBeenCalledOnce();
  }
});
