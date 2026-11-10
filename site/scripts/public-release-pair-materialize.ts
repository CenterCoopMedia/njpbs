import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Keep every verified H file, including unused entries, behind the sandbox
 * barrier. Drain a failed batch before cleanup; never start the next batch. */
export async function materializePublicReleasePairInput({ files, directory, read, checkpoint, signal }: {
  files: readonly { name: string }[]; directory: string; read(name: string): Promise<Uint8Array>;
  checkpoint(): Promise<unknown>; signal: AbortSignal;
}) {
  for (let offset = 0; offset < files.length; offset += 4) {
    signal.throwIfAborted();
    const results = await Promise.allSettled(files.slice(offset, offset + 4).map(async file => {
      signal.throwIfAborted();
      const bytes = await read(file.name);
      signal.throwIfAborted();
      const destination = path.join(directory, file.name);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
      await checkpoint();
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}
