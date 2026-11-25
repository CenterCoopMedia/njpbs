import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { RUNTIME_PARAMETERS, FUNCTION_SECRETS, NATIVE_CONFIGURATION, MEDIA_CREDENTIALS, configurationInputs, runtimeParameters, runtimeDotenv,
  validateDeploymentConfiguration, desiredSecret, configurationFailure as fail } from "./lib/functions-configuration.mjs";
import { secretRequirements, checkSecretIam } from "./check-cms-secret-iam.mjs";
import { loadFunctionSource, readFunctionsDeployInventory } from "./lib/functions-deploy-inventory.mjs";
import { provisionCmsSecret } from "./lib/functions-secret-versions.mjs";
import { assertR2Lifecycle } from "./assert-r2-lifecycle.mjs";
import { faultCause, providerCall, providerGcloud, providerJson } from "./lib/provider-call.mjs";
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { cmsTarget } from "./lib/cms-target.mjs";

const target = cmsTarget();
const project = target.projectId;
const DEVELOPMENT_ONLY_SECRETS = Object.freeze(["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET",
  "CMS_DEV_PUBLISH_APP_ID", "CMS_DEV_PUBLISH_APP_PRIVATE_KEY"]);
const secretBase = name => `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}`;
const require = createRequire(import.meta.url);
const gcloudOptions = env => ({ env: { ...env,
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: env.GOOGLE_APPLICATION_CREDENTIALS || undefined },
encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 1024 * 1024 });
function readGcloud(args, env, execute, wait) {
  try { return providerGcloud(args, gcloudOptions(env), execute, { wait }).trim(); }
  catch (error) { fail("Scoped Google configuration command failed", faultCause(error)); }
}
function writeGcloud(args, env, execute) {
  try { return execute("gcloud", args, gcloudOptions(env)).trim(); }
  catch (error) { fail("Scoped Google configuration command failed", faultCause(error)); }
}

export function resolveDiscovery(env, execute = execFileSync) {
  const { PATH, HOME, GOOGLE_APPLICATION_CREDENTIALS, CLOUDSDK_CONFIG } = env;
  const ambient = Object.fromEntries(Object.entries({ PATH, HOME, GOOGLE_APPLICATION_CREDENTIALS, CLOUDSDK_CONFIG })
    .filter(([, value]) => value !== undefined));
  const output = {};
  for (const script of ["resolve-media-purge.sh", "resolve-cost-ledger-pulls.sh"]) {
    let text;
    try { text = execute("bash", [`scripts/${script}`], { env: { ...ambient,
      ...Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:COST_LEDGER_|CMS_MEDIA_PURGE_)/.test(key))),
      ...(GOOGLE_APPLICATION_CREDENTIALS ? { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: GOOGLE_APPLICATION_CREDENTIALS } : {}) },
      encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 600000, maxBuffer: 64 * 1024 }); }
    catch (error) { fail(`Could not resolve discovery configuration: ${script}`, faultCause(error)); }
    for (const line of text.trim().split("\n")) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match || RUNTIME_PARAMETERS[match[1]]?.format !== "discovery" || Object.hasOwn(output, match[1])) fail("Invalid discovery configuration output");
      output[match[1]] = match[2];
    }
  }
  return output;
}

export function configurationRequirements(source, number, parameters) {
  const requirements = secretRequirements(source, number);
  for (const name of requirements.keys()) {
    // The dev workflows own these dev-only secrets; this table neither compares nor provisions them.
    if (target.environment === "development" && DEVELOPMENT_ONLY_SECRETS.includes(name)) requirements.delete(name);
    else if (!Object.hasOwn(FUNCTION_SECRETS, name)) fail("Unmapped Functions secret binding");
  }
  // SDK declarations and __endpoint bindings are the native export table. A
  // configured name cannot silently misspell an actual parameter or a secret.
  const { declaredParams } = require("firebase-functions/params");
  const declared = new Map(declaredParams.map(param => [param.name, param.toSpec()]));
  for (const name of Object.keys(parameters)) {
    if ((RUNTIME_PARAMETERS[name]?.binding === "parameter" && !declared.has(name)) || declared.get(name)?.type === "secret") fail(`Unmapped runtime parameter: ${name}`);
    if ((declared.get(name)?.type === "list") !== (RUNTIME_PARAMETERS[name]?.encoding === "firebase-list")) {
      fail(`Unmapped runtime parameter encoding: ${name}`);
    }
  }
  return requirements;
}

