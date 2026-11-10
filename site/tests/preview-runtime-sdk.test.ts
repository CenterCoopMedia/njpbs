// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPreviewRuntime } from "../scripts/build-preview-runtime.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("loads one Functions Firestore SDK in the actual compiled preview runtime without starting an app", async () => {
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), "preview-runtime-sdk-"));
  directories.push(root);
  for (const name of ["site/scripts", "site/src/lib", "functions/lib", "scripts", "config", "packages/content-core/src"]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await cp(path.join(repository, name), path.join(root, name), { recursive: true });
  }
  for (const name of ["package.json", "site/package.json", "functions/package.json"]) {
    await cp(path.join(repository, name), path.join(root, name));
  }
  // Site CI installs only site dependencies. Give Functions its own real SDK
  // copy while sharing its transitive packages from that declared install.
  // Keeping distinct SDK entrypoints makes the original duplicate import fail.
  const siteDependencies = path.join(repository, "site/node_modules");
  await symlink(siteDependencies, path.join(root, "site/node_modules"), "dir");
  const functionsDependencies = path.join(root, "node_modules");
  await mkdir(functionsDependencies);
  for (const entry of await readdir(siteDependencies, { withFileTypes: true })) {
    if (entry.name === "firebase-admin") continue;
    await symlink(path.join(siteDependencies, entry.name), path.join(functionsDependencies, entry.name), entry.isDirectory() ? "dir" : "file");
  }
  await cp(path.join(siteDependencies, "firebase-admin"), path.join(functionsDependencies, "firebase-admin"), { recursive: true });
  await buildPreviewRuntime(root);
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import { createRequire } from "node:module";
    const require = createRequire(new URL("./functions/package.json", "file://" + process.cwd() + "/"));
    globalThis.fetch = () => { throw Error("Import must not make network requests"); };
    const runtime = await import("./site/.compiled-renderer/runtime/cloud.mjs");
    const loaded = Object.keys(require.cache).filter(file => file.replaceAll("\\\\", "/").endsWith("/firebase-admin/lib/firestore/index.js"));
    console.log(JSON.stringify({ entry: typeof runtime.serveCmsPreviewCloud, loaded,
      expected: require.resolve("firebase-admin/firestore"), apps: require("firebase-admin/app").getApps().length }));
  `], { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  const result = JSON.parse(stdout);
  expect(result.entry).toBe("function");
  expect(result.loaded).toEqual([result.expected]);
  expect(result.apps).toBe(0);
});
