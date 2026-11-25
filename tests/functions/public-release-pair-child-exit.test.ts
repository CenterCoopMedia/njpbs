import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pairRenderFailure } from "../../site/scripts/public-release-pair-child-exit";
const work = createRequire(import.meta.url)("../../functions/lib/public-release-pair-work.js");

const root = path.resolve(import.meta.dirname, "../..");
const href = (name: string) => pathToFileURL(path.join(root, name)).href;
let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "pair-child-exit-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
// A real child whose top-level render fails, as the sealed entry does.
async function exitCode(error: string) {
  const entry = path.join(directory, "entry.mjs");
  await writeFile(entry, `import { exitWithPairRenderFailure } from ${JSON.stringify(href("site/scripts/public-release-pair-child-exit.ts"))};
exitWithPairRenderFailure();
await Promise.resolve();
throw ${error};
`);
  return spawnSync(process.execPath, ["--import", href("site/node_modules/tsx/dist/loader.mjs"), entry], { stdio: "ignore" }).status;
}
it.each([["EMFILE", 'Object.assign(new Error("open"), { code: "EMFILE" })'],
  ["a wrapped ENOSPC", 'new Error("render", { cause: Object.assign(new Error("write"), { code: "ENOSPC" }) })']])(
  "waits after the child failed with %s", async (_label, error) => {
    const failure = pairRenderFailure(await exitCode(error));
    expect(failure).toBe("render-interrupted");
    expect(work.isPairFinalFailure(failure)).toBe(false);
  });
it.each([["a render error", 'new Error("Input scope differs")'],
  ["a live request, which the sandbox refuses", 'Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH" } })'],
  ["a missing file", 'Object.assign(new Error("open"), { code: "ENOENT" })']])(
  "stays final after the child failed with %s", async (_label, error) => {
    const failure = pairRenderFailure(await exitCode(error));
    expect(failure).toBe("render-failed");
    expect(work.isPairFinalFailure(failure)).toBe(true);
  });
it.each([[null, false], [137, false], [1, true]] as const)("waits after a killed child (%s, %s)", (code, failed) => {
  expect(pairRenderFailure(code, failed)).toBe("render-interrupted");
});
it.each([[1, "render-interrupted", false], [3, "render-interrupted", false], [4, "render-failed", true], [9, "render-failed", true]] as const)(
  "ends a render that meets our own cutoff at attempt %s as %s", (attempts, failure, final) => {
    for (const code of [null, 137]) expect(pairRenderFailure(code, false, { attempts })).toBe(failure);
    expect(work.isPairFinalFailure(failure)).toBe(final);
  });