export async function provisionDiscoverySecrets(env, provider) {
  const desired = Object.fromEntries(Object.entries(FUNCTION_SECRETS)
    // config-input: COST_LEDGER_GCP_PULL, COST_LEDGER_CLOUDFLARE_PULL, COST_LEDGER_AWS_PULL, COST_LEDGER_GITHUB_PULL, CMS_MEDIA_PURGE_SWEEP_ENABLED
    .filter(([, row]) => row.discoveryFlag && env[row.discoveryFlag] === "true")
    .map(([name]) => [name, desiredSecret(name, env)]));
  for (const [name, value] of Object.entries(desired)) {
    if (value) {
      await provider.ensureResource(name, value);
      await provisionCmsSecret(name, value, provider.client);
    }
    // Explicit setup must not silently disable a requested integration.
    await provider.version(name);
  }
}

export async function nativeConfigurationProvider(env, { execute = execFileSync, Auth = require("google-auth-library").GoogleAuth, wait, waitSync } = {}) {
  const account = env.FIREBASE_DEPLOY_SERVICE_ACCOUNT;
  if (!/^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$/.test(account ?? "")) fail("Configure FIREBASE_DEPLOY_SERVICE_ACCOUNT");
  const auth = new Auth({ keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  if ((await auth.getCredentials()).client_email !== account) fail("Configuration SDK credential identity differs");
  const gcloud = args => readGcloud(args, env, execute, waitSync);
  const changeGcloud = args => writeGcloud(args, env, execute);
  // A credential-file override need not enroll an account in gcloud's store.
  // SDK identity above and this exact file bind both clients to one principal.
  if (!env.GOOGLE_APPLICATION_CREDENTIALS &&
      gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]) !== account) fail("Firebase configuration deploy identity differs");
  const number = gcloud(["projects", "describe", project, "--format=value(projectNumber)"]);
  if (!/^[1-9][0-9]*$/.test(number)) fail("Could not verify scoped project number");
  let clientPromise;
  const request = async options => {
    clientPromise ??= auth.getClient();
    const client = await clientPromise;
    const send = () => client.request({ ...options, timeout: 15000, retry: false, maxRedirects: 0 });
    // A write is sent once; its owner reads the result back.
    return (options.method ?? "GET") === "GET" ? providerCall(`Google ${new URL(options.url).pathname}`, send, { wait }) : send();
  };
  const nativeVersion = (name, value) => {
    if (!value || value.state !== "ENABLED" || !new RegExp(`^projects/(?:${project}|${number})/secrets/${name}/versions/[1-9][0-9]*$`).test(value.name ?? "")) fail(`Missing or invalid enabled version: ${name}`);
    return { ...value, canonicalName: value.name.replace(`projects/${number}/`, `projects/${project}/`) };
  };
  return {
    account, number,
    client: { request },
    async version(name) {
      try { return nativeVersion(name, (await request({ url: `${secretBase(name)}/versions/latest` })).data); }
      catch (error) { fail(`Could not verify enabled secret version: ${name}`, faultCause(error)); }
    },
    async payload(name, version) {
      try {
        const data = (await request({ url: `https://secretmanager.googleapis.com/v1/${version.name}:access` })).data;
        if (data?.name !== version.name || typeof data.payload?.data !== "string") throw new Error("answer names another version or has no payload");
        const bytes = Buffer.from(data.payload.data, "base64");
        if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== data.payload.data.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "")) throw new Error("payload is not canonical base64");
        return bytes;
      } catch (error) { fail(`Could not read scoped secret payload: ${name}`, faultCause(error)); }
    },
    async servingFunctions() {
      try { return await readFunctionsDeployInventory(project, async (url, pageToken) =>
        (await request({ url, ...(pageToken ? { params: { pageToken } } : {}) })).data, { includeMetadata: true }); }
      catch (error) { fail("Could not read deployed Functions secret bindings", faultCause(error)); }
    },
    async authSettings() {
      try {
        const data = (await request({ url: `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config` })).data;
        if (![project, number].some(id => data?.name === `projects/${id}/config`)) throw new Error("answer names another project");
        return data;
      }
      catch (error) { fail("Could not read Firebase email/password sign-in configuration", faultCause(error)); }
    },
    async enableEmailAuth() {
      try { await request({ url: `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`, method: "PATCH",
        params: { updateMask: "signIn.email.enabled,signIn.email.passwordRequired" }, data: { signIn: { email: NATIVE_CONFIGURATION.emailSignIn } } }); }
      catch (error) { fail("Could not provision Firebase email/password sign-in; read back before retrying", faultCause(error)); }
    },
    ttlFields() {
      try {
        const fields = JSON.parse(gcloud(["firestore", "fields", "ttls", "list", `--project=${project}`,
          `--database=${NATIVE_CONFIGURATION.databaseId}`, "--format=json"]));
        if (!Array.isArray(fields) || fields.some(field => !field || typeof field.name !== "string")) throw new Error("answer is not a list of named fields");
        return fields;
      } catch (error) { fail("Could not read scoped expireAt TTL policies", faultCause(error)); }
    },
    enableTtl(group) {
      if (!NATIVE_CONFIGURATION.ttlCollections.includes(group)) fail("Unknown TTL collection group");
      // Native TTL enablement may take ten minutes or more. Queue once, then
      // fail closed until native readback is ACTIVE; a later invocation resumes.
      changeGcloud(["firestore", "fields", "ttls", "update", NATIVE_CONFIGURATION.ttlField, `--collection-group=${group}`,
        `--project=${project}`, `--database=${NATIVE_CONFIGURATION.databaseId}`, "--enable-ttl", "--async", "--quiet"]);
    },
    policy: name => gcloud(["secrets", "get-iam-policy", name, `--project=${project}`, "--format=json"]),
    async ensureResource(name, value) {
      try {
        const data = (await request({ url: secretBase(name) })).data;
        if (![project, number].some(id => data?.name === `projects/${id}/secrets/${name}`)) fail(`Invalid secret resource: ${name}`);
      } catch (error) {
        if (error?.response?.status !== 404) fail(`Could not read secret resource: ${name}`, faultCause(error));
        if (!value) fail(`Missing provisioning value for absent resource: ${name}`);
        changeGcloud(["secrets", "create", name, `--project=${project}`, "--replication-policy=automatic", "--quiet"]);
        const data = (await request({ url: secretBase(name) })).data;
        if (![project, number].some(id => data?.name === `projects/${id}/secrets/${name}`)) fail(`Unverified secret resource: ${name}`);
      }
    },
    grant(name, account, role) { changeGcloud(["secrets", "add-iam-policy-binding", name, `--project=${project}`,
      `--member=serviceAccount:${account}`, `--role=${role}`, "--condition=None", "--quiet"]); },
    lifecycle: (account, bucket, token) => verifyMediaLifecycle(account, bucket, token),
  };
}

