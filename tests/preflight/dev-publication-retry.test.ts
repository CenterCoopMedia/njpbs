import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repositoryFixture } from "../helpers/repository-identity.mjs";

const identity = { queueId: "A".repeat(20), buildBatchId: `cms-${"A".repeat(20)}`, commitSha: "a".repeat(40) };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let directory: string;

beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(path.join(tmpdir(), "dev-retry-"));
  vi.stubEnv("CMS_DEV_ARTIFACT_DIRECTORY", directory);
  vi.stubEnv("QUEUE_ID", identity.queueId);
  vi.stubEnv("SOURCE_SHA", identity.commitSha);
  vi.stubEnv("GITHUB_EVENT_NAME", "push");
  vi.stubEnv("GITHUB_REF", "refs/heads/main");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function database(input?: Record<string, unknown>) {
  const writes = vi.fn(() => { throw new Error("mutation boundary reached"); });
  const reference = (location: string): any => ({ path: location,
    collection: (name: string) => reference(`${location}/${name}`),
    doc: (name: string) => reference(`${location}/${name}`),
  });
  const transaction = {
    getAll: vi.fn(async (...refs: { path: string }[]) => refs.map(ref => {
      const value = ref.path.endsWith("/inputs/devFrozen") ? input : undefined;
      return { exists: value !== undefined, data: () => value };
    })),
    create: writes, set: writes, update: writes, delete: writes,
  };
  const db = { projectId: "njpbs-site-dev", doc: reference, collection: reference,
    runTransaction: vi.fn(async (read: (transaction: unknown) => unknown) => read(transaction)) };
  return { db, writes };
}

it.each(["2", "3", "invalid"])("refuses fresh preparation on attempt %s before creating a queue or reservation", async attempt => {
  vi.stubEnv("GITHUB_RUN_ATTEMPT", attempt);
  const { prepare } = await import("../../site/scripts/cms-dev-publication.mjs");
  const { db, writes } = database();
  await expect(prepare(db)).rejects.toThrow("reruns require retained frozen input");
  expect(writes).not.toHaveBeenCalled();
  expect(db.runTransaction).toHaveBeenCalledTimes(1);
  expect(db.runTransaction).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
});

it("still allows the original attempt to reach its create-only code-refresh queue boundary", async () => {
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  const { prepare } = await import("../../site/scripts/cms-dev-publication.mjs");
  const { db, writes } = database();
  await expect(prepare(db)).rejects.toThrow("mutation boundary reached");
  expect(writes).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledWith(expect.objectContaining({ path: `cmsPublishQueue/${identity.queueId}` }),
    expect.objectContaining({ triggeredBy: "dev-code-refresh", status: "pending" }));
});

it("reuses exact retained input on a later attempt without reading current content or creating work", async () => {
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
  const names = ["bundle.json", "schedule.json", "launch.json", "spotlight.json", "post-routes.json"];
  const files = names.map(name => [name, Buffer.from(`frozen ${name}`)] as const);
  for (const [name, bytes] of files) await writeFile(path.join(directory, name), bytes);
  const inputDigest = hash(JSON.stringify(files.map(([name, bytes]) => [name, hash(bytes)])));
  await writeFile(path.join(directory, "frozen.json"), JSON.stringify({ identity, inputDigest }));
  const { prepare } = await import("../../site/scripts/cms-dev-publication.mjs");
  const { db, writes } = database({ schemaVersion: 1, ...identity, inputDigest, recordedAt: 1 });
  await expect(prepare(db)).resolves.toBeUndefined();
  expect(writes).not.toHaveBeenCalled();
  expect(db.runTransaction).toHaveBeenCalledTimes(1);
});

it("refuses a rerun without an Actions input artifact before preparing any work", async () => {
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
  const { inspectDevPublicationRetry } = await import("../../site/scripts/cms-dev-publication.mjs");
  const { db, writes } = database();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ total_count: 0, artifacts: [] }));
  await expect(inspectDevPublicationRetry(db, { ...repositoryFixture, GITHUB_RUN_ATTEMPT: "2", GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY,
    GITHUB_RUN_ID: "123", GITHUB_EVENT_NAME: "push", GITHUB_SHA: identity.commitSha,
    QUEUE_ID: identity.queueId, GH_TOKEN: "synthetic-fixture" })).rejects.toThrow("reruns require retained frozen input");
  expect(writes).not.toHaveBeenCalled();
  expect(db.runTransaction).not.toHaveBeenCalled();
});

it("keeps retained-artifact retries available without selecting fresh input", async () => {
  const { inspectDevPublicationRetry } = await import("../../site/scripts/cms-dev-publication.mjs");
  const { db, writes } = database();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ total_count: 1,
    artifacts: [{ name: "dev-publication-input", expired: false }] }));
  await expect(inspectDevPublicationRetry(db, { ...repositoryFixture, GITHUB_RUN_ATTEMPT: "2", GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY,
    GITHUB_RUN_ID: "123", GH_TOKEN: "synthetic-fixture" })).resolves.toBe(true);
  expect(db.runTransaction).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});
