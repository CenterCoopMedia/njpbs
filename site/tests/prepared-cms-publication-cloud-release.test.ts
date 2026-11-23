// @vitest-environment node
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { parsePreparedReleaseArguments, preparedReleaseErrorMessage, preparedReleaseTarget } from "../scripts/prepared-cms-publication-cloud-release";
import { parseCmsPublicationFirebaseServiceAccount } from "../scripts/cms-publication-credentials";
const { PreparedPublicReleaseError } = createRequire(import.meta.url)("../../functions/lib/public-release-error.js");

const operation = "Release0000000000001", commit = "b".repeat(40);
const root = fileURLToPath(new URL("../..", import.meta.url));

it.each(["--seal", "--check", "--handover", "--promote"])("accepts the explicit %s operation", action => {
  expect(parsePreparedReleaseArguments([action, operation, commit])).toEqual({ action, queueId: operation, commitSha: commit, apply: false });
});

it("requires an explicit apply flag for promotion writes", () => {
  expect(parsePreparedReleaseArguments(["--promote", operation, commit, "--apply"]))
    .toEqual({ action: "--promote", queueId: operation, commitSha: commit, apply: true });
});

it.each([
  [], ["--apply", operation, commit], ["--promote", "../release", commit], ["--seal", operation, "short"],
  ["--handover", operation, commit, "--apply"],
].map(args => ({ args })))("refuses an ambiguous or invalid operator command: $args", ({ args }) => {
  expect(() => parsePreparedReleaseArguments(args)).toThrow("Usage:");
});

const account = (project: string) => JSON.stringify({ type: "service_account", project_id: project,
  client_email: `release@${project}.iam.gserviceaccount.com`, private_key: "k".repeat(64) });
const runOperator = (environment: Record<string, string>, credential?: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "prepared-target-"));
  const file = path.join(directory, "firebase-service-account");
  writeFileSync(file, credential ?? "");
  const fd = openSync(file, "r");
  try {
    return spawnSync(process.execPath, ["--import", `${root}/site/node_modules/tsx/dist/loader.mjs`,
      `${root}/site/scripts/prepared-cms-publication-cloud-release.ts`, "--check", operation, commit], {
      cwd: root, env: { PATH: "/usr/bin:/bin", ...environment }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd],
    });
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true });
  }
};

it("selects the release target only from the explicit deployment environment", () => {
  expect(preparedReleaseTarget({}).projectId).toBe("njpbs-site");
  expect(preparedReleaseTarget({ CMS_DEPLOYMENT_ENVIRONMENT: "production" }).projectId).toBe("njpbs-site");
  const development = preparedReleaseTarget({ CMS_DEPLOYMENT_ENVIRONMENT: "development" });
  expect([development.projectId, development.serializerId, development.publicationBucket])
    .toEqual(["njpbs-site-dev", "cloudflare-dev-publisher", "njpbs-dev-cms-publication"]);
  // A development run reads only a development account.
  expect(() => parseCmsPublicationFirebaseServiceAccount(account("njpbs-site"), development.projectId)).toThrow("credential input is invalid");
  expect(parseCmsPublicationFirebaseServiceAccount(account("njpbs-site-dev"), development.projectId).projectId).toBe("njpbs-site-dev");
});

it.each(["", "staging", "Production"])("refuses the unknown target %j before opening any credential descriptor", target => {
  const result = runOperator({ CMS_DEPLOYMENT_ENVIRONMENT: target });
  expect([result.status, result.stderr]).toEqual([1, "The prepared release target must be production or development\n"]);
});

it("refuses a production account for a development run before any database read", () => {
  const result = runOperator({ CMS_DEPLOYMENT_ENVIRONMENT: "development" }, account("njpbs-site"));
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("Prepared release refused; read the preparation, handover and live pointer before retrying\n");
});

it("refuses an inherited credential without printing it or opening the supplied credential directory", () => {
  const sentinel = "synthetic-sensitive-value";
  const result = spawnSync("/bin/bash", [`${root}/scripts/prepared-cms-publication-cloud-release.sh`, "--seal", operation, commit], {
    cwd: root, env: { PATH: "/usr/bin:/bin", CF_API_TOKEN: sentinel, CREDENTIALS_DIRECTORY: "/must-not-open" }, encoding: "utf8",
  });
  expect(result.status).toBe(78);
  expect(result.stderr).toContain("inherited process environment is not allowed");
  expect(result.stdout + result.stderr).not.toContain(sentinel);
  expect(result.stdout + result.stderr).not.toContain("/must-not-open");
});

it("reports controlled drift recovery instructions while withholding arbitrary provider error text", () => {
  const message = "The public release preparation is stale; resume OLD and prepare a new operation outside the pause";
  expect(preparedReleaseErrorMessage(new PreparedPublicReleaseError(message))).toBe(message);
  const sentinel = "synthetic-sensitive-provider-body";
  expect(preparedReleaseErrorMessage(new Error(sentinel))).not.toContain(sentinel);
  expect(preparedReleaseErrorMessage(new Error(sentinel))).toContain("read the preparation, handover and live pointer");
});