// Each refusal names its fix (docs/cms/functions-deploy.md#development-project-setup):
// dev CMS runs on Nov. 23, 2026 found both by hand, one run at a time.
export async function verifyMediaLifecycle(account, bucket, token, fetchImpl = fetch, wait = undefined) {
  let body;
  try {
    body = await providerJson("media bucket lifecycle", () => fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/lifecycle`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) }), { wait });
  } catch (error) {
    if (![401, 403].includes(error.response?.status)) fail("Could not verify media bucket retention lifecycle", faultCause(error));
    fail(`CLOUDFLARE_API_TOKEN cannot read the ${bucket} lifecycle: give the ${target.environment} deploy token the account permission Workers R2 Storage Read`, faultCause(error));
  }
  try { assertR2Lifecycle(body); }
  catch (error) {
    fail(`${bucket}: ${error.message}. A missing staging rule is added with npx wrangler r2 bucket lifecycle add ${bucket} cms-media-staging-expiry cms-media-staging/ --expire-days 7`);
  }
}

export async function verifyNativeResources(provider, provision) {
  const authReady = value => value?.signIn?.email?.enabled === NATIVE_CONFIGURATION.emailSignIn.enabled &&
    value?.signIn?.email?.passwordRequired === NATIVE_CONFIGURATION.emailSignIn.passwordRequired;
  if (!authReady(await provider.authSettings())) {
    if (!provision) fail("Firebase email/password sign-in is not provisioned: signIn.email.enabled/passwordRequired");
    await provider.enableEmailAuth();
    if (!authReady(await provider.authSettings())) fail("Firebase email/password sign-in readback differs");
  }
  const resource = group => `projects/${project}/databases/${NATIVE_CONFIGURATION.databaseId}/collectionGroups/${group}/fields/${NATIVE_CONFIGURATION.ttlField}`;
  const state = (fields, group) => {
    const names = [resource(group), resource(group).replace(`projects/${project}/`, `projects/${provider.number}/`)];
    const matches = fields.filter(field => names.includes(field.name));
    if (matches.length > 1) fail(`Ambiguous TTL policy: ${resource(group)}`);
    return matches[0]?.ttlConfig?.state;
  };
  let fields = await provider.ttlFields();
  if (provision) {
    for (const group of NATIVE_CONFIGURATION.ttlCollections) {
      const current = state(fields, group);
      if (current === "ACTIVE" || current === "CREATING") continue;
      await provider.enableTtl(group);
    }
    fields = await provider.ttlFields();
  }
  for (const group of NATIVE_CONFIGURATION.ttlCollections) {
    if (state(fields, group) !== "ACTIVE") fail(`TTL policy is not ACTIVE: ${resource(group)}; ${state(fields, group) === "CREATING" ? "wait for the native operation, then rerun provision-config" : "run explicit provision-config"}`);
  }
}

function provisionIam(requirements, provider) {
  for (const [name, accounts] of requirements) {
    let policy;
    try { policy = JSON.parse(provider.policy(name)); } catch (error) { fail(`Could not read IAM policy: ${name}`, faultCause(error)); }
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || !Array.isArray(policy.bindings ?? [])) fail(`Invalid IAM policy: ${name}`);
    const has = (account, roles) => (policy.bindings ?? []).some(binding => roles.includes(binding.role) && !binding.condition &&
      Array.isArray(binding.members) && binding.members.includes(`serviceAccount:${account}`));
    const deployRoles = FUNCTION_SECRETS[name].deployAdmin ? ["roles/secretmanager.admin"] : ["roles/secretmanager.viewer", "roles/secretmanager.admin"];
    if (!has(provider.account, deployRoles)) provider.grant(name, provider.account, deployRoles[0]);
    for (const account of accounts) if (!has(account, ["roles/secretmanager.secretAccessor"])) provider.grant(name, account, "roles/secretmanager.secretAccessor");
  }
}

export function verifyConfigurationIam(requirements, provider) {
  const policies = new Map();
  const readPolicy = name => {
    if (!policies.has(name)) policies.set(name, provider.policy(name));
    return policies.get(name);
  };
  checkSecretIam(requirements, readPolicy, provider.account);
  const missing = [];
  for (const name of requirements.keys()) {
    if (!FUNCTION_SECRETS[name].deployAdmin) continue;
    let policy;
    try { policy = JSON.parse(readPolicy(name)); } catch (error) { fail(`Could not read IAM policy: ${name}`, faultCause(error)); }
    if (!policy?.bindings?.some(binding => binding.role === "roles/secretmanager.admin" && !binding.condition &&
        binding.members?.includes(`serviceAccount:${provider.account}`))) missing.push(name);
  }
  // Name every gap at once: dev CMS run 45287010195 (Nov. 23, 2026) reported one of 17.
  if (missing.length) {
    fail(`Missing deploy roles/secretmanager.admin in ${project}: ${missing.join(" ")}. Run explicit provision-config, or for each: ` +
      `gcloud secrets add-iam-policy-binding <secret> --project=${project} --member=serviceAccount:$FIREBASE_DEPLOY_SERVICE_ACCOUNT --role=roles/secretmanager.admin --condition=None`);
  }
}

export async function mediaCanary(client, commands, bucket, key) {
  const body = Buffer.from("NJ PBS CMS media deployment preflight\n", "utf8");
  const send = (Type, input) => client.send(new Type(input), { abortSignal: AbortSignal.timeout(15000) });
  let originalError;
  try {
    await send(commands.PutObjectCommand, { Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" });
    const stored = await send(commands.HeadObjectCommand, { Bucket: bucket, Key: key });
    if (stored.ContentLength !== body.length) throw new Error("stored length differs");
  } catch (error) { originalError = error; }
  try {
    // Include an uncertain PUT in cleanup, then prove absence rather than
    // treating a successful delete response as proof of the resulting state.
    try { await send(commands.DeleteObjectCommand, { Bucket: bucket, Key: key }); } catch { /* Readback settles an uncertain delete. */ }
    try { await send(commands.HeadObjectCommand, { Bucket: bucket, Key: key }); fail("Media canary object remains"); }
    catch (error) { if (error?.$metadata?.httpStatusCode !== 404) fail("Could not prove media canary cleanup", faultCause(error)); }
    if (originalError) fail("Media Put/Head canary failed", faultCause(originalError));
  } finally { client.destroy(); }
}

export async function checkMedia(config, env, provider, provision, createClient) {
  const account = env.CLOUDFLARE_ACCOUNT_ID, bucket = env.CMS_MEDIA_R2_BUCKET;
  if (!/^[a-f0-9]{32}$/.test(account ?? "") || !/^[a-z0-9][a-z0-9._-]{2,220}$/.test(bucket ?? "") || !env.CLOUDFLARE_API_TOKEN?.trim()) fail("Missing scoped media bucket configuration");
  await provider.lifecycle(account, bucket, env.CLOUDFLARE_API_TOKEN);
  const names = Object.values(MEDIA_CREDENTIALS);
  const versions = {};
  for (const name of names) {
    versions[name] = await provider.version(name);
    if (!provision && versions[name].canonicalName !== config.mediaCredentialVersions[name]) fail(`Unproven media secret rotation: ${name}; run explicit provision-config and commit the native version reference`);
  }
  let access, secret;
  try {
    access = await provider.payload(MEDIA_CREDENTIALS.accessKeyId, versions[MEDIA_CREDENTIALS.accessKeyId]);
    secret = await provider.payload(MEDIA_CREDENTIALS.secretAccessKey, versions[MEDIA_CREDENTIALS.secretAccessKey]);
    const commands = require("@aws-sdk/client-s3");
    const client = (createClient ?? (options => new commands.S3Client(options)))({ region: "auto",
      endpoint: `https://${account}.r2.cloudflarestorage.com`, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: access.toString("utf8"), secretAccessKey: secret.toString("utf8") } });
    if (provision) await mediaCanary(client, commands, bucket, `cms-media-staging/deploy-preflight-${randomUUID()}`);
    else {
      try { await providerCall("media bucket read", () => client.send(new commands.HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(15000) })); }
      catch (error) { fail("Could not read media bucket with the pinned credentials", faultCause(error)); }
      finally { client.destroy(); }
    }
    for (const name of names) if ((await provider.version(name)).canonicalName !== versions[name].canonicalName) fail(`Media secret rotated during verification: ${name}`);
    return Object.fromEntries(names.map(name => [name, versions[name].canonicalName]));
  } finally { access?.fill(0); secret?.fill(0); }
}

