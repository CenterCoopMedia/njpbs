// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPublicBuildSettings, assertPreparedPublicBuildSettings } from "../../functions/lib/public-build-settings.js";
import { expectedPublicBuildValues, readPreparedPublicBuildSettings } from "../scripts/prepared-public-build-settings";

const commitSha = "a".repeat(40);
const values = { PUBLIC_GA4_MEASUREMENT_ID: "G-TEST123", PUBLIC_REPORT_ENDPOINT: "https://report.example.org/",
  PUBLIC_SHARE_INTAKE_ENDPOINT: "https://intake.example.org/", PUBLIC_TURNSTILE_SITEKEY: "1x00000000000000000000AA" };
const snapshot = { schemaVersion: 1 as const, commitSha, values, overridesAbsent: true };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "prepared-public-settings-"));
  await mkdir(path.join(directory, "renderer"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));
const store = (value: unknown) => writeFile(path.join(directory, "renderer/public-build-settings.json"), JSON.stringify(value));

it("records only effective public compiler inputs and keeps the snapshot independent of its caller", () => {
  const environment = { ...values, NODE_ENV: "production", FIREBASE_SERVICE_ACCOUNT: "synthetic-sensitive-value" };
  const recorded = createPublicBuildSettings(commitSha, environment, environment);
  expect(recorded).toEqual(snapshot);
  expect(JSON.stringify(recorded)).not.toContain("synthetic-sensitive-value");
  expect(JSON.stringify(recorded)).not.toContain("FIREBASE_SERVICE_ACCOUNT");
  environment.PUBLIC_REPORT_ENDPOINT = "https://later.example.org/";
  expect(recorded.values.PUBLIC_REPORT_ENDPOINT).toBe("https://report.example.org/");
});

it("compares the restored file's own inputs and preserves its original source and values", async () => {
  await store(snapshot);
  expect(await readPreparedPublicBuildSettings(directory, commitSha, values)).toEqual(snapshot);
  await expect(readPreparedPublicBuildSettings(directory, commitSha,
    { ...values, PUBLIC_GA4_MEASUREMENT_ID: "G-OTHER123" })).rejects.toThrow("missing or differ");
  await expect(readPreparedPublicBuildSettings(directory, "b".repeat(40), values)).rejects.toThrow("missing or differ");
});

it.each(Object.keys(values))("rejects a missing recorded input: %s", async name => {
  const missing = { ...values } as Record<string, string>;
  delete missing[name];
  await store({ ...snapshot, values: missing });
  await expect(readPreparedPublicBuildSettings(directory, commitSha, values)).rejects.toThrow("missing or differ");
});

it.each(["PUBLIC_SHARE_PAGE", "PUBLIC_SHARE_UPLOAD_ORIGIN", "NO_BUILD_POST_ENABLED", "NO_BUILD_POST_ID",
  "NO_BUILD_POST_BACKGROUND_BUCKET", "NO_BUILD_POST_UNKNOWN"])("refuses even an empty optional override: %s", name => {
  const requested = { ...values, [name]: "" };
  const recorded = createPublicBuildSettings(commitSha, values, requested);
  expect(recorded.overridesAbsent).toBe(false);
  expect(Object.keys(recorded.values)).toEqual(Object.keys(values));
  expect(() => assertPreparedPublicBuildSettings(recorded, commitSha, values)).toThrow("missing or differ");
  expect(() => expectedPublicBuildValues(commitSha, requested)).toThrow();
});

it("refuses absent, malformed and unknown stored fields without exposing their values", async () => {
  await expect(readPreparedPublicBuildSettings(directory, commitSha, values)).rejects.toThrow("missing or differ");
  await writeFile(path.join(directory, "renderer/public-build-settings.json"), "not-json");
  await expect(readPreparedPublicBuildSettings(directory, commitSha, values)).rejects.toThrow("missing or differ");
  for (const record of [{ ...snapshot, secret: "synthetic-sensitive-value" },
    { ...snapshot, values: { ...values, SECRET: "synthetic-sensitive-value" } }]) {
    expect(() => assertPreparedPublicBuildSettings(record, commitSha, values)).toThrow("missing or differ");
    try { assertPreparedPublicBuildSettings(record, commitSha, values); } catch (error) {
      expect(String(error)).not.toContain("synthetic-sensitive-value");
    }
  }
});

it("normalizes approved endpoints through the same compiler boundary and rejects URL credentials", () => {
  expect(expectedPublicBuildValues(commitSha, { ...values,
    PUBLIC_REPORT_ENDPOINT: "https://report.example.org", PUBLIC_SHARE_INTAKE_ENDPOINT: "https://intake.example.org" })).toEqual(values);
  expect(() => createPublicBuildSettings(commitSha,
    { ...values, PUBLIC_REPORT_ENDPOINT: "https://user:synthetic-sensitive-value@report.example.org/" }, values))
    .toThrow("missing or differ");
});
