// @vitest-environment node

import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildFrozenPublication } from "../scripts/frozen-publication";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const commitSha = "a".repeat(40);
const buildBatchId = "background-environment-contract";
let directory: string;
let artifactReceiptPath: string;
let inputDirectory: string;
let childEnvironment: Record<string, string | undefined>;
const cutoffAt = {
  seconds: 1_787_000_000, nanoseconds: 0, toMillis: () => 1_787_000_000_000,
};
const receipt = createPublicArtifactInventoryReceipt({
  reservation: {
    schemaVersion: 1, buildBatchId, generation: 7, commitSha,
    cutoffAt, status: "reserved",
    reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
    reservedAgainstCommitSha: null, reservedAt: cutoffAt,
  },
  pages: [], posts: [], programs: [], authors: [], settings: [],
});

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "frozen-publication-contract-"));
  artifactReceiptPath = path.join(directory, "job", "artifact.json");
  inputDirectory = path.join(directory, "sealed-inputs");
  mkdirSync(path.dirname(artifactReceiptPath));
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const gitArgs = args[1] as string[];
    const complete = args.at(-1) as (error: null, stdout: string) => void;
    complete(null, gitArgs.includes("rev-parse") ? `${commitSha}\n` : "");
    return {} as ReturnType<typeof execFile>;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function childWrites(value: unknown) {
  vi.mocked(spawn).mockImplementationOnce((_command, _args, options) => {
    childEnvironment = options!.env!;
    writeFileSync(artifactReceiptPath, JSON.stringify(value));
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    queueMicrotask(() => child.emit("close", 0));
    return child as ReturnType<typeof spawn>;
  });
}

const build = () => buildFrozenPublication({
  buildBatchId, commitSha, artifactReceiptPath, retainedInputDirectory: inputDirectory,
  mediaManagerCredential: { key: "fixture-media-key", secret: "fixture-media-secret" },
  buildEnvironment: {
    PUBLIC_REPORT_ENDPOINT: "https://report.example.test/",
    CMS_CONTENT_MODE: "preview", CMS_PREVIEW_PAGE_ID: "unpublished-page",
    CMS_PREVIEW_INPUT_PATH: "/unpublished-input", PUBLIC_ONLY: "1", INTERNAL_SURFACES: "1",
    LAUNCH_CONTENT_DATA_PATH: "/committed-media", SPOTLIGHT_NEWS_DATA_PATH: "/committed-news",
    SCHEDULE_DATA_PATH: "/committed-schedule", DATA_HUB_PUBLIC: "0",
  },
});

it("passes private published-only inputs to the shared frozen build child", async () => {
  // Characterization of the pre-removal background contract: fresh private
  // outputs and sealed selectors must replace preview/committed fallback inputs.
  childWrites(receipt);
  await expect(build()).resolves.toEqual(receipt);
  expect(childEnvironment).toMatchObject({
    REQUIRE_FRESH_CONTENT: "1", CMS_CONTENT_MODE: "published", CMS_LOADER_STRICT: "1",
    PUBLIC_GA4_REQUIRED: "1", PUBLIC_REPORT_REQUIRED: "1", PUBLIC_SHARE_REQUIRED: "1",
    PUBLIC_REPORT_ENDPOINT: "https://report.example.test/",
    CMS_PREVIEW_PAGE_ID: undefined, CMS_PREVIEW_INPUT_PATH: undefined,
    DATA_HUB_PUBLIC: "1", PUBLIC_ONLY: undefined, INTERNAL_SURFACES: undefined, CMS_OFFLINE_BUILD: "1",
    LAUNCH_CONTENT_OUTPUT: path.join(directory, "job", "launch-media-manager.json"),
    SPOTLIGHT_NEWS_OUTPUT: path.join(directory, "job", "spotlight-news.json"),
    SCHEDULE_OUTPUT: path.join(directory, "job", "schedule.json"),
    LAUNCH_CONTENT_DATA_PATH: path.join(inputDirectory, "launch-media-manager.json"),
    SPOTLIGHT_NEWS_DATA_PATH: path.join(inputDirectory, "spotlight-news.json"),
    SCHEDULE_DATA_PATH: path.join(inputDirectory, "schedule.json"),
    PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH: path.join(inputDirectory, "input.json"),
    PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH: path.join(inputDirectory, "remote-images.json"),
    PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH: path.join(directory, "job", "public-context.json"),
    PUBLIC_BUILD_BATCH_ID: buildBatchId, PUBLIC_BUILD_COMMIT_SHA: commitSha,
    PUBLIC_ARTIFACT_INVENTORY_PATH: artifactReceiptPath,
  });
  expect(Object.values(childEnvironment)).not.toContain("fixture-media-key");
  expect(Object.values(childEnvironment)).not.toContain("fixture-media-secret");
});

it("rejects a successful child with an invalid artifact receipt", async () => {
  childWrites({});
  await expect(build()).rejects.toThrow(/receipt/i);
});
