import { assertDevelopmentSource, hasRenderedDevelopmentInputs } from "../../scripts/render-development-config.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_SHA = /^[a-f0-9]{40}$/;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

type RunGit = (args: string[]) => Promise<string>;

export class CmsPublicationRuntimeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationRuntimeGuardError";
  }
}

function runtimeError(message: string): never {
  throw new CmsPublicationRuntimeGuardError(message);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([field]) => !field.startsWith("GIT_")),
  );
}

// A container image gives every tracked file a new inode and ctime, so the
// first status re-reads and hashes the whole tree. That keeps the exact content
// check; on a cold container disk it needs far more than a few seconds.
function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        repositoryRoot,
        ...args,
      ],
      {
        encoding: "utf8",
        env: gitEnvironment(),
        maxBuffer: 64 * 1_024,
        timeout: 120_000,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export async function assertCmsPublicationSourceCheckout(
  expectedCommitSha: string,
  git: RunGit = runGit,
): Promise<void> {
  if (!COMMIT_SHA.test(expectedCommitSha ?? "") || typeof git !== "function") {
    runtimeError("The CMS publication source identity is invalid");
  }
  let head: string;
  let status: string;
  try {
    head = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    status = await git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
  } catch {
    runtimeError("The CMS publication source checkout could not be verified");
  }
  let prepared = status === "";
  try {
    if (hasRenderedDevelopmentInputs(repositoryRoot)) prepared = assertDevelopmentSource(repositoryRoot);
  } catch { prepared = false; }
  if (head !== expectedCommitSha || !prepared) {
    runtimeError("The CMS publication source checkout does not match the configured commit");
  }
}

/** A preview mounts its installed source read-only. Refuse ignored credentials
 * and scratch files too; ordinary git status deliberately omits those files.
 */
export async function assertCmsPreviewSourceCheckout(expectedCommitSha: string, git: RunGit = runGit): Promise<void> {
  if (!COMMIT_SHA.test(expectedCommitSha ?? "") || typeof git !== "function") {
    runtimeError("The CMS publication source identity is invalid");
  }
  // The ignored-file scan and exact checkout check are independent local reads.
  // Drain both before returning, including failures; downstream source admission
  // still requires every check, with checkout errors retaining priority.
  const [checkout, ignored] = await Promise.allSettled([
    assertCmsPublicationSourceCheckout(expectedCommitSha, git),
    Promise.resolve().then(() => git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"])),
  ]);
  if (checkout.status === "rejected") throw checkout.reason;
  if (ignored.status === "rejected") throw ignored.reason;
  // The compiled directory has a separate exact-source/file-digest check at
  // startup and inside each sandbox job; it is never an arbitrary source root.
  const allowed = new Set([".rendered-deployment-inputs.json", "node_modules/", "site/node_modules/", "admin/node_modules/", "functions/node_modules/", "cms-api/node_modules/", "site/.astro/", "site/.compiled-renderer/", "site/.public-post-renderer/"]);
  const fontPath = "site/public/brand/fonts/";
  if (ignored.value.split("\0").includes(fontPath)) {
    try {
      const root = (await git(["rev-parse", "--show-toplevel"])).trim();
      if (!path.isAbsolute(root)) throw new Error("Invalid source root");
      const directory = path.join(root, fontPath);
      if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid font directory");
      const manifest = JSON.parse(await readFile(path.join(root, "site/scripts/public-fonts.json"), "utf8"));
      const files = await readdir(directory, { withFileTypes: true });
      if (files.some(file => !file.isFile() || !/^PBSSans(?:-(?:Light|Medium|Bold|Black))?\.woff2$/.test(file.name)) ||
          JSON.stringify(files.map(file => file.name).sort()) !== JSON.stringify(Object.keys(manifest).sort())) throw new Error("Invalid font inventory");
      for (const file of files) {
        const handle = await open(path.join(directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || createHash("sha256").update(await handle.readFile()).digest("hex") !== manifest[file.name]) {
            throw new Error("Invalid font bytes");
          }
        } finally { await handle.close(); }
      }
      allowed.add(fontPath);
    } catch { runtimeError("The private preview source contains invalid prepared public fonts"); }
  }
  if (ignored.value.split("\0").filter(Boolean).some(file => !allowed.has(file))) {
    runtimeError("The private preview source contains unexpected ignored files");
  }
}

export async function assertCmsPublicationSourceAncestor(
  ancestorCommitSha: string,
  descendantCommitSha: string,
  git: RunGit = runGit,
): Promise<void> {
  if (
    !COMMIT_SHA.test(ancestorCommitSha ?? "") ||
    !COMMIT_SHA.test(descendantCommitSha ?? "") ||
    ancestorCommitSha === descendantCommitSha ||
    typeof git !== "function"
  ) {
    runtimeError("The CMS publication source ancestry is invalid");
  }
  try {
    await git([
      "merge-base",
      "--is-ancestor",
      ancestorCommitSha,
      descendantCommitSha,
    ]);
  } catch {
    runtimeError("The superseded CMS publication source is not an ancestor");
  }
}

async function canonicalPotentialPath(inputPath: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path.resolve(inputPath);
  while (true) {
    try {
      return path.join(await realpath(candidate), ...missingSegments.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertCmsPublicationDirectoriesSeparated(
  stateDirectory: string,
  buildDirectory: string,
): Promise<void> {
  if (
    !path.isAbsolute(stateDirectory) ||
    !path.isAbsolute(buildDirectory) ||
    path.parse(stateDirectory).root === stateDirectory ||
    path.parse(buildDirectory).root === buildDirectory
  ) {
    runtimeError("The CMS publication directories are invalid");
  }
  let canonicalState: string;
  let canonicalBuild: string;
  try {
    [canonicalState, canonicalBuild] = await Promise.all([
      canonicalPotentialPath(stateDirectory),
      canonicalPotentialPath(buildDirectory),
    ]);
  } catch {
    runtimeError("The CMS publication directories could not be verified");
  }
  if (
    pathsOverlap(canonicalState, canonicalBuild) ||
    pathsOverlap(canonicalBuild, canonicalState)
  ) {
    runtimeError("The CMS publication state and build directories overlap");
  }
}
