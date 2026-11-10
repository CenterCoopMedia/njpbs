import { openPublicReleasePairViewMetadata } from "./public-release-pair-view-storage";

/** Reads only: settle a bounded batch, then expose values/errors in source order.
 * The caller remains sequential and owns every authority check and write. */
export async function* readReplayProofBatch<T, R>(items: readonly T[], read: (item: T) => Promise<R>) {
  for (let offset = 0; offset < items.length; offset += 4) {
    const settled = await Promise.allSettled(items.slice(offset, offset + 4).map(item => Promise.resolve().then(() => read(item))));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      yield result.value;
    }
  }
}

/** Fully verified G bytes in manifest order. Flush at each page boundary so a
 * later page failure cannot hide an earlier body or consumer proof failure. */
export async function* readPublicReleasePairReplayProofView(options: Parameters<typeof openPublicReleasePairViewMetadata>[0]) {
  const opened = await openPublicReleasePairViewMetadata(options);
  type Row = Awaited<ReturnType<typeof opened.output>> & {};
  let pending: Row[] = [], page = 0;
  // Preserve the complete reader's one small consecutive-blob reuse. Sharing
  // in-flight bytes is bounded by the same four reads; consumers get copies.
  let recent: { key: string; bytes: number; body: Promise<Uint8Array> } | undefined;
  const read = (row: Row) => {
    const body = recent?.key === row.objectKey && recent.bytes === row.bytes ? recent.body :
      opened.readBody(row.path).then(output => output.body);
    recent = row.bytes <= 1024 * 1024 ? { key: row.objectKey, bytes: row.bytes, body } : undefined;
    return body.then(bytes => Object.freeze({ ...row, body: new Uint8Array(bytes) }));
  };
  for await (const row of opened.entries()) {
    pending.push(row);
    const last = row.path === opened.root.pages[page].lastPath;
    if (pending.length === 4 || last) {
      for await (const output of readReplayProofBatch(pending, read)) {
        yield output;
      }
      pending = [];
    }
    if (last) page++;
  }
}
