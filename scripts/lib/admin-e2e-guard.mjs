import { repositoryMatches } from "./repository-identity.mjs";
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

export const ADMIN_E2E_PROJECT_ID = "demo-njpbs";
export const ADMIN_E2E_EDGE_SECRET = "local-cms-edge-only";

export const ADMIN_E2E_ENDPOINTS = Object.freeze({
  admin: "http://127.0.0.1:4173",
  auth: "http://127.0.0.1:9099",
  functions: "http://127.0.0.1:5001",
});

const CREDENTIAL_ENV_KEYS = Object.freeze([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
  "GOOGLE_APPLICATION_DEFAULT_CREDENTIALS",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "FIREBASE_TOKEN",
  "FIREBASE_CLI_TOKEN",
]);

const PRODUCTION_CONFIG_ENV_KEYS = Object.freeze([
  "ADMIN_STATUS_MANIFEST_BASE64",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_FIREBASE_APPCHECK_SITE_KEY",
  "VITE_FUNCTIONS_BASE_URL",
]);

const EMULATOR_HOST_ENV_KEYS = Object.freeze([
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIRESTORE_EMULATOR_HOST",
  "FUNCTIONS_EMULATOR",
  "FUNCTIONS_EMULATOR_HOST",
]);

const SAFE_PASSTHROUGH_ENV_KEYS = Object.freeze([
  "HOME",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
]);

export const PRODUCTION_BUILD_MARKERS = Object.freeze([
  "admin.njpbs.org",
  "api.example.org",
  "njpbs-site.firebaseapp.com",
  "njpbs-site.web.app",
  "us-central1-njpbs-site.cloudfunctions.net",
]);

const APPROVED_FUNCTIONS_ENV_LOCAL_SHA256 =
  "536e6b66ae8961e9c66823461b7d9e281651c2e61b8e4e28a1285fbfed42e049";
const APPROVED_FUNCTIONS_DOTENV_FILES = Object.freeze([
  ".env.example",
  ".env.local",
]);
// Firebase loads this file only for project njpbs-site-dev, never for the
// demo-njpbs emulator project.
const DEPLOY_ONLY_FUNCTIONS_DOTENV_FILES = Object.freeze([
  ".env.njpbs-site-dev",
]);
const CREDENTIAL_SHAPED_ENV_KEY =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY(?:_ID)?|CREDENTIALS?)(?:_|$)/i;
const CREDENTIAL_SHAPED_ENV_VALUES = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /"(?:private_key|client_email|client_secret|refresh_token)"\s*:/i,
  /\b(?:github_pat_|gh[pousr]_|AKIA|AIza)[A-Za-z0-9_-]+/,
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/,
]);
const ADMIN_E2E_SECRET_FILE_CONTENT = [
  "CMS_ANALYTICS_CF_TOKEN=local-emulator-analytics-cloudflare-token",
  "CMS_ANALYTICS_MAILCHIMP_KEY=local-emulator-analytics-mailchimp-key",
  `CMS_EDGE_ORIGIN_SECRET=${ADMIN_E2E_EDGE_SECRET}`,
  "CMS_MEDIA_R2_ACCESS_KEY_ID=local-emulator-media-write-id",
  "CMS_MEDIA_R2_SECRET_ACCESS_KEY=local-emulator-media-write-value",
  "CMS_PRIVATE_VIDEO_R2_READ_ACCESS_KEY_ID=local-emulator-private-video-read-id",
  "CMS_PRIVATE_VIDEO_R2_READ_SECRET_ACCESS_KEY=local-emulator-private-video-read-value",
  "CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID=local-emulator-private-video-write-id",
  "CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY=local-emulator-private-video-write-value",
  "CMS_PUBLISH_GITHUB_TOKEN=local-emulator-publish-token-value",
  "CMS_STAFF_EMAIL_API_TOKEN=local-emulator-staff-email-api-token-value",
  "CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN=1000000000:local-emulator-telegram-bot-token-value",
  "CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET=local_emulator_webhook_secret_value_1234",
  "",
].join("\n");

const FORBIDDEN_EMULATOR_OUTPUT_MARKERS = Object.freeze([
  "trying to access secret",
  "unable to access secret environment variables",
  "secret manager",
  "unable to refresh auth",
  ...PRODUCTION_BUILD_MARKERS,
]);

