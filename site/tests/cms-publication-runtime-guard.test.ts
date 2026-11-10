// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCmsPublicationDirectoriesSeparated,
  assertCmsPublicationSourceAncestor,
  assertCmsPublicationSourceCheckout,
  assertCmsPreviewSourceCheckout,
} from "../scripts/cms-publication-runtime-guard";

const COMMIT_SHA = "a".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("CMS publication runtime guard", () => {
  it("admits only exact manifest-pinned regular font files in a real clean checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "preview-font-source-"));
    temporaryDirectories.push(root);
    const git = async (args: string[]) => (await promisify(execFile)("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args])).stdout;
    await git(["init", "--quiet"]);
    await writeFile(path.join(root, ".gitignore"), "site/public/brand/fonts/\nnode_modules/\n");
    const names = Object.keys(JSON.parse(await readFile(new URL("../scripts/public-fonts.json", import.meta.url), "utf8")));
    const manifest = Object.fromEntries(names.map(name => [name, createHash("sha256").update(`fixture ${name}`).digest("hex")]));
    await mkdir(path.join(root, "site/scripts"), { recursive: true });
    await mkdir(path.join(root, "site/public/brand"), { recursive: true });
    await writeFile(path.join(root, "site/public/brand/source.txt"), "tracked brand asset");
    await writeFile(path.join(root, "site/scripts/public-fonts.json"), JSON.stringify(manifest));
    await git(["add", "."]);
    await git(["-c", "user.name=Fixture Author", "-c", "user.email=fixture-author@example.org", "commit", "--quiet", "-m", "Pinned font fixture"]);
    const sha = (await git(["rev-parse", "HEAD"])).trim();
    const fonts = path.join(root, "site/public/brand/fonts");
    await mkdir(fonts, { recursive: true });
    for (const name of names) await writeFile(path.join(fonts, name), `fixture ${name}`);
    await expect(assertCmsPreviewSourceCheckout(sha, git)).resolves.toBeUndefined();

    const first = path.join(fonts, names[0]);
    await writeFile(first, "corrupt");
    await expect(assertCmsPreviewSourceCheckout(sha, git)).rejects.toThrow("invalid prepared public fonts");
    await writeFile(first, `fixture ${names[0]}`);
    await writeFile(path.join(fonts, "unexpected.txt"), "unreviewed");
    await expect(assertCmsPreviewSourceCheckout(sha, git)).rejects.toThrow("invalid prepared public fonts");
    await rm(path.join(fonts, "unexpected.txt"));
    await mkdir(path.join(root, "node_modules"));
    const linked = path.join(root, "node_modules/font.woff2");
    await writeFile(linked, `fixture ${names[0]}`);
    await rm(first); await symlink(linked, first);
    await expect(assertCmsPreviewSourceCheckout(sha, git)).rejects.toThrow("invalid prepared public fonts");
    await rm(first);
    await expect(assertCmsPreviewSourceCheckout(sha, git)).rejects.toThrow("invalid prepared public fonts");
  });

  it.each([".env\0", "site/service-account.json\0", "scratch/\0"])("refuses ignored preview source files: %s", async ignored => {
    const git = vi.fn(async ([command]) => command === "rev-parse" ? `${COMMIT_SHA}\n` : command === "ls-files" ? ignored : "");
    await expect(assertCmsPreviewSourceCheckout(COMMIT_SHA, git)).rejects.toThrow("unexpected ignored files");
  });

  it("allows only installed dependencies and the generated Astro mount point in preview source", async () => {
    const git = vi.fn(async ([command]) => command === "rev-parse" ? `${COMMIT_SHA}\n`
      : command === "ls-files" ? "node_modules/\0site/node_modules/\0site/.astro/\0site/.compiled-renderer/\0" : "");
    await expect(assertCmsPreviewSourceCheckout(COMMIT_SHA, git)).resolves.toBeUndefined();
    expect(git).toHaveBeenCalledWith(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"]);
  });

  it("overlaps the ignored scan with checkout reads and waits for both before admission", async () => {
    let finishHead!: (head: string) => void;
    let finishIgnored!: (files: string) => void;
    const head = new Promise<string>(resolve => { finishHead = resolve; });
    const ignored = new Promise<string>(resolve => { finishIgnored = resolve; });
    const git = vi.fn(async ([command]) => command === "rev-parse" ? head : command === "ls-files" ? ignored : "");
    const settled = vi.fn();
    const result = assertCmsPreviewSourceCheckout(COMMIT_SHA, git).then(settled);
    await vi.waitFor(() => expect(git).toHaveBeenCalledWith(expect.arrayContaining(["ls-files"])));
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(["status"]));
    finishHead(COMMIT_SHA);
    await vi.waitFor(() => expect(git).toHaveBeenCalledWith(expect.arrayContaining(["status"])));
    expect(settled).not.toHaveBeenCalled();
    finishIgnored("");
    await result;
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(["checkout", "ignored"])("drains the other source read when %s fails", async failed => {
    let finishHead!: (head: string) => void;
    let finishIgnored!: (files: string) => void;
    const head = new Promise<string>(resolve => { finishHead = resolve; });
    const ignored = new Promise<string>(resolve => { finishIgnored = resolve; });
    const error = new Error("ignored scan unavailable");
    const git = vi.fn(async ([command]) => {
      if (command === "rev-parse") return head;
      if (command === "ls-files") { if (failed === "ignored") throw error; return ignored; }
      return "";
    });
    const settled = vi.fn();
    const result = assertCmsPreviewSourceCheckout(COMMIT_SHA, git).catch(error => { settled(); return error; });
    await vi.waitFor(() => expect(git).toHaveBeenCalledWith(expect.arrayContaining(["ls-files"])));
    if (failed === "checkout") {
      finishHead("b".repeat(40));
      await vi.waitFor(() => expect(git).toHaveBeenCalledWith(expect.arrayContaining(["status"])));
    }
    expect(settled).not.toHaveBeenCalled();
    finishHead(COMMIT_SHA); finishIgnored("");
    if (failed === "checkout") expect((await result).message).toContain("does not match");
    else expect(await result).toBe(error);
  });

  it("keeps checkout error priority when both concurrent reads fail", async () => {
    const git = vi.fn(async ([command]) => {
      if (command === "ls-files") throw new Error("ignored scan unavailable");
      if (command === "rev-parse") return "b".repeat(40);
      return "";
    });
    await expect(assertCmsPreviewSourceCheckout(COMMIT_SHA, git)).rejects.toThrow("does not match");
  });

  it("rejects invalid preview identity before any Git work", async () => {
    const git = vi.fn();
    await expect(assertCmsPreviewSourceCheckout("short", git)).rejects.toThrow("source identity is invalid");
    expect(git).not.toHaveBeenCalled();
  });

  it("preserves real Git rejection of tracked, untracked and ignored source changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "preview-source-"));
    temporaryDirectories.push(root);
    const git = async (args: string[]) => (await promisify(execFile)("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args])).stdout;
    await git(["init", "--quiet"]);
    await writeFile(path.join(root, ".gitignore"), "scratch/\nnode_modules/\n");
    await writeFile(path.join(root, "source.txt"), "original");
    await git(["add", "."]);
    await git(["-c", "user.name=Fixture Author", "-c", "user.email=fixture-author@example.org", "commit", "--quiet", "-m", "Source guard fixture"]);
    const sha = (await git(["rev-parse", "HEAD"])).trim();
    await expect(assertCmsPreviewSourceCheckout(sha, git)).resolves.toBeUndefined();
    await expect(assertCmsPreviewSourceCheckout("b".repeat(40), git)).rejects.toThrow("does not match");
    await writeFile(path.join(root, "source.txt"), "changed");
    await expect(assertCmsPreviewSourceCheckout(sha, git)).rejects.toThrow("does not match");
    await writeFile(path.join(root, "source.txt"), "original");
    await writeFile(path.join(root, "untracked.txt"), "untracked");
    await expect(assertCmsPreviewSourceCheckout(sha, git)).rejects.toThrow("does not match");
    await rm(path.join(root, "untracked.txt"));
    await mkdir(path.join(root, "scratch"));
    await writeFile(path.join(root, "scratch/value.txt"), "ignored");
    await expect(assertCmsPreviewSourceCheckout(sha, git)).rejects.toThrow("unexpected ignored files");
    await rm(path.join(root, "scratch"), { recursive: true });
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules/value.txt"), "installed");
    await expect(assertCmsPreviewSourceCheckout(sha, git)).resolves.toBeUndefined();
  });

  it("accepts only the exact clean configured checkout", async () => {
    const runGit = vi.fn()
      .mockResolvedValueOnce(`${COMMIT_SHA}\n`)
      .mockResolvedValueOnce("");

    await expect(assertCmsPublicationSourceCheckout(COMMIT_SHA, runGit))
      .resolves.toBeUndefined();
    expect(runGit.mock.calls).toEqual([
      [["rev-parse", "--verify", "HEAD^{commit}"]],
      [[
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]],
    ]);
  });

  it.each([
    ["another commit", `${"b".repeat(40)}\n`, ""],
    ["a dirty tree", `${COMMIT_SHA}\n`, " M site/src/pages/index.astro\n"],
  ])("refuses %s", async (_label, head, status) => {
    const runGit = vi.fn()
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce(status);

    await expect(assertCmsPublicationSourceCheckout(COMMIT_SHA, runGit))
      .rejects.toThrow(/does not match the configured commit/i);
  });

  it("refuses an invalid identity or an unavailable Git checkout", async () => {
    await expect(assertCmsPublicationSourceCheckout("short", vi.fn()))
      .rejects.toThrow(/source identity is invalid/i);
    await expect(assertCmsPublicationSourceCheckout(
      COMMIT_SHA,
      vi.fn(async () => {
        throw new Error("git unavailable");
      }),
    )).rejects.toThrow(/could not be verified/i);
  });

  it("requires the superseded source to be an ancestor of the operator", async () => {
    const ancestor = "b".repeat(40);
    const runGit = vi.fn().mockResolvedValue("");

    await expect(assertCmsPublicationSourceAncestor(
      ancestor,
      COMMIT_SHA,
      runGit,
    )).resolves.toBeUndefined();
    expect(runGit).toHaveBeenCalledWith([
      "merge-base",
      "--is-ancestor",
      ancestor,
      COMMIT_SHA,
    ]);

    await expect(assertCmsPublicationSourceAncestor(
      COMMIT_SHA,
      COMMIT_SHA,
      runGit,
    )).rejects.toThrow(/source ancestry is invalid/i);
    await expect(assertCmsPublicationSourceAncestor(
      ancestor,
      COMMIT_SHA,
      vi.fn(async () => {
        throw new Error("not an ancestor");
      }),
    )).rejects.toThrow(/is not an ancestor/i);
  });

  it("resolves a missing state directory through symlinked ancestors", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "njpbs-runtime-path-"));
    temporaryDirectories.push(parent);
    const buildDirectory = path.join(parent, "build");
    const alias = path.join(parent, "alias");
    await mkdir(buildDirectory);
    await symlink(buildDirectory, alias);

    await expect(assertCmsPublicationDirectoriesSeparated(
      path.join(alias, "state"),
      buildDirectory,
    )).rejects.toThrow(/state and build directories overlap/i);
    await expect(assertCmsPublicationDirectoriesSeparated(
      path.join(parent, "state"),
      buildDirectory,
    )).resolves.toBeUndefined();
    await expect(assertCmsPublicationDirectoriesSeparated(
      "/",
      buildDirectory,
    )).rejects.toThrow(/directories are invalid/i);
  });
});
