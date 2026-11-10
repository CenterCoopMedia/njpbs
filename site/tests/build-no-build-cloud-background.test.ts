// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const boundary = vi.hoisted(() => ({ execFile: vi.fn(), sandbox: vi.fn(), realpath: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: boundary.realpath.mockImplementation(actual.realpath) };
});
vi.mock("node:child_process", () => ({ execFile: boundary.execFile }));
vi.mock("../scripts/process-cms-preview", () => ({ privatePreviewSandbox: boundary.sandbox }));
vi.mock("../scripts/cms-publication-runtime-guard", () => ({ assertCmsPublicationSourceCheckout: vi.fn(async () => {}) }));
import { buildNoBuildCloudBackground } from "../scripts/build-no-build-cloud-background";
import { backgroundPreparationDiagnostic } from "../scripts/background-preparation-diagnostic";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";

let directory: string;
const commitSha = "a".repeat(40);
const buildBatchId = `post-background-${"1".repeat(20)}-${"b".repeat(64)}`;
const publicEnvironment = { PUBLIC_GA4_MEASUREMENT_ID: "G-FIXTURE123", PUBLIC_REPORT_ENDPOINT: "https://report.example.test",
  PUBLIC_TURNSTILE_SITEKEY: "fixture-sitekey" };
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "cloud-background-boundary-"));
  boundary.sandbox.mockImplementation(async (env: Record<string, string>) => ({ args: ["--unshare-all", "--"], environment: env }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const run = () => buildNoBuildCloudBackground({ buildBatchId, commitSha, retainedInputDirectory: directory,
  artifactReceiptPath: path.join(directory, "artifact-inventory.json"), buildEnvironment: publicEnvironment }, path.join(directory, "dist"));

it("retains the child exit and failing stage while removing credentials and every supplied environment value", async () => {
  vi.stubEnv("BOUNDARY_PASSWORD", "synthetic-private-value");
  const raw = ["build failed: EROFS: read-only file system, open /app/site/cache/file",
    "password='unknown quoted password' token: unknown-token",
    "Authorization: Bearer synthetic-bearer-value",
    "https://user:password@example.test/path?credential=unknown",
    "BOUNDARY_PASSWORD=synthetic-private-value",
    "public env G-FIXTURE123 fixture-sitekey https://report.example.test",
    "-----BEGIN PRIVATE KEY-----\nsynthetic-key-material\n-----END PRIVATE KEY-----",
    "opaque 1234567890abcdefghijklmnopqrstuv"].join("\n");
  boundary.execFile.mockImplementation((_command, _args, _options, done) => done(
    Object.assign(new Error(`command contains synthetic-private-value: ${raw}`), { code: 1, signal: null }),
    JSON.stringify({ event: "cms_public_build_timing", stage: "astro_build_started" }), raw));
  const failure = await run().catch(error => error);
  const text = backgroundPreparationDiagnostic(failure, "renderer", publicEnvironment);
  expect(JSON.parse(text)).toMatchObject({ stage: "astro_build", exitCode: 1, signal: null });
  expect(text).toContain("EROFS: read-only file system");
  for (const value of ["unknown quoted password", "unknown-token", "synthetic-bearer-value", "user:password",
    "synthetic-private-value", "G-FIXTURE123", "fixture-sitekey", "report.example.test", "synthetic-key-material",
    "1234567890abcdefghijklmnopqrstuv"]) expect(text).not.toContain(value);
  expect(failure.message).not.toContain(raw);
  expect(boundary.execFile.mock.calls[0][2]).toMatchObject({ timeout: 300_000, killSignal: "SIGKILL" });
});

it("keeps the last stderr lines under 2 KiB and reports a signal with no exit code", async () => {
  const raw = Array.from({ length: 50 }, (_, index) => `entry-${index}: ${"failure ".repeat(70)}é`).join("\n");
  boundary.execFile.mockImplementation((_command, _args, _options, done) => done(
    Object.assign(new Error("deadline"), { code: null, signal: "SIGKILL", killed: true }), "", raw));
  const text = backgroundPreparationDiagnostic(await run().catch(error => error), "renderer", {});
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
  expect(JSON.parse(text)).toMatchObject({ stage: "renderer_start", exitCode: null, signal: "SIGKILL" });
  expect(text).toContain("entry-49:");
  expect(text).not.toContain("entry-0:");
  expect(text).not.toContain("�");
});

it("captures spawn failure without retaining the command or trusting arbitrary child stages", async () => {
  boundary.execFile.mockImplementation((_command, _args, _options, done) => done(
    Object.assign(new Error("spawn /usr/bin/bwrap ENOENT secret-command"), { code: "ENOENT" }),
    JSON.stringify({ event: "cms_public_build_timing", stage: "secret-stage" }), ""));
  const text = backgroundPreparationDiagnostic(await run().catch(error => error), "renderer", {});
  expect(JSON.parse(text)).toMatchObject({ stage: "renderer_start", exitCode: null, signal: null, failureCode: "ENOENT" });
  expect(text).not.toContain("secret-command");
  expect(text).not.toContain("secret-stage");
});

it("copies the verified receipt and public context after a successful child build", async () => {
  const { privatePreviewSandbox } = await vi.importActual<typeof import("../scripts/process-cms-preview")>("../scripts/process-cms-preview");
  boundary.sandbox.mockImplementation(privatePreviewSandbox);
  // Supply installed-dependency locations at the filesystem boundary; Site CI
  // installs only Site dependencies. Keep the actual sandbox argument builder.
  const rootDependencies = path.join(directory, "root-dependencies");
  const siteDependencies = path.join(directory, "site-dependencies");
  await mkdir(rootDependencies);
  await mkdir(siteDependencies);
  const dependencies = new Map([
    [fileURLToPath(new URL("../../node_modules", import.meta.url)), rootDependencies],
    [fileURLToPath(new URL("../node_modules", import.meta.url)), siteDependencies],
  ]);
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  boundary.realpath.mockImplementation((file) => dependencies.has(String(file))
    ? actualFs.realpath(dependencies.get(String(file))!) : actualFs.realpath(file));
  const dist = path.join(directory, "dist");
  await mkdir(dist, { mode: 0o700 });
  const cutoffAt = { seconds: 1700000000, nanoseconds: 0, toMillis: () => 1700000000000 };
  const receipt = createPublicArtifactInventoryReceipt({
    reservation: { schemaVersion: 1, buildBatchId, commitSha, generation: 1, status: "reserved",
      cutoffAt, reservedAt: cutoffAt, reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
      reservedAgainstCommitSha: null }, pages: [], posts: [], programs: [], authors: [], settings: [],
  });
  await writeFile(path.join(dist, "artifact-inventory.json"), JSON.stringify(receipt));
  await writeFile(path.join(dist, "public-context.json"), "{}");
  boundary.execFile.mockImplementation((_command, _args, _options, done) => done(null, "", ""));
  expect(await run()).toEqual(receipt);
  expect(await readFile(path.join(directory, "public-context.json"), "utf8")).toBe("{}");
  const env = boundary.execFile.mock.calls[0][2].env;
  expect(env).not.toHaveProperty("CMS_PREVIEW_INPUT_PATH");
  expect(env.PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH).toBe("/preview/input.json");
  expect(env.CMS_OFFLINE_BUILD).toBe("1");
  expect(env.DATA_HUB_PUBLIC).toBe("1");
  expect(env).not.toHaveProperty("CMS_RETAINED_IMAGES_READY");
  expect(env.PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH).toBe("/background/remote-images.json");
  expect(env.SCHEDULE_DATA_PATH).toBe("/background/schedule.json");
  const args = boundary.execFile.mock.calls[0][1];
  expect(args).toContain("--unshare-all");
  expect(args).toContain("--unshare-user");
  for (const dependency of [rootDependencies, siteDependencies]) {
    const index = args.indexOf(dependency);
    expect(args.slice(index - 1, index + 2)).toEqual(["--ro-bind", dependency, dependency]);
  }
  expect(args).not.toContain("/preview/schedule.json");
  const schedule = args.indexOf("/background/schedule.json");
  expect(args.slice(schedule - 2, schedule + 1)).toEqual(["--ro-bind", path.join(directory, "schedule.json"), "/background/schedule.json"]);
  const images = args.indexOf("/background/images");
  expect(args.slice(images - 2, images + 1)).toEqual(["--ro-bind-try", path.join(directory, "images"), "/background/images"]);
});

it("redacts a multiline credential before taking its bounded tail", () => {
  const diagnostic = backgroundPreparationDiagnostic(new Error("password='first-line\nlast-line'\nEROFS"), "freeze_input", {});
  expect(diagnostic).not.toContain("first-line");
  expect(diagnostic).not.toContain("last-line");
  expect(diagnostic).toContain("EROFS");
});

it("preserves stack paths and numeric error evidence while removing short environment assignments", () => {
  // GitHub's Site job sets this public identifier to "site". It must not erase
  // that directory segment from an unrelated stack frame.
  vi.stubEnv("GITHUB_JOB", "site");
  const diagnostic = backgroundPreparationDiagnostic(new Error("child failed"), "astro_build", {
    CMS_LOADER_STRICT: "1", PUBLIC_POST_RENDERER_COMPILE: "0", PORT: "8080", PUBLIC_ARTIFACT_BATCH_MODE: "background",
  }, 'at /app/site/node_modules/package/scripts/build-with-production-sync.mjs:120:15\nexit 1\nCMS_LOADER_STRICT=1\nGITHUB_JOB=site\n{"PORT":"8080"}');
  expect(diagnostic).toContain("/app/site/node_modules/package/scripts/build-with-production-sync.mjs:120:15");
  expect(diagnostic).toContain("exit 1");
  expect(diagnostic).not.toContain("CMS_LOADER_STRICT=1");
  expect(diagnostic).not.toContain("8080");
  expect(diagnostic).not.toContain("GITHUB_JOB=site");
});