export async function verifyOrProvision(config, env, requirements, provider, provision = false, createClient) {
  const desired = Object.fromEntries([...requirements.keys()].map(name => [name, desiredSecret(name, env)]));
  const mediaNames = Object.values(MEDIA_CREDENTIALS);
  if (provision && Boolean(desired[mediaNames[0]]) !== Boolean(desired[mediaNames[1]])) fail("Media provisioning requires the complete credential pair");
  await verifyNativeResources(provider, provision);
  if (provision) {
    for (const name of requirements.keys()) {
      await provider.ensureResource(name, desired[name]);
      if (desired[name]) await provisionCmsSecret(name, desired[name], provider.client);

    }
  }
  if (provision) provisionIam(requirements, provider);
  verifyConfigurationIam(requirements, provider);
  for (const name of requirements.keys()) {
    const version = await provider.version(name);
    if (!desired[name]) continue;
    const current = await provider.payload(name, version), expected = Buffer.from(desired[name]);
    try { if (current.length !== expected.length || !timingSafeEqual(current, expected)) fail(`Secret value differs; run explicit provision-config: ${name}`); }
    finally { current.fill(0); expected.fill(0); }
    if ((await provider.version(name)).canonicalName !== version.canonicalName) fail(`Secret rotated during comparison: ${name}`);
  }
  return checkMedia(config, env, provider, provision, createClient);
}

