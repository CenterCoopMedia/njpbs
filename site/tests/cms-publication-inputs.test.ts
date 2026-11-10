// @vitest-environment node
import { closeSync, chmodSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsPublicationSerializerOperatorError, assertCmsPublicationSerializerLock,
  assertProductionFirestoreRouting, parseCmsPublicationCloudflareToken,
  parseCmsPublicationFirebaseServiceAccount, parseCmsPublicationMediaManagerCredential,
  parseCmsPublicationPublicBuildEnvironment, parseCmsPublicationSerializerArguments,
  resolveCmsPublicationCredentialPath } from "../scripts/cms-publication-inputs";
import * as credentialChecks from "../scripts/cms-publication-credentials";

it("reexports shared credential checks and preserves the operator error identity", () => {
  expect(assertProductionFirestoreRouting).toBe(credentialChecks.assertProductionFirestoreRouting);
  expect(parseCmsPublicationFirebaseServiceAccount).toBe(credentialChecks.parseCmsPublicationFirebaseServiceAccount);
  expect(CmsPublicationSerializerOperatorError).toBe(credentialChecks.CmsPublicationSerializerOperatorError);
  expect(() => credentialChecks.parseCmsPublicationFirebaseServiceAccount("invalid")).toThrow(CmsPublicationSerializerOperatorError);
  expect(() => credentialChecks.assertProductionFirestoreRouting({ FIRESTORE_EMULATOR_HOST: "" })).toThrow(CmsPublicationSerializerOperatorError);
});