const ADMIN_OPEN_GRAPH_METADATA =
  '<meta property="og:url" content="https://admin.njpbs.org/" />';

function present(value) {
  return typeof value === "string" && value.trim() !== "";
}

function refusePresentKeys(env, keys, category) {
  // config-input: ADMIN_STATUS_MANIFEST_BASE64, CLOUDSDK_AUTH_ACCESS_TOKEN, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CLI_TOKEN
  // config-input: FIREBASE_TOKEN, FIRESTORE_EMULATOR_HOST, FUNCTIONS_EMULATOR, FUNCTIONS_EMULATOR_HOST, GCLOUD_PROJECT
  // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_APPLICATION_CREDENTIALS_JSON
  // config-input: GOOGLE_APPLICATION_DEFAULT_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_QUOTA_PROJECT, HOME, JAVA_HOME
  // config-input: LANG, LC_ALL, LC_CTYPE, NO_COLOR, PATH, SHELL, TEMP, TERM, TMP, TMPDIR, VITE_FIREBASE_API_KEY
  // config-input: VITE_FIREBASE_APPCHECK_SITE_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_AUTH_DOMAIN
  // config-input: VITE_FIREBASE_PROJECT_ID, VITE_FUNCTIONS_BASE_URL
  const found = keys.filter((key) => present(env[key]));
  if (found.length > 0) {
    throw new Error(
      `Admin E2E refused ${category} environment keys: ${found.join(", ")}.`,
    );
  }
}

