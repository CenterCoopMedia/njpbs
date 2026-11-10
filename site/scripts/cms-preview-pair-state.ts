import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

/** Pair directories are created only under the image's owner-only state root.
 * Never follow a symlink, relax existing permissions or create a source path.
 */
export async function preparePreviewPairStateDirectory(root: string, serializerId: string) {
  if (!path.isAbsolute(root) || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId)) {
    throw new Error("Invalid preview pair state identity");
  }
  async function privateDirectory(directory: string) {
    const state = await lstat(directory);
    if (!state.isDirectory() || (state.mode & 0o077) !== 0 ||
        (process.getuid && state.uid !== process.getuid())) throw new Error("Preview pair state requires owner-only directories");
  }
  await privateDirectory(root);
  const directory = path.join(root, serializerId);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await privateDirectory(directory);
  return directory;
}
