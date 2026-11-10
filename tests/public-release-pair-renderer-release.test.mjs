import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { sealPublicReleasePairRenderer, verifyPublicReleasePairRenderer } from "../site/scripts/public-release-pair-renderer-release.mjs";

it("keeps the exact canonical full seal and detects changed or nonregular graph members", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pair-graph-")), sha = "a".repeat(40);
  const members = { "client/a.js": "client", "renderer-release.json": JSON.stringify({ rendererSha: sha, environment: "development" }),
    "runtime/pair.mjs": "runtime", "runtime/nested/model.bin": "model", "server/entry.mjs": "server" };
  try {
    for (const [name, bytes] of Object.entries(members)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await writeFile(path.join(directory, name), bytes);
    }
    const expected = JSON.stringify({ schemaVersion: 1, kind: "pair-public-renderer", rendererSha: sha,
      files: Object.fromEntries(Object.entries(members).sort(([a], [b]) => a < b ? -1 : 1).map(([name, body]) =>
        [name, createHash("sha256").update(body).digest("hex")])) }) + "\n";
    const sealed = await sealPublicReleasePairRenderer(directory, sha);
    expect(await readFile(path.join(directory, "pair-renderer-release.json"), "utf8")).toBe(expected);
    const pair = { commitSha: sha, environment: "development", rendererDigest: sealed.rendererDigest };
    await expect(verifyPublicReleasePairRenderer(directory, pair)).resolves.toEqual(sealed);
    await writeFile(path.join(directory, "client/a.js"), "changed");
    await expect(verifyPublicReleasePairRenderer(directory, pair)).rejects.toThrow("seal differs");
    await symlink("a.js", path.join(directory, "client/link.js"));
    await expect(sealPublicReleasePairRenderer(directory, sha)).rejects.toThrow("non-regular");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
