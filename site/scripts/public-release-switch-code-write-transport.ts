import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewStore } from "./public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { publicReleaseTerminalTransport } from "./public-release-terminal-transport";

/** Storage-only identifiers. The private Worker derives actual selected CODE,
 * original H/G and live lease from its own read-only authority transaction. */
export function publicReleaseSwitchCodeWriteStore({ pair: rawPair, operationId, lease }: {
  pair: PublicReleasePair; operationId: string; lease?: string;
}): PairViewStore {
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPrivatePairResources(pair);
  if (!/^[a-f0-9]{64}$/.test(operationId)) throw new protocol.PublicReleaseProtocolError();
  const inputPrefix = `release-pair-inputs/v2/${pair.pairId}/`,
    replayPrefix = `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/`;
  const unavailable = (): never => { throw new work.PairExecutionError("storage-unavailable"); };
  return { get: publicReleaseTerminalTransport(pair.environment).store.get,
    async put(key, bytes, options) {
      const input = key.startsWith(inputPrefix) && /^(objects|manifests)\/[a-f0-9]{64}\.json$/.test(key.slice(inputPrefix.length));
      const replay = key.startsWith(replayPrefix) && /^(pages|selections)\/[a-f0-9]{64}\.json$/.test(key.slice(replayPrefix.length));
      if ((!input && !replay) || options.onlyIf.etagDoesNotMatch !== "*" || !key.endsWith(`/${options.sha256}.json`)) unavailable();
      const headers: Record<string, string> = { "content-length": String(bytes.byteLength), "if-none-match": "*",
        "x-owner-operation": operationId, "x-owner-kind": "switch-code", "x-pair-metadata": JSON.stringify(options.customMetadata) };
      if (input) {
        if (!/^[a-f0-9-]{36}$/.test(lease ?? "")) unavailable();
        headers["x-switch-code-lease"] = lease!;
      }
      let response: Response;
      try { response = await fetch(`http://pair-owner-write.internal/${key}`, { method: "PUT", headers,
        body: bytes as BodyInit, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
      catch { return unavailable(); }
      await response.body?.cancel().catch(() => {});
      if (![201, 412].includes(response.status)) unavailable();
    } };
}
