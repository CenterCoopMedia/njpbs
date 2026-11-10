import { constants } from "node:fs";
import { open } from "node:fs/promises";
import work from "../../functions/lib/public-release-pair-work.js";

/** Read an untrusted child output through one bounded, non-following handle.
 * Nonblocking open also lets a FIFO fail the regular-file check immediately. */
export async function readPublicReleasePairOutputFile(name: string, limit: number): Promise<Uint8Array> {
  const refuse = (): never => { throw new work.PairExecutionError("byte-mismatch"); };
  try {
    const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) refuse();
      const bytes = new Uint8Array(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) refuse();
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  } catch { return refuse(); }
}
