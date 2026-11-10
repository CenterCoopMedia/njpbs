import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import p from "../functions/lib/public-release-pair.js";
import terminal from "../functions/lib/public-release-terminal.js";
import targets from "../functions/lib/publication-target.js";

// Storage verification is outside the SDK/CAS transaction. A supersession
// can read two terminal facts; each originally fit the shared 500-read commit.
// Keep that bounded inventory separate from the replay page/view budget.
const TERMINAL_FACT_READ_LIMIT = 2 * 500;
export function ownerTerminalFactReader({ pair, read }: { pair: PublicReleasePair;
  read(path: string): Promise<Record<string, unknown> | null>;
}) {
  return async (operationId: string, admissionDigest: string) => {
    let count = 0;
    const get = async (path: string) => {
      if (++count > TERMINAL_FACT_READ_LIMIT) throw new p.PublicReleaseProtocolError();
      const value = await read(path); return { exists: value !== null, data: () => value };
    };
    return terminal.assertPairPublicationTerminalReceiptInTransaction({
      firestore: { projectId: targets.publicationTarget(pair.environment).projectId, doc: (path: string) => path },
      transaction: { get, getAll: (...paths: string[]) => Promise.all(paths.map(get)) }, operationId, admissionDigest,
    } as any);
  };
}
