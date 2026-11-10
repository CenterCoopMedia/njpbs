import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewStore } from "./public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { publicReleaseTerminalTransport } from "./public-release-terminal-transport";

/** One original operation and one container's own pair. The Worker rechecks
 * real admission/lease or completed target evidence; these arguments grant no
 * write authority. G writes continue using the original claim transport. */
export function publicReleaseOwnerWriteStore({ pair: rawPair, operationId, recoveryLease }: {
  pair: PublicReleasePair; operationId: string; recoveryLease?: string;
}): PairViewStore {
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPrivatePairResources(pair);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) throw new protocol.PublicReleaseProtocolError();
  const inputPrefix = `release-pair-inputs/v2/${pair.pairId}/`,
    replayPrefix = `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/`;
  const unavailable = (): never => { throw new work.PairExecutionError("storage-unavailable"); };
  return {
    get: publicReleaseTerminalTransport(pair.environment).store.get,
    async put(key, bytes, options) {
      const input = key.startsWith(inputPrefix) && /^(objects|manifests)\/[a-f0-9]{64}\.json$/.test(key.slice(inputPrefix.length));
      const replay = key.startsWith(replayPrefix) && /^(pages|selections)\/[a-f0-9]{64}\.json$/.test(key.slice(replayPrefix.length));
      if ((!input && !replay) || options.onlyIf.etagDoesNotMatch !== "*" || !key.endsWith(`/${options.sha256}.json`)) unavailable();
      const headers: Record<string, string> = { "content-length": String(bytes.byteLength), "if-none-match": "*",
        "x-owner-operation": operationId, "x-pair-metadata": JSON.stringify(options.customMetadata) };
      if (input) {
        // The actual reserve owner supplies its own token. Never read and
        // adopt a newer attempt's lease; the Worker checks current ownership.
        if (!/^[a-f0-9-]{36}$/.test(recoveryLease ?? "")) unavailable();
        headers["x-original-recovery-lease"] = recoveryLease!;
      }
      let response: Response;
      try { response = await fetch(`http://pair-owner-write.internal/${key}`, { method: "PUT", headers,
        body: bytes as BodyInit, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
      catch { return unavailable(); }
      await response.body?.cancel().catch(() => {});
      if (![201, 412].includes(response.status)) unavailable();
    },
  };
}
