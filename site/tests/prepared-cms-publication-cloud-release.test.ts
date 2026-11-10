// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { parsePreparedReleaseArguments, preparedReleaseErrorMessage } from "../scripts/prepared-cms-publication-cloud-release";
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

it("refuses a development target before opening any credential descriptor", () => {
  const result = spawnSync(process.execPath, ["--import", `${root}/site/node_modules/tsx/dist/loader.mjs`,
    `${root}/site/scripts/prepared-cms-publication-cloud-release.ts`, "--check", operation, commit], {
    cwd: root, env: { PATH: "/usr/bin:/bin", CMS_DEPLOYMENT_ENVIRONMENT: "development" }, encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("prepared release target must be production");
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