export function parsePort(value, name = "port") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  const port = Number(text);
  if (port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

export function assertLoopbackHttpUrl(value, name, expectedPort) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid loopback URL.`);
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new Error(`${name} must be an exact HTTP origin on 127.0.0.1.`);
  }
  if (url.port !== String(expectedPort)) {
    throw new Error(`${name} must use port ${expectedPort}.`);
  }
  return url.origin;
}

export function assertSafeHostEnvironment(env = process.env) {
  refusePresentKeys(env, CREDENTIAL_ENV_KEYS, "credential");
  refusePresentKeys(env, PRODUCTION_CONFIG_ENV_KEYS, "production-config");
  refusePresentKeys(env, EMULATOR_HOST_ENV_KEYS, "pre-existing emulator");

  for (const key of ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
    // config-input: ADMIN_STATUS_MANIFEST_BASE64, CLOUDSDK_AUTH_ACCESS_TOKEN, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CLI_TOKEN
    // config-input: FIREBASE_TOKEN, FIRESTORE_EMULATOR_HOST, FUNCTIONS_EMULATOR, FUNCTIONS_EMULATOR_HOST, GCLOUD_PROJECT
    // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_APPLICATION_CREDENTIALS_JSON
    // config-input: GOOGLE_APPLICATION_DEFAULT_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_QUOTA_PROJECT, HOME, JAVA_HOME
    // config-input: LANG, LC_ALL, LC_CTYPE, NO_COLOR, PATH, SHELL, TEMP, TERM, TMP, TMPDIR, VITE_FIREBASE_API_KEY
    // config-input: VITE_FIREBASE_APPCHECK_SITE_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_AUTH_DOMAIN
    // config-input: VITE_FIREBASE_PROJECT_ID, VITE_FUNCTIONS_BASE_URL
    if (present(env[key]) && env[key] !== ADMIN_E2E_PROJECT_ID) {
      throw new Error(`Admin E2E refused project selection from ${key}.`);
    }
  }

  assertLoopbackHttpUrl(ADMIN_E2E_ENDPOINTS.admin, "Admin E2E origin", 4173);
  assertLoopbackHttpUrl(ADMIN_E2E_ENDPOINTS.auth, "Auth emulator origin", 9099);
  assertLoopbackHttpUrl(
    ADMIN_E2E_ENDPOINTS.functions,
    "Functions emulator origin",
    5001,
  );
}

function assertHostPort(value, name, expectedPort) {
  if (value !== `127.0.0.1:${expectedPort}`) {
    throw new Error(`${name} must be exactly 127.0.0.1:${expectedPort}.`);
  }
}

export function assertEmulatorEnvironment(env = process.env) {
  refusePresentKeys(env, CREDENTIAL_ENV_KEYS, "credential");
  refusePresentKeys(env, PRODUCTION_CONFIG_ENV_KEYS, "production-config");
  const projectKeys = ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"];
  const selectedProjects = projectKeys
    // config-input: ADMIN_STATUS_MANIFEST_BASE64, CLOUDSDK_AUTH_ACCESS_TOKEN, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CLI_TOKEN
    // config-input: FIREBASE_TOKEN, FIRESTORE_EMULATOR_HOST, FUNCTIONS_EMULATOR, FUNCTIONS_EMULATOR_HOST, GCLOUD_PROJECT
    // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_APPLICATION_CREDENTIALS_JSON
    // config-input: GOOGLE_APPLICATION_DEFAULT_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_QUOTA_PROJECT, HOME, JAVA_HOME
    // config-input: LANG, LC_ALL, LC_CTYPE, NO_COLOR, PATH, SHELL, TEMP, TERM, TMP, TMPDIR, VITE_FIREBASE_API_KEY
    // config-input: VITE_FIREBASE_APPCHECK_SITE_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_AUTH_DOMAIN
    // config-input: VITE_FIREBASE_PROJECT_ID, VITE_FUNCTIONS_BASE_URL
    .filter((key) => present(env[key]))
    // config-input: ADMIN_STATUS_MANIFEST_BASE64, CLOUDSDK_AUTH_ACCESS_TOKEN, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CLI_TOKEN
    // config-input: FIREBASE_TOKEN, FIRESTORE_EMULATOR_HOST, FUNCTIONS_EMULATOR, FUNCTIONS_EMULATOR_HOST, GCLOUD_PROJECT
    // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_APPLICATION_CREDENTIALS_JSON
    // config-input: GOOGLE_APPLICATION_DEFAULT_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_QUOTA_PROJECT, HOME, JAVA_HOME
    // config-input: LANG, LC_ALL, LC_CTYPE, NO_COLOR, PATH, SHELL, TEMP, TERM, TMP, TMPDIR, VITE_FIREBASE_API_KEY
    // config-input: VITE_FIREBASE_APPCHECK_SITE_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_AUTH_DOMAIN
    // config-input: VITE_FIREBASE_PROJECT_ID, VITE_FUNCTIONS_BASE_URL
    .map((key) => env[key]);
  if (
    selectedProjects.length === 0 ||
    selectedProjects.some((project) => project !== ADMIN_E2E_PROJECT_ID)
  ) {
    throw new Error(`Admin E2E requires project ${ADMIN_E2E_PROJECT_ID}.`);
  }
  assertHostPort(env.FIREBASE_AUTH_EMULATOR_HOST, "Auth emulator", 9099);
  // Firebase sets FUNCTIONS_EMULATOR=true for an emulators:exec child but does
  // not always export FUNCTIONS_EMULATOR_HOST. If it does, it must match the
  // fixed loopback endpoint compiled into the Admin client.
  if (present(env.FUNCTIONS_EMULATOR_HOST)) {
    assertHostPort(env.FUNCTIONS_EMULATOR_HOST, "Functions emulator", 5001);
  }
  const firestorePort = parsePort(
    env.FIRESTORE_EMULATOR_PORT ?? "8080",
    "FIRESTORE_EMULATOR_PORT",
  );
  assertHostPort(
    env.FIRESTORE_EMULATOR_HOST,
    "Firestore emulator",
    firestorePort,
  );
  return { firestorePort };
}

export function sanitizedSubprocessEnv(
  env = process.env,
  { firestorePort, runtimeDirectory } = {},
) {
  const safe = {};
  for (const key of SAFE_PASSTHROUGH_ENV_KEYS) {
    // config-input: ADMIN_STATUS_MANIFEST_BASE64, CLOUDSDK_AUTH_ACCESS_TOKEN, FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CLI_TOKEN
    // config-input: FIREBASE_TOKEN, FIRESTORE_EMULATOR_HOST, FUNCTIONS_EMULATOR, FUNCTIONS_EMULATOR_HOST, GCLOUD_PROJECT
    // config-input: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_APPLICATION_CREDENTIALS_JSON
    // config-input: GOOGLE_APPLICATION_DEFAULT_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_QUOTA_PROJECT, HOME, JAVA_HOME
    // config-input: LANG, LC_ALL, LC_CTYPE, NO_COLOR, PATH, SHELL, TEMP, TERM, TMP, TMPDIR, VITE_FIREBASE_API_KEY
    // config-input: VITE_FIREBASE_APPCHECK_SITE_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_AUTH_DOMAIN
    // config-input: VITE_FIREBASE_PROJECT_ID, VITE_FUNCTIONS_BASE_URL
    if (present(env[key])) safe[key] = env[key];
  }
  if (!present(safe.PATH)) {
    throw new Error("Admin E2E requires PATH for local tools.");
  }
  if (firestorePort !== undefined) {
    safe.FIRESTORE_EMULATOR_PORT = String(
      parsePort(firestorePort, "FIRESTORE_EMULATOR_PORT"),
    );
  }
  if (runtimeDirectory !== undefined) {
    safe.ADMIN_E2E_RUNTIME_DIR = resolve(runtimeDirectory);
    safe.XDG_CONFIG_HOME = resolve(runtimeDirectory, "config");
  }
  safe.CI = "true";
  // Firebase Functions secret parameters first inspect this environment key.
  // Use the fixed, public emulator handshake that the Admin client already
  // sends. This keeps secret resolution offline without changing the server's
  // expected local value.
  safe.CMS_EDGE_ORIGIN_SECRET = ADMIN_E2E_EDGE_SECRET;
  safe.METADATA_SERVER_DETECTION = "none";
  safe.NO_UPDATE_NOTIFIER = "1";
  return safe;
}

function assertSafeDotenvBody(body) {
  const keys = new Set();
  for (const line of body.toString("utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || keys.has(match[1])) {
      throw new Error("Admin E2E refused an ambiguous emulator environment file.");
    }
    keys.add(match[1]);
    const value = match[2].trim();
    const approvedGithubRepository = match[1] === "CMS_PUBLISH_GITHUB_REPOSITORY" &&
      repositoryMatches(value, process.env);
    const emptyCredentialVersion = match[1] === "CMS_TRANSCRIPTION_CREDENTIAL_KEY_VERSION" && value === "";
    if (
      (match[1] === "CMS_PUBLISH_GITHUB_REPOSITORY" && !approvedGithubRepository) ||
      (CREDENTIAL_SHAPED_ENV_KEY.test(match[1]) && !emptyCredentialVersion) ||
      CREDENTIAL_SHAPED_ENV_VALUES.some((pattern) => pattern.test(value)) ||
      (!approvedGithubRepository && [...PRODUCTION_BUILD_MARKERS, "njpbs-site"].some((marker) =>
        value.toLowerCase().includes(marker.toLowerCase()),
      ))
    ) {
      throw new Error("Admin E2E refused unsafe emulator environment content.");
    }
  }
}

export function assertFunctionsEmulatorEnvContract(
  repoRoot,
  { approvedSha256 = APPROVED_FUNCTIONS_ENV_LOCAL_SHA256 } = {},
) {
  const functionsDirectory = resolve(repoRoot, "functions");
  const directoryMetadata = lstatSync(functionsDirectory);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory()
  ) {
    throw new Error("Admin E2E requires the real Functions source directory.");
  }

  const dotenvNames = readdirSync(functionsDirectory)
    .filter((name) => name.startsWith(".env"))
    .filter((name) => !DEPLOY_ONLY_FUNCTIONS_DOTENV_FILES.includes(name))
    .sort();
  if (
    dotenvNames.length !== APPROVED_FUNCTIONS_DOTENV_FILES.length ||
    dotenvNames.some(
      (name, index) => name !== APPROVED_FUNCTIONS_DOTENV_FILES[index],
    )
  ) {
    throw new Error("Admin E2E refused unexpected Functions environment files.");
  }

  for (const name of dotenvNames) {
    const metadata = lstatSync(resolve(functionsDirectory, name));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("Admin E2E refused an unsafe Functions environment file.");
    }
  }

  const approvedFile = readFileSync(resolve(functionsDirectory, ".env.local"));
  assertSafeDotenvBody(approvedFile);
  const actualSha256 = createHash("sha256").update(approvedFile).digest("hex");
  if (actualSha256 !== approvedSha256) {
    throw new Error("Admin E2E refused modified emulator environment content.");
  }
}

function functionsSecretEntries(repoRoot) {
  try {
    return readdirSync(resolve(repoRoot, "functions"))
      .filter((name) => name.startsWith(".secret"))
      .sort();
  } catch {
    throw new Error("Admin E2E could not inspect the Functions source directory.");
  }
}

export function assertNoFunctionsSecretFiles(repoRoot) {
  if (functionsSecretEntries(repoRoot).length > 0) {
    throw new Error("Admin E2E refused a pre-existing Functions secret file.");
  }
}

function secretOverrideMetadata(path) {
  try {
    return lstatSync(path);
  } catch {
    throw new Error("Admin E2E secret override is unavailable.");
  }
}

function secretOverrideContent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error("Admin E2E secret override is unreadable.");
  }
}

export function assertFunctionsSecretOverride(receipt) {
  const metadata = secretOverrideMetadata(receipt.path);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    (expectedUid !== null && metadata.uid !== expectedUid) ||
    metadata.dev !== receipt.dev ||
    metadata.ino !== receipt.ino ||
    secretOverrideContent(receipt.path) !== ADMIN_E2E_SECRET_FILE_CONTENT
  ) {
    throw new Error("Admin E2E refused an unsafe Functions secret override.");
  }
}

export function createFunctionsSecretOverride(repoRoot) {
  assertNoFunctionsSecretFiles(repoRoot);
  const path = resolve(repoRoot, "functions", ".secret.local");
  try {
    writeFileSync(path, ADMIN_E2E_SECRET_FILE_CONTENT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(path, 0o600);
  } catch {
    throw new Error("Admin E2E could not create the Functions secret override.");
  }
  const metadata = secretOverrideMetadata(path);
  const receipt = {
    path,
    repoRoot: resolve(repoRoot),
    dev: metadata.dev,
    ino: metadata.ino,
    removed: false,
  };
  assertFunctionsSecretOverride(receipt);
  return receipt;
}

export function cleanupFunctionsSecretOverride(receipt) {
  if (receipt.removed) return;
  assertFunctionsSecretOverride(receipt);
  try {
    unlinkSync(receipt.path);
  } catch {
    throw new Error("Admin E2E could not remove the Functions secret override.");
  }
  receipt.removed = true;
  if (functionsSecretEntries(receipt.repoRoot).length > 0) {
    throw new Error("Admin E2E secret cleanup proof failed.");
  }
}

export function assertIsolatedEmulatorOutput(output) {
  const normalized = String(output ?? "").toLowerCase();
  if (
    FORBIDDEN_EMULATOR_OUTPUT_MARKERS.some((marker) =>
      normalized.includes(marker.toLowerCase()),
    )
  ) {
    throw new Error(
      "Admin E2E refused emulator output that indicates external secret resolution or a production endpoint.",
    );
  }
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

export function productionBuildFindings(
  directory,
  markers = PRODUCTION_BUILD_MARKERS,
) {
  const root = resolve(directory);
  const findings = [];
  for (const file of filesUnder(root)) {
    const body = readFileSync(file);
    if (body.includes(0)) continue;
    const text = body.toString("utf8");
    for (const marker of markers) {
      if (text.includes(marker)) {
        // The public signed-out document carries its canonical Open Graph URL.
        // It is inert metadata, not a browser endpoint. Permit that one exact
        // occurrence in index.html, but still refuse the Admin origin in any
        // executable bundle or any second HTML context.
        if (
          marker === "admin.njpbs.org" &&
          relative(root, file) === "index.html" &&
          text.includes(ADMIN_OPEN_GRAPH_METADATA) &&
          !text.replace(ADMIN_OPEN_GRAPH_METADATA, "").includes(marker)
        ) {
          continue;
        }
        findings.push({ file: relative(root, file), marker });
      }
    }
  }
  return findings;
}

export function assertProductionEndpointsAbsent(directory) {
  const findings = productionBuildFindings(directory);
  if (findings.length > 0) {
    const files = [...new Set(findings.map((finding) => finding.file))];
    throw new Error(
      `Admin E2E build contains production endpoints in: ${files.join(", ")}.`,
    );
  }
}
