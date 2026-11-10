import { readFileSync } from "node:fs";
import { studioTitleFilesParameter } from "./studio-title-files.mjs";

export class FunctionsConfigurationError extends Error { name = "FunctionsConfigurationError"; }
export const configurationFailure = message => { throw new FunctionsConfigurationError(message); };
const freezeRows = rows => Object.freeze(Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, Object.freeze(row)])));
const table = validateConfigurationTable(JSON.parse(readFileSync(new URL("../../config/functions-configuration.json", import.meta.url), "utf8")));
function knownKeys(record, allowed) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => !allowed.includes(key))) {
    configurationFailure("Unknown or invalid Functions configuration table keys");
  }
}
export function validateConfigurationTable(table) {
  knownKeys(table, ["inputs", "parameters", "secrets", "provider"]);
  for (const [section, allowed] of Object.entries({
    inputs: ["variable", "environment", "default", "type", "pattern", "required"],
    parameters: ["input", "value", "format", "group", "binding"],
    secrets: ["compare", "minLength", "deployAdmin", "mediaPin", "pattern", "environment", "discoveryFlag"],
  })) {
    if (!table[section] || typeof table[section] !== "object" || Array.isArray(table[section])) configurationFailure("Invalid Functions configuration table section");
    for (const [name, row] of Object.entries(table[section])) {
      if (!/^[A-Z][A-Z0-9_]+$/.test(name)) configurationFailure("Invalid Functions configuration table binding");
      knownKeys(row, allowed);
      if (section === "inputs" && (typeof row.default !== "string" || !["string", "boolean", "json"].includes(row.type))) configurationFailure("Invalid input type/default in Functions table");
      if (section === "parameters" && (!["parameter", "environment"].includes(row.binding) ||
          (row.format && !["r2", "studio", "admin-map", "discovery"].includes(row.format)) ||
          (row.input && !Object.hasOwn(table.inputs, row.input)))) configurationFailure("Invalid runtime parameter binding in Functions table");
      if (section === "secrets" && row.discoveryFlag !== undefined &&
          (table.inputs[row.discoveryFlag]?.type !== "boolean" || table.parameters[row.discoveryFlag]?.format !== "discovery")) {
        configurationFailure("Invalid secret discovery flag in Functions table");
      }
    }
  }
  knownKeys(table.provider, ["databaseId", "ttlField", "ttlCollections", "emailSignIn"]);
  knownKeys(table.provider.emailSignIn, ["enabled", "passwordRequired"]);
  if (table.provider.databaseId !== "(default)" || table.provider.ttlField !== "expireAt" ||
      !Array.isArray(table.provider.ttlCollections) || !table.provider.ttlCollections.length ||
      table.provider.ttlCollections.some(name => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9]+$/.test(name)) ||
      new Set(table.provider.ttlCollections).size !== table.provider.ttlCollections.length ||
      table.provider.emailSignIn.enabled !== true || table.provider.emailSignIn.passwordRequired !== true) {
    configurationFailure("Invalid Functions auth or TTL configuration scope");
  }
  const mediaRoles = Object.values(table.secrets).filter(row => row.mediaPin).map(row => row.mediaPin).sort();
  if (mediaRoles.join(",") !== "accessKeyId,secretAccessKey") configurationFailure("Invalid media credential role bindings");
  return table;
}
export const NATIVE_CONFIGURATION = Object.freeze({ ...table.provider,
  ttlCollections: Object.freeze([...table.provider.ttlCollections]), emailSignIn: Object.freeze({ ...table.provider.emailSignIn }) });
export const CONFIGURATION_INPUTS = freezeRows(table.inputs);
export const RUNTIME_PARAMETERS = freezeRows(table.parameters);
export const FUNCTION_SECRETS = freezeRows(table.secrets);
export const MEDIA_CREDENTIALS = Object.freeze(Object.fromEntries(Object.entries(FUNCTION_SECRETS)
  .filter(([, row]) => row.mediaPin).map(([name, row]) => [row.mediaPin, name])));
export const CMS_RELEASE_SECRET_NAMES = Object.freeze(Object.keys(FUNCTION_SECRETS).filter(key => FUNCTION_SECRETS[key].compare));
export const FUNCTION_RUNTIME_VARIABLES = Object.freeze([...new Set(Object.values(CONFIGURATION_INPUTS).map(row => row.variable).filter(Boolean))].sort());

