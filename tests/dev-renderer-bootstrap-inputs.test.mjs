import { repositoryFixture } from "./helpers/repository-identity.mjs";
import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDevRendererReleaseSource, devRendererReleaseMode } from "../scripts/lib/dev-renderer-release-source.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const environment = (operator, source = operator) => ({ ...repositoryFixture,
  GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID: repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID,
  CMS_DEV_RELEASE_PREVIEW_RENDERER: "true", CMS_DEV_RENDERER_ONLY: "true",
  CMS_DEV_RENDERER_REQUESTED_SOURCE_SHA: source, CMS_DEV_PRESERVE_PREVIEW_PAUSE: "true",
  CMS_DEPLOY_OWNER: "fixture-user", GITHUB_SHA: operator, GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "fixture-user", GITHUB_TRIGGERING_ACTOR: "fixture-user",
  GITHUB_WORKFLOW_REF: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main",
  RUNNER_ENVIRONMENT: "github-hosted",
});

it("keeps the requested source separate from the ordinary component pin", () => {
  expect(devRendererReleaseMode({ GITHUB_SHA: "a".repeat(40), CMS_DEV_RENDERER_SOURCE_SHA: "b".repeat(40) }))
    .toEqual({ rendererOnly: false, preservePreviewPause: false, restorePreviewBootstrap: false, sourceSha: "a".repeat(40) });
});
it.each([
  { CMS_DEV_RELEASE_PREVIEW_RENDERER: "false" }, { CMS_DEV_RENDERER_ONLY: "false" },
  { CMS_DEV_RENDERER_REQUESTED_SOURCE_SHA: "" }, { CMS_DEV_RENDERER_REQUESTED_SOURCE_SHA: "untrusted" },
  { CMS_DEV_PRESERVE_PREVIEW_PAUSE: "false" },
  { CMS_DEV_PRESERVE_PREVIEW_PAUSE: "yes" }, { CMS_DEV_RESTORE_PREVIEW_BOOTSTRAP: "true", CMS_DEV_PRESERVE_PREVIEW_PAUSE: "false" },
  { CMS_DEV_INSTALL_READER_BRIDGE: "true" },
])("rejects an invalid renderer-only request %j", changed => {
  expect(() => devRendererReleaseMode({ ...environment("a".repeat(40)), ...changed })).toThrow();
});
it("requires renderer-only and pause preservation for an explicit restore", () => {
  expect(devRendererReleaseMode({ ...environment("a".repeat(40)), CMS_DEV_RESTORE_PREVIEW_BOOTSTRAP: "true" }).restorePreviewBootstrap).toBe(true);
  expect(() => devRendererReleaseMode({ CMS_DEV_RESTORE_PREVIEW_BOOTSTRAP: "true" })).toThrow();
});

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), "dev-renderer-provenance-")); directories.push(directory);
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
  git("init", "--quiet"); await mkdir(join(directory, "preview-renderer"));
  const worker = "export default class {\n  async readCurrentCode() {}\n  async readCurrentCodeReference() {}\n}\n";
  await writeFile(join(directory, "preview-renderer/worker.ts"), worker);
  git("add", "."); const tree = git("write-tree"); const source = git("commit-tree", tree, "-m", "Fixture retained source");
  git("update-ref", "HEAD", source); git("reset", "--hard", source);
  await writeFile(join(directory, "operator.txt"), "Fixture operator\n"); git("add", ".");
  const operatorTree = git("write-tree"); const operator = git("commit-tree", operatorTree, "-p", source, "-m", "Fixture operator");
  git("update-ref", "HEAD", operator); git("reset", "--hard", operator);
  return { directory, git, source, operator, tree, worker };
}

it("seals retained ancestry against the actual clean operator without changing its event SHA", async () => {
  const fixture = await repository();
  const result = assertDevRendererReleaseSource(fixture.source, environment(fixture.operator, fixture.source), fixture.directory);
  expect(result).toEqual({ schemaVersion: 1, operatorCommitSha: fixture.operator, rendererSha: fixture.source,
    rendererTree: fixture.tree, workerSourceDigest: createHash("sha256").update(fixture.worker).digest("hex") });
  expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.operator);
});
it.each(["dirty", "nonancestor", "event-sha", "fork", "self-hosted", "missing-rpc"])("refuses %s source provenance", async kind => {
  const fixture = await repository(); let source = fixture.source;
  const env = environment(fixture.operator, source);
  if (kind === "dirty") await writeFile(join(fixture.directory, "untracked.txt"), "Unreviewed source\n");
  if (kind === "nonancestor") source = fixture.git("commit-tree", fixture.tree, "-m", "Unrelated root");
  if (kind === "event-sha") env.GITHUB_SHA = fixture.source;
  if (kind === "fork") env.GITHUB_WORKFLOW_REF = env.GITHUB_WORKFLOW_REF.replace("CenterCoopMedia", "untrusted");
  if (kind === "self-hosted") env.RUNNER_ENVIRONMENT = "self-hosted";
  if (kind === "missing-rpc") {
    await writeFile(join(fixture.directory, "preview-renderer/worker.ts"), "export default class { fetch() {} }\n");
    fixture.git("add", "."); source = fixture.git("commit-tree", fixture.git("write-tree"), "-p", fixture.operator, "-m", "Source without CODE RPCs");
    fixture.git("update-ref", "HEAD", source); fixture.git("reset", "--hard", source); env.GITHUB_SHA = source;
  }
  env.CMS_DEV_RENDERER_REQUESTED_SOURCE_SHA = source;
  expect(() => assertDevRendererReleaseSource(source, env, fixture.directory)).toThrow();
});

it.each([
  { CANONICAL_GITHUB_REPOSITORY: "" }, { CANONICAL_GITHUB_REPOSITORY_ID: "" },
  { CANONICAL_GITHUB_REPOSITORY: "untrusted/repository" }, { CANONICAL_GITHUB_REPOSITORY_ID: "1" },
  { GITHUB_REPOSITORY: "untrusted/repository" }, { GITHUB_REPOSITORY_ID: "" }, { GITHUB_REPOSITORY_ID: "1" },
])("refuses missing or wrong configured/observed repository %j", async changed => {
  const fixture = await repository();
  expect(() => assertDevRendererReleaseSource(fixture.source, { ...environment(fixture.operator, fixture.source), ...changed }, fixture.directory)).toThrow();
});