export function verifyMediaBindings(config, source, live, projectNumber) {
  if (!Array.isArray(live) || !/^[1-9][0-9]*$/.test(projectNumber ?? "")) fail("Deployed Functions binding inventory is unavailable");
  for (const [name, fn] of Object.entries(source)) {
    const expected = (fn.__endpoint?.secretEnvironmentVariables ?? []).map(binding => binding.key)
      .filter(key => FUNCTION_SECRETS[key]?.mediaPin);
    if (!expected.length) continue;
    const resource = `projects/${config.projectId}/locations/${config.region}/functions/${name}`;
    const deployed = live.filter(row => row.name === resource);
    if (!deployed.length) fail(`Missing deployed media binding export: ${name}`);
    for (const row of deployed) {
      const bindings = row.serviceConfig?.secretEnvironmentVariables ?? row.secretEnvironmentVariables;
      if (!Array.isArray(bindings)) fail(`Missing deployed media secret bindings: ${name}`);
      for (const key of expected) {
        const matches = bindings.filter(binding => binding.key === key);
        if (matches.length !== 1 || typeof matches[0].version !== "string" || !/^[1-9][0-9]*$/.test(matches[0].version) || matches[0].secret !== key || ![config.projectId, projectNumber].includes(matches[0].projectId) ||
            `projects/${config.projectId}/secrets/${key}/versions/${matches[0].version}` !== config.mediaCredentialVersions[key]) {
          fail(`Unproven deployed media secret binding: ${name}/${key}`);
        }
      }
    }
  }
}

