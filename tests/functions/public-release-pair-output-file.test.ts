import { mkdtemp, writeFile, symlink, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readPublicReleasePairOutputFile } from "../../site/scripts/public-release-pair-output-file";

const faults = vi.hoisted(() => ({ open: null as Error | null }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => faults.open ? Promise.reject(faults.open) : actual.open(...args) };
});
let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
async function file() { directory = await mkdtemp(path.join(os.tmpdir(), "pair-output-test-")); return path.join(directory, "output"); }
it("reads regular redirect and empty body files within their exact bound", async () => {
  const name = await file();
  await writeFile(name, "/owned/");
  expect(new TextDecoder().decode(await readPublicReleasePairOutputFile(name, 7))).toBe("/owned/");
  await writeFile(name, "");
  expect(await readPublicReleasePairOutputFile(name, 0)).toEqual(new Uint8Array());
});
it.each(["symlink", "directory", "oversized", "missing"])("refuses a child-written %s before following or buffering it", async kind => {
  const name = await file();
  if (kind === "symlink") { const outside = path.join(directory!, "parent-file"); await writeFile(outside, "/parent-only/"); await symlink(outside, name); }
  if (kind === "directory") await mkdir(name);
  if (kind === "oversized") await writeFile(name, "x".repeat(1025));
  await expect(readPublicReleasePairOutputFile(name, 1024)).rejects.toMatchObject({ code: "byte-mismatch" });
});
it.skipIf(process.platform !== "linux")("refuses a FIFO without blocking on a writer", async () => {
  const name = await file();
  execFileSync("mkfifo", [name]);
  await expect(readPublicReleasePairOutputFile(name, 1024)).rejects.toMatchObject({ code: "byte-mismatch" });
});
it.each(["EMFILE", "ENFILE", "ENOMEM"])("keeps a read that failed with %s retryable", async code => {
  const name = await file();
  await writeFile(name, "/owned/");
  faults.open = Object.assign(new Error(code), { code });
  try { await expect(readPublicReleasePairOutputFile(name, 7)).rejects.toMatchObject({ code: "storage-unavailable" }); }
  finally { faults.open = null; }
});
