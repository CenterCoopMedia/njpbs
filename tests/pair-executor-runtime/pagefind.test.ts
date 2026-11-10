import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installPublicReleasePairPagefindEngine, restorePublicReleasePairPagefindEngine, PAIR_PAGEFIND_ENGINE_DIRECTORY } from "../../site/scripts/public-release-pair-pagefind-engine";
import { buildPublicReleasePairPagefind } from "../../site/scripts/public-release-pair-pagefind";
import { decodePagefindFragment } from "../../site/src/lib/pagefind-index";
let directory: string, executable: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "pair-pagefind-")); executable = path.join(directory, "native");
  const engine = await installPublicReleasePairPagefindEngine(directory);
  expect(engine.version).toBe("1.5.0"); expect(engine.chunks.every(chunk => chunk.bytes <= 8 * 1024 * 1024)).toBe(true);
  expect(await restorePublicReleasePairPagefindEngine(directory, executable)).toEqual(engine);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
it("uses the real pinned engine over new HTML and excludes noindex/untagged private material", async () => {
  async function* html() {
    yield { path: "/posts/new/", bytes: new TextEncoder().encode('<html lang="en"><head><title>New owner</title></head><body><main data-pagefind-body>Current accepted publication</main></body></html>') };
    yield { path: "/retired/", bytes: new TextEncoder().encode('<html lang="en"><head><meta name="robots" content="noindex"></head><body data-pagefind-body>Withdrawn owner</body></html>') };
    yield { path: "/wiki/private.html", bytes: new TextEncoder().encode('<html lang="en"><body>Private untagged wiki</body></html>') };
  }
  const output = await buildPublicReleasePairPagefind(html(), executable);
  const fragments = output.files.filter(file => file.path.endsWith(".pf_fragment")).map(file => decodePagefindFragment(file.bytes));
  expect(fragments).toEqual([expect.objectContaining({ url: "/posts/new/", content: expect.stringContaining("Current accepted publication") })]);
  expect(output.metrics.htmlCount).toBe(3); expect(output.metrics.indexedCount).toBe(1);
});
it("refuses an altered sealed native chunk before creating an executable", async () => {
  const chunk = path.join(directory, PAIR_PAGEFIND_ENGINE_DIRECTORY, "0000.bin"), original = await readFile(chunk);
  try {
    await writeFile(chunk, "corrupt");
    const target = path.join(directory, "refused");
    await expect(restorePublicReleasePairPagefindEngine(directory, target)).rejects.toThrow();
    expect(await stat(target).catch(() => null)).toBe(null);
  } finally { await writeFile(chunk, original); }
});