export function requireConfigurationSource(env) {
  try {
    if (!/^[a-f0-9]{40}$/.test(env.DEPLOY_SHA ?? "") || realpathSync(".") !== realpathSync(new URL("../", import.meta.url)) ||
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() !== env.DEPLOY_SHA) throw new Error("checkout is not at DEPLOY_SHA");
    // A dev run writes its runtime parameters over the tracked dev-index template.
    assertDevelopmentSource(process.cwd(), env,
      { allowedChanges: target.environment === "development" ? [`functions/.env.${project}`] : [] });
  } catch (error) { fail("Functions configuration requires a clean source checkout at DEPLOY_SHA", faultCause(error)); }
}

function writeConfigurationFile(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    if (readFileSync(temporary, "utf8") !== text) fail("Configuration file readback differs");
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export async function main(argv) {
  const [operation, ...extra] = argv;
  if (extra.length || !["configure", "verify", "verify-deployed", "provision"].includes(operation)) fail("Unknown Functions configuration operation");
  if (operation !== "configure") requireConfigurationSource(process.env);
  const input = configurationInputs(process.env);
  const env = { ...process.env, ...input };
  const configPath = resolve(target.deploymentConfig);
  const config = validateDeploymentConfiguration(JSON.parse(readFileSync(configPath, "utf8")));
  let parameters = runtimeParameters(input, resolveDiscovery(env));
  if (operation === "configure") {
    const path = `functions/.env.${config.projectId}`;
    // Dev keeps its template's dev-only settings, such as stored-only report intake.
    const kept = target.environment !== "development" ? "" : readFileSync(path, "utf8").split("\n")
      .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line) && !Object.hasOwn(parameters, line.slice(0, line.indexOf("="))))
      .map(line => `${line}\n`).join("");
    const text = kept + runtimeDotenv(parameters);
    writeConfigurationFile(path, text);
    console.log(`Configured ${Object.keys(parameters).length} Functions runtime parameters`);
    return;
  }
  const provider = await nativeConfigurationProvider(env);
  if (operation === "provision") {
    await provisionDiscoverySecrets(env, provider);
    parameters = runtimeParameters(input, resolveDiscovery(env));
  }
  const source = loadFunctionSource(config.projectId);
  const requirements = configurationRequirements(source, provider.number, parameters);
  const pins = await verifyOrProvision(config, env, requirements, provider, operation === "provision");
  if (operation === "verify-deployed") verifyMediaBindings(config, source, await provider.servingFunctions(), provider.number);
  if (operation === "provision") {
    const text = `${JSON.stringify({ ...config, mediaCredentialVersions: pins }, null, 2)}\n`;
    writeConfigurationFile(configPath, text);
  }
  console.log(`Verified configuration for ${requirements.size} scoped Functions secrets`);
}
