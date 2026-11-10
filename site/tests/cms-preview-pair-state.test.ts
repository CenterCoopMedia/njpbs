import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { preparePreviewPairStateDirectory } from "../scripts/cms-preview-pair-state";
it("creates each pair's private state directory before jobs use it and preserves it on restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "preview-pair-state-"));
  try {
    const first = await preparePreviewPairStateDirectory(root, "preview-old");
    expect((await lstat(first)).mode & 0o777).toBe(0o700);
    expect(await preparePreviewPairStateDirectory(root, "preview-old")).toBe(first);
    expect(await preparePreviewPairStateDirectory(root, "preview-new")).not.toBe(first);
    await chmod(first, 0o755);
    await expect(preparePreviewPairStateDirectory(root, "preview-old")).rejects.toThrow("owner-only");
    await symlink(first, path.join(root, "preview-link"));
    await expect(preparePreviewPairStateDirectory(root, "preview-link")).rejects.toThrow("owner-only");
    await expect(preparePreviewPairStateDirectory(root, "../source")).rejects.toThrow("Invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});