export function configurationInputs(env) {
  let variables = {};
  try {
    variables = env.CMS_DEPLOYMENT_VARIABLES_JSON ? JSON.parse(env.CMS_DEPLOYMENT_VARIABLES_JSON) : {};
    if (!variables || Array.isArray(variables) || typeof variables !== "object" ||
        Object.values(variables).some(value => typeof value !== "string")) throw new Error();
  } catch { configurationFailure("Deployment variables are invalid"); }
  // Process/GitHub environments contain unrelated keys. Only native bindings
  // named by this table enter the strict configuration object.
  return Object.fromEntries(Object.entries(CONFIGURATION_INPUTS).map(([key, row]) =>
    // config-input: BILLING_ALERT_URL, BILLING_BUDGET_TOPIC, BILLING_DISABLE_THRESHOLD, BOOTSTRAP_SUPER_ADMINS, CLOUDFLARE_ACCOUNT_ID
    // config-input: CMS_ADMIN_BUILD_REVISION, CMS_ANALYTICS_CF_ZONE_ID, CMS_ANALYTICS_GA4_PROPERTY_ID, CMS_ANALYTICS_MAILCHIMP_AUDIENCE_ID, CMS_BUG_REPORT_ADMIN_ORIGIN
    // config-input: CMS_BUG_REPORT_EMAIL_BCC, CMS_BUG_REPORT_EMAIL_FROM, CMS_BUG_REPORT_EMAIL_REPLY_TO, CMS_BUG_REPORT_GITHUB_REPOSITORY, CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP
    // config-input: CMS_BUG_REPORT_TELEGRAM_CHAT_ID, CMS_DEPLOYMENT_ENVIRONMENT, CMS_MEDIA_AWS_ARCHIVE_ACCOUNT_ID, CMS_MEDIA_AWS_ARCHIVE_ENABLED, CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_BUCKET
    // config-input: CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_PREFIX, CMS_MEDIA_AWS_ARCHIVE_ROLE_ARN, CMS_MEDIA_AWS_ARCHIVE_WORKING_BUCKET, CMS_MEDIA_AWS_ARCHIVE_WORKING_PREFIX, CMS_MEDIA_AWS_AUDIENCE
    // config-input: CMS_MEDIA_AWS_RENDITION_BUCKET, CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID, CMS_MEDIA_AWS_VIDEO_BUCKET, CMS_MEDIA_AWS_VIDEO_ENABLED, CMS_MEDIA_AWS_VIDEO_PREFIX
    // config-input: CMS_MEDIA_AWS_VIDEO_ROLE_ARN, CMS_MEDIA_CLIP_PROCESSING_ENABLED, CMS_MEDIA_CLOUDFLARE_ZONE_ID, CMS_MEDIA_EDITOR_EXPORTS_ENABLED, CMS_MEDIA_MASTER_R2_BUCKET
    // config-input: CMS_MEDIA_ORIGINAL_BUCKETS
    // config-input: CMS_MEDIA_ORIGINAL_COPIES_ENABLED, CMS_MEDIA_PREVIEW_CONTROL_ROLE_ARN, CMS_MEDIA_PREVIEW_PROCESSING_ENABLED, CMS_MEDIA_PREVIEW_WORKFLOW_ARN, CMS_MEDIA_PURGE_REAL_DELETES_ENABLED
    // config-input: CMS_MEDIA_PURGE_SWEEP_ENABLED, CMS_MEDIA_R2_BUCKET, CMS_MEDIA_TRANSCRIPT_ALIGNMENT_CACHE_SHA256, CMS_MEDIA_TRANSCRIPT_ALIGNMENT_ENABLED, CMS_MEDIA_TRANSCRIPT_ALIGNMENT_MODEL_REPOSITORY
    // config-input: CMS_MEDIA_TRANSCRIPT_ALIGNMENT_MODEL_REVISION, CMS_MEDIA_TRANSCRIPT_AUDIO_ARTIFACT_SHA256, CMS_MEDIA_TRANSCRIPT_AUDIO_ENABLED, CMS_MEDIA_TRANSCRIPT_AUDIO_FUNCTION_ARN, CMS_MEDIA_TRANSCRIPT_BYOK_DATA_ROLE_ARN
    // config-input: CMS_MEDIA_TRANSCRIPT_BYOK_ENABLED, CMS_MEDIA_TRANSCRIPT_CONTROL_ROLE_ARN, CMS_MEDIA_TRANSCRIPT_DATA_ROLE_ARN, CMS_MEDIA_TRANSCRIPT_FALLBACK_ENABLED, CMS_MEDIA_TRANSCRIPT_LOCAL_ENABLED
    // config-input: CMS_MEDIA_TRANSCRIPT_PROCESSING_ENABLED, CMS_PREVIEW_RENDERER_SHA, CMS_PREVIEW_SERIALIZER_READY, CMS_PREVIEW_TRANSPORT, CMS_PRIVATE_VIDEO_ENABLED
    // config-input: CMS_PRIVATE_VIDEO_R2_BUCKET, CMS_PUBLISH_GITHUB_APP_ID, CMS_PUBLISH_GITHUB_INSTALLATION_ID, CMS_PUBLISH_GITHUB_REPOSITORY, CMS_PUBLISH_GITHUB_TRUSTED_ACTORS
    // config-input: CMS_PUBLISH_TRANSPORT, CMS_STAFF_EMAIL_ADMIN_ORIGIN, CMS_STAFF_EMAIL_FROM, CMS_STAFF_EMAIL_REPLY_TO, CMS_TRANSCRIPTION_CREDENTIAL_KEY_VERSION
    // config-input: CMS_VIDEO_REPLACEMENT_CLEANUP_ROLE_ARN, CMS_VIDEO_REPLACEMENT_CLEANUP_DRY_RUN, CMS_VIDEO_REPLACEMENT_REPLICA_BUCKET
    // config-input: CMS_VOICEOVER_R2_BUCKET, CMS_WRITEBACK_CONFIGURED, COST_LEDGER_AWS_PULL, COST_LEDGER_CLOUDFLARE_ACCOUNT_ID, COST_LEDGER_CLOUDFLARE_PULL
    // config-input: COST_LEDGER_GCP_BILLING_TABLE, COST_LEDGER_GCP_PROJECT, COST_LEDGER_GCP_PULL, COST_LEDGER_GITHUB_ACCOUNT, COST_LEDGER_GITHUB_ACCOUNT_TYPE
    // config-input: COST_LEDGER_GITHUB_PULL, GITHUB_REPOSITORY, LIVE_PRODUCTION_ENABLED, NO_BUILD_POST_BACKGROUND_BUCKET, NO_BUILD_POST_ENABLED
    // config-input: NO_BUILD_POST_ID, PREMIERE_DESKTOP_ENABLED, PROXY_EXTRA_ORIGINS, SHADOW_POST_READER_ENABLED, SHADOW_POST_READER_SLUGS
    // config-input: TVSS_CALLSIGN, UGC_R2_BUCKET, VITE_CMS_STUDIO_CONFIGURATION, VITE_LIVE_PRODUCTION_ENABLED
    [key, env[key] ?? (row.environment ? env[row.environment] : undefined) ?? (row.variable ? variables[row.variable] : undefined) ?? row.default]));
}

