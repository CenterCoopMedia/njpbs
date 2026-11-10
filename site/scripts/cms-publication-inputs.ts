// Shared publication and preview inputs; importing this module starts no runtime.
import { fstatSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { parseNoBuildPostEnvironment } from "./upload-public-worker-candidate";
import { isGa4MeasurementId } from "../src/lib/analytics-consent";
import { CmsPublicationSerializerOperatorError } from "./cms-publication-credentials";
export { CmsPublicationSerializerOperatorError, assertProductionFirestoreRouting,
  parseCmsPublicationFirebaseServiceAccount } from "./cms-publication-credentials";
export { assertCmsPublicationSerializerLock } from "./cms-publication-lock";

const MAX_CLOUDFLARE_CREDENTIAL_BYTES = 4_096;
const MAX_MEDIA_MANAGER_CREDENTIAL_BYTES = 1_024;
const CLOUDFLARE_TOKEN = /^[A-Za-z0-9_-]{20,80}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function operatorError(message: string): never {
  throw new CmsPublicationSerializerOperatorError(message);
}

export function parseCmsPublicationPublicBuildEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const ga4MeasurementId = environment.PUBLIC_GA4_MEASUREMENT_ID?.trim();
  if (!isGa4MeasurementId(ga4MeasurementId)) {
    operatorError("The public GA4 measurement ID is missing or invalid");
  }

  const reportEndpoint = environment.PUBLIC_REPORT_ENDPOINT?.trim();
  if (!reportEndpoint) {
    operatorError("The public report endpoint must be an HTTPS URL");
  }
  let parsedReportEndpoint: URL;
  try {
    parsedReportEndpoint = new URL(reportEndpoint);
  } catch {
    operatorError("The public report endpoint must be an HTTPS URL");
  }
  if (parsedReportEndpoint.protocol !== "https:") {
    operatorError("The public report endpoint must be an HTTPS URL");
  }

  const shareEndpoint = environment.PUBLIC_SHARE_INTAKE_ENDPOINT?.trim() || "https://intake.njpbs.org";
  let parsedShareEndpoint: URL;
  try {
    parsedShareEndpoint = new URL(shareEndpoint);
  } catch {
    operatorError("The public share intake endpoint must be an HTTPS URL");
  }
  if (parsedShareEndpoint.protocol !== "https:") {
    operatorError("The public share intake endpoint must be an HTTPS URL");
  }

  const turnstileSitekey = environment.PUBLIC_TURNSTILE_SITEKEY?.trim();
  if (!turnstileSitekey) {
    operatorError("The public Turnstile site key is missing");
  }

  let noBuildEnvironment: Record<string, string>;
  try {
    noBuildEnvironment = parseNoBuildPostEnvironment(environment);
  } catch {
    operatorError("The instant publication configuration is invalid");
  }

  return {
    PUBLIC_GA4_MEASUREMENT_ID: ga4MeasurementId,
    PUBLIC_REPORT_ENDPOINT: parsedReportEndpoint.href,
    PUBLIC_SHARE_INTAKE_ENDPOINT: parsedShareEndpoint.href,
    PUBLIC_TURNSTILE_SITEKEY: turnstileSitekey,
    ...(environment.PUBLIC_SHARE_PAGE?.trim() === "1" ? { PUBLIC_SHARE_PAGE: "1" } : {}),
    ...noBuildEnvironment,
  };
}

export function parseCmsPublicationSerializerArguments(args: string[]): {
  commitSha: string;
  serializerId: string;
} {
  if (
    args.length !== 3 ||
    args[0] !== "--serve" ||
    !COMMIT_SHA.test(args[1] ?? "") ||
    !SERIALIZER_ID.test(args[2] ?? "")
  ) {
    operatorError(
      "Usage: publication --serve <40-character-commit> <serializer-id>",
    );
  }
  return { commitSha: args[1], serializerId: args[2] };
}

export function parseCmsPublicationCloudflareToken(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_CLOUDFLARE_CREDENTIAL_BYTES) {
    operatorError("The Cloudflare credential input is invalid");
  }
  const firstLine = value.split(/\r?\n/, 1)[0];
  if (!CLOUDFLARE_TOKEN.test(firstLine)) {
    operatorError("The Cloudflare credential input is invalid");
  }
  return firstLine;
}

export function parseCmsPublicationMediaManagerCredential(value: string): {
  key: string;
  secret: string;
} {
  if (Buffer.byteLength(value, "utf8") > MAX_MEDIA_MANAGER_CREDENTIAL_BYTES) {
    operatorError("The Media Manager credential input is invalid");
  }
  const lines = value.trimEnd().split(/\r?\n/);
  if (
    lines.length !== 2 ||
    lines.some((line) =>
      line.length < 8 ||
      line.length > 256 ||
      /[^\x21-\x7e]/.test(line)
    )
  ) {
    operatorError("The Media Manager credential input is invalid");
  }
  return { key: lines[0], secret: lines[1] };
}

export function resolveCmsPublicationCredentialPath(
  fd: number,
  expectedPath: string,
): string {
  let descriptor;
  let credential;
  let credentialPath;
  try {
    descriptor = fstatSync(fd);
    credentialPath = readlinkSync(`/proc/self/fd/${fd}`);
    credential = lstatSync(credentialPath);
  } catch {
    operatorError("The CMS publication credential path is unavailable");
  }
  // systemd exposes this credential through an immutable unit-specific mount.
  // The service file is root:root 0440, so group read is required while group
  // write/execute and all access for other users remain invalid.
  if (
    !path.isAbsolute(credentialPath) ||
    path.resolve(credentialPath) !== credentialPath ||
    credentialPath !== expectedPath ||
    !descriptor.isFile() ||
    !credential.isFile() ||
    credential.isSymbolicLink() ||
    descriptor.dev !== credential.dev ||
    descriptor.ino !== credential.ino ||
    (credential.mode & 0o037) !== 0
  ) {
    operatorError("The CMS publication credential path is invalid");
  }
  return credentialPath;
}