const temporaryDirectories: string[] = [];
const publicBuildEnvironment = {
  PUBLIC_GA4_MEASUREMENT_ID: "G-6W12XCJ3HN",
  PUBLIC_REPORT_ENDPOINT: "https://report.njpbs.org/",
  PUBLIC_SHARE_INTAKE_ENDPOINT: "https://intake.njpbs.org/",
  PUBLIC_TURNSTILE_SITEKEY: "0x4AAAAAADursY39X5DSdJwV",
  NO_BUILD_POST_ENABLED: "false",
  NO_BUILD_POST_ID: "",
  NO_BUILD_POST_BACKGROUND_BUCKET: "",
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("shared publication inputs", () => {
  it("rejects any Firestore emulator environment key", () => {
    expect(() => assertProductionFirestoreRouting({
      FIRESTORE_EMULATOR_HOST: "",
    })).toThrow(/emulator route is not allowed/i);
  });

  it("requires an owner-only regular lock descriptor for the exact lock path", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "njpbs-serializer-lock-test-"),
    );
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, "serializer.lock");
    const descriptor = openSync(lockPath, "w", 0o600);
    try {
      expect(() => assertCmsPublicationSerializerLock(descriptor, lockPath))
        .not.toThrow();
      expect(() => assertCmsPublicationSerializerLock(
        descriptor,
        path.join(directory, "another.lock"),
      )).toThrow(/lock is missing/i);
    } finally {
      closeSync(descriptor);
    }
  });

  it("refuses loose, mismatched, and symbolic-link lock paths", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "njpbs-serializer-lock-refusal-test-"),
    );
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, "serializer.lock");
    const otherPath = path.join(directory, "other.lock");
    const descriptor = openSync(lockPath, "w", 0o600);
    const otherDescriptor = openSync(otherPath, "w", 0o600);
    try {
      expect(() => assertCmsPublicationSerializerLock(descriptor, otherPath))
        .toThrow(/lock is invalid/i);
      chmodSync(lockPath, 0o644);
      expect(() => assertCmsPublicationSerializerLock(descriptor, lockPath))
        .toThrow(/lock is invalid/i);
      rmSync(lockPath);
      symlinkSync(otherPath, lockPath);
      expect(() => assertCmsPublicationSerializerLock(otherDescriptor, lockPath))
        .toThrow(/lock is invalid/i);
    } finally {
      closeSync(descriptor);
      closeSync(otherDescriptor);
    }
  });

  it("validates exact operator arguments", () => {
    expect(parseCmsPublicationSerializerArguments([
      "--serve",
      "a".repeat(40),
      "node-compute-primary",
    ])).toEqual({
      commitSha: "a".repeat(40),
      serializerId: "node-compute-primary",
    });
    expect(() => parseCmsPublicationSerializerArguments([
      "--serve",
      "short",
      "node-compute-primary",
    ])).toThrow(/usage/i);
    expect(() => parseCmsPublicationSerializerArguments([
      "--serve",
      "a".repeat(40),
      "bad serializer",
    ])).toThrow(/usage/i);
  });

  it("requires valid public build settings", () => {
    for (const endpoint of ["https:report.njpbs.org", "https:/report.njpbs.org"]) {
      expect(parseCmsPublicationPublicBuildEnvironment({ ...publicBuildEnvironment, PUBLIC_REPORT_ENDPOINT: endpoint }).PUBLIC_REPORT_ENDPOINT).toBe("https://report.njpbs.org/");
    }
    expect(parseCmsPublicationPublicBuildEnvironment({
      PUBLIC_GA4_MEASUREMENT_ID: " G-6W12XCJ3HN ",
      PUBLIC_REPORT_ENDPOINT: " https://report.njpbs.org ",
      PUBLIC_SHARE_INTAKE_ENDPOINT: " https://intake.njpbs.org ",
      PUBLIC_TURNSTILE_SITEKEY: " 0x4AAAAAADursY39X5DSdJwV ",
    })).toEqual({
      PUBLIC_GA4_MEASUREMENT_ID: "G-6W12XCJ3HN", PUBLIC_REPORT_ENDPOINT: "https://report.njpbs.org/",
      PUBLIC_SHARE_INTAKE_ENDPOINT: "https://intake.njpbs.org/", PUBLIC_TURNSTILE_SITEKEY: "0x4AAAAAADursY39X5DSdJwV",
    });
    // The share page stays out of publication builds until its launch switch is set.
    expect(parseCmsPublicationPublicBuildEnvironment(publicBuildEnvironment)).not.toHaveProperty("PUBLIC_SHARE_PAGE");
    expect(parseCmsPublicationPublicBuildEnvironment({ ...publicBuildEnvironment, PUBLIC_SHARE_PAGE: "1" }).PUBLIC_SHARE_PAGE).toBe("1");
    for (const value of [undefined, "", "   "]) {
      expect(parseCmsPublicationPublicBuildEnvironment({
        ...publicBuildEnvironment,
        PUBLIC_SHARE_INTAKE_ENDPOINT: value,
      }).PUBLIC_SHARE_INTAKE_ENDPOINT).toBe("https://intake.njpbs.org/");
    }
    expect(() => parseCmsPublicationPublicBuildEnvironment({
      ...publicBuildEnvironment,
      PUBLIC_GA4_MEASUREMENT_ID: "UA-123",
    })).toThrow(/GA4 measurement ID is missing or invalid/i);
    expect(() => parseCmsPublicationPublicBuildEnvironment({
      ...publicBuildEnvironment,
      PUBLIC_REPORT_ENDPOINT: "http://report.njpbs.org",
    })).toThrow(/report endpoint must be an HTTPS URL/i);
    expect(() => parseCmsPublicationPublicBuildEnvironment({
      ...publicBuildEnvironment,
      PUBLIC_REPORT_ENDPOINT: "not a URL",
    })).toThrow(/report endpoint must be an HTTPS URL/i);
    expect(() => parseCmsPublicationPublicBuildEnvironment({
      ...publicBuildEnvironment,
      PUBLIC_SHARE_INTAKE_ENDPOINT: "http://intake.njpbs.org",
    })).toThrow(/share intake endpoint must be an HTTPS URL/i);
    expect(() => parseCmsPublicationPublicBuildEnvironment({
      ...publicBuildEnvironment,
      PUBLIC_TURNSTILE_SITEKEY: "   ",
    })).toThrow(/Turnstile site key is missing/i);
  });

  it("leaves removed legacy admission settings absent for runtime record updates", () => {
    const environment: Record<string, string> = { ...publicBuildEnvironment };
    delete environment.NO_BUILD_POST_ENABLED;
    delete environment.NO_BUILD_POST_ID;
    delete environment.NO_BUILD_POST_BACKGROUND_BUCKET;
    expect(parseCmsPublicationPublicBuildEnvironment(environment)).toEqual(environment);
  });

  it.each(["false", "true"])("retains complete instant publication settings with admission %s", enabled => {
    const parsed = parseCmsPublicationPublicBuildEnvironment({
      ...publicBuildEnvironment,
      NO_BUILD_POST_ENABLED: ` ${enabled} `,
      NO_BUILD_POST_ID: " pilot-post ",
      NO_BUILD_POST_BACKGROUND_BUCKET: " njpbs-pilot-background ",
    });
    expect(parsed).toEqual({ ...publicBuildEnvironment,
      NO_BUILD_POST_ENABLED: enabled,
      NO_BUILD_POST_ID: "pilot-post",
      NO_BUILD_POST_BACKGROUND_BUCKET: "njpbs-pilot-background",
    });
  });

  it.each([
    { NO_BUILD_POST_ENABLED: "yes" },
    { NO_BUILD_POST_ENABLED: "" },
    { NO_BUILD_POST_ENABLED: undefined, NO_BUILD_POST_ID: "pilot-post", NO_BUILD_POST_BACKGROUND_BUCKET: "njpbs-pilot-background" },
    { NO_BUILD_POST_ID: "pilot/post", NO_BUILD_POST_BACKGROUND_BUCKET: "njpbs-pilot-background" },
    { NO_BUILD_POST_ID: "pilot-post", NO_BUILD_POST_BACKGROUND_BUCKET: "private/bucket" },
    { NO_BUILD_POST_ENABLED: "true" },
    { NO_BUILD_POST_ID: "pilot-post" },
    { NO_BUILD_POST_BACKGROUND_BUCKET: "njpbs-pilot-background" },
  ])("refuses incomplete or malformed instant publication settings: %j", invalid => {
    expect(() => parseCmsPublicationPublicBuildEnvironment({ ...publicBuildEnvironment, ...invalid }))
      .toThrow(/instant publication configuration is invalid/i);
  });

  it("validates bounded Cloudflare and Firebase credentials", () => {
    expect(parseCmsPublicationCloudflareToken(`${"t".repeat(40)}\n`))
      .toBe("t".repeat(40));
    expect(() => parseCmsPublicationCloudflareToken("short"))
      .toThrow(/Cloudflare credential input is invalid/i);
    expect(() => parseCmsPublicationCloudflareToken("t".repeat(4_097)))
      .toThrow(/Cloudflare credential input is invalid/i);

    const validFirebase = JSON.stringify({
      type: "service_account",
      project_id: "njpbs-site",
      client_email: "publisher@njpbs-site.iam.gserviceaccount.com",
      private_key: "x".repeat(64),
    });
    expect(parseCmsPublicationFirebaseServiceAccount(validFirebase))
      .toEqual({
        projectId: "njpbs-site",
        clientEmail: "publisher@njpbs-site.iam.gserviceaccount.com",
        privateKey: "x".repeat(64),
      });
    expect(() => parseCmsPublicationFirebaseServiceAccount("not json"))
      .toThrow(/Firebase credential input is invalid/i);
    expect(() => parseCmsPublicationFirebaseServiceAccount(JSON.stringify({
      type: "service_account",
      project_id: "another-project",
      client_email: "publisher@example.com",
      private_key: "x".repeat(64),
    }))).toThrow(/Firebase credential input is invalid/i);
    expect(() => parseCmsPublicationFirebaseServiceAccount("x".repeat(65_537)))
      .toThrow(/Firebase credential input is invalid/i);

    expect(parseCmsPublicationMediaManagerCredential(
      "media-manager-key\nmedia-manager-secret\n",
    )).toEqual({
      key: "media-manager-key",
      secret: "media-manager-secret",
    });
    for (const invalid of [
      "one-line-only",
      "short\nsecret-value",
      "media-manager-key\nsecret value",
      `media-manager-key\n${"x".repeat(1_025)}`,
    ]) {
      expect(() => parseCmsPublicationMediaManagerCredential(invalid))
        .toThrow(/Media Manager credential input is invalid/i);
    }
  });

  it("resolves the exact private file behind an inherited credential descriptor", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "njpbs-serializer-credential-test-"),
    );
    temporaryDirectories.push(directory);
    const credentialPath = path.join(directory, "firebase.json");
    writeFileSync(credentialPath, "credential fixture\n", { mode: 0o440 });
    const descriptor = openSync(credentialPath, "r");
    try {
      expect(readFileSync(descriptor, "utf8")).toBe("credential fixture\n");
      expect(resolveCmsPublicationCredentialPath(descriptor, credentialPath))
        .toBe(credentialPath);
    } finally {
      closeSync(descriptor);
    }
  });

  it("refuses a credential backing path that is symbolic or other-readable", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "njpbs-serializer-credential-refusal-test-"),
    );
    temporaryDirectories.push(directory);
    const credentialPath = path.join(directory, "firebase.json");
    const symbolicPath = path.join(directory, "firebase-link.json");
    writeFileSync(credentialPath, "credential fixture\n", { mode: 0o444 });
    symlinkSync(credentialPath, symbolicPath);
    const descriptor = openSync(credentialPath, "r");
    try {
      expect(() => resolveCmsPublicationCredentialPath(descriptor, credentialPath))
        .toThrow(/credential path is invalid/i);
    } finally {
      closeSync(descriptor);
    }

    chmodSync(credentialPath, 0o440);
    const symbolicDescriptor = openSync(symbolicPath, "r");
    try {
      expect(() => resolveCmsPublicationCredentialPath(
        symbolicDescriptor,
        symbolicPath,
      )).toThrow(/credential path is invalid/i);
    } finally {
      closeSync(symbolicDescriptor);
    }
  });

});