export function runtimeParameters(input, discovery = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(CONFIGURATION_INPUTS, key))) configurationFailure("Unknown Functions configuration input");
  const values = {};
  for (const [key, row] of Object.entries(CONFIGURATION_INPUTS)) {
    const value = input[key] ?? row.default;
    if (typeof value !== "string" || (row.type !== "json" && /[\r\n\0]/.test(value)) ||
        (row.required && !value) || (value && row.pattern && !new RegExp(row.pattern).test(value)) ||
        (row.type === "boolean" && value !== "" && !["true", "false"].includes(value))) configurationFailure(`Invalid Functions configuration: ${key}`);
    values[key] = value;
  }
  const instant = ["NO_BUILD_POST_ENABLED", "NO_BUILD_POST_ID", "NO_BUILD_POST_BACKGROUND_BUCKET"].some(key => values[key]);
  if (instant && (!["true", "false"].includes(values.NO_BUILD_POST_ENABLED) ||
      Boolean(values.NO_BUILD_POST_ID) !== Boolean(values.NO_BUILD_POST_BACKGROUND_BUCKET) ||
      (values.NO_BUILD_POST_ENABLED === "true" && !values.NO_BUILD_POST_ID))) configurationFailure("Invalid instant publication configuration");
  let adminMap;
  try {
    const map = JSON.parse(values.CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP);
    const entries = Object.entries(map);
    if (!map || Array.isArray(map) || !entries.length || entries.length > 20 || entries.some(([id, uid]) =>
      !/^-?[0-9]{1,20}$/.test(id) || typeof uid !== "string" || !uid || uid.length > 1500 || uid.includes("/"))) throw new Error();
    adminMap = JSON.stringify(map).replaceAll("'", "\\u0027");
  } catch { configurationFailure("Invalid Functions configuration: CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP"); }
  let titles;
  try { titles = studioTitleFilesParameter(values.VITE_CMS_STUDIO_CONFIGURATION, values.VITE_LIVE_PRODUCTION_ENABLED); }
  catch { configurationFailure("Studio preset configuration is unavailable"); }
  if (Object.keys(discovery).some(key => RUNTIME_PARAMETERS[key]?.format !== "discovery") ||
      Object.values(discovery).some(value => typeof value !== "string" || /[\r\n\0]/.test(value))) configurationFailure("Invalid discovery parameters");
  return Object.fromEntries(Object.entries(RUNTIME_PARAMETERS).filter(([, row]) => row.group !== "instant" || instant).map(([key, row]) => {
    const value = row.format === "studio" ? titles : row.format === "admin-map" ? adminMap :
      row.format === "r2" ? `https://${values[row.input]}.r2.cloudflarestorage.com` :
      row.format === "discovery" ? discovery[key] : row.input ? values[row.input] : row.value;
    if (typeof value !== "string") configurationFailure(`Missing discovery parameter: ${key}`);
    return [key, value];
  }));
}

export function runtimeDotenv(parameters) {
  return Object.entries(parameters).map(([key, value]) => {
    if (!Object.hasOwn(RUNTIME_PARAMETERS, key) || typeof value !== "string" || /[\r\n\0]/.test(value)) configurationFailure("Invalid runtime parameter");
    // Plain booleans/revisions also feed the unchanged pair installation parser.
    const encoded = /^[^\s#'"\\]*$/.test(value) ? value :
      ["CMS_STUDIO_TITLE_FILES", "CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP"].includes(key)
        ? `'${value.replaceAll("'", "\\u0027")}'` : !value.includes("'") ? `'${value}'` : JSON.stringify(value);
    return `${key}=${encoded}\n`;
  }).join("");
}

export function validateDeploymentConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "codebase,mediaCredentialVersions,projectId,region" ||
      value.projectId !== "njpbs-site" || value.region !== "us-central1" || value.codebase !== "default" ||
      !value.mediaCredentialVersions || typeof value.mediaCredentialVersions !== "object" || Array.isArray(value.mediaCredentialVersions) ||
      Object.keys(value.mediaCredentialVersions).sort().join(",") !== Object.keys(FUNCTION_SECRETS).filter(key => FUNCTION_SECRETS[key].mediaPin).sort().join(",")) {
    configurationFailure("Invalid Functions deployment scope or configuration keys");
  }
  for (const [name, reference] of Object.entries(value.mediaCredentialVersions)) {
    if (reference !== null && (typeof reference !== "string" || !new RegExp(`^projects/njpbs-site/secrets/${name}/versions/[1-9][0-9]*$`).test(reference))) {
      configurationFailure(`Invalid pinned secret version: ${name}`);
    }
  }
  return value;
}

export function desiredSecret(name, env, required = FUNCTION_SECRETS[name]?.compare) {
  const row = FUNCTION_SECRETS[name];
  if (!row) configurationFailure("Unknown Functions configuration secret");
    // config-input: CMS_ANALYTICS_CF_TOKEN, CMS_ANALYTICS_MAILCHIMP_KEY, CMS_BUG_REPORT_GITHUB_TOKEN, CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET, CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN
    // config-input: CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET, CMS_EDGE_ORIGIN_SECRET, CMS_MEDIA_CACHE_PURGE_TOKEN, CMS_MEDIA_PURGE_R2_ACCESS_KEY_ID, CMS_MEDIA_PURGE_R2_SECRET_ACCESS_KEY
    // config-input: CMS_MEDIA_R2_ACCESS_KEY_ID, CMS_MEDIA_R2_SECRET_ACCESS_KEY, CMS_PRIVATE_VIDEO_R2_READ_ACCESS_KEY_ID, CMS_PRIVATE_VIDEO_R2_READ_SECRET_ACCESS_KEY, CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID
    // config-input: CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY, CMS_PUBLISH_GITHUB_TOKEN, CMS_PUBLISH_GITHUB_TOKEN_PROVISIONING, CMS_STAFF_EMAIL_API_TOKEN, CMS_TRANSCRIPTION_CREDENTIAL_KEY
    // config-input: CMS_VOICEOVER_R2_ACCESS_KEY_ID, CMS_VOICEOVER_R2_SECRET_ACCESS_KEY, COST_LEDGER_AWS_ACCESS_KEY_ID, COST_LEDGER_AWS_SECRET_ACCESS_KEY, COST_LEDGER_CLOUDFLARE_API_TOKEN
    // config-input: COST_LEDGER_GCP_BILLING_SA, COST_LEDGER_GITHUB_TOKEN, CUEZ_STORYDESK_API_KEY, HEALTHCHECKS_MEDIA_PURGE_SWEEP, PUBLISHED_POST_READER_HMAC_KEY
    // config-input: UGC_R2_ACCESS_KEY_ID, UGC_R2_SECRET_ACCESS_KEY
    // config-input: CMS_PUBLICATION_WAKE_TOKEN
  let value = env[row.environment ?? name] ?? "";
  if (row.environment && typeof value === "string" && !value.trim()) value = "";
  if (typeof value !== "string" || (required && !value) || (value && (value.length < (row.minLength ?? 1) ||
      (row.pattern && !new RegExp(row.pattern).test(value))))) configurationFailure(`Invalid provisioning value: ${name}`);
  return value;
}
