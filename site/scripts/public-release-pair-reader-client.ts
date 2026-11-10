import { randomBytes } from "node:crypto";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { PAIR_READER_PATH, PAIR_READER_REPLY_LIMIT, parseReaderSeals, parseReaderRequest, parseReaderReply,
  readBoundedBody, readerRefused, withinReaderDeadline, PAIR_READER_DEADLINE_MS,
  type ReaderNamespaceAbsence, type ReaderSeals } from "./public-release-pair-reader-contract";

/** Always crosses the deployed HTTP transport. There is deliberately no
 * injectable decision function or in-process fallback. Credentials are fetched
 * at use and never included in an error, receipt or log. Unavailable or
 * incompatible readers refuse. */
export function createPrivatePairReaderClient({ pair: rawPair, seals: rawSeals, credentials }: {
  pair: PublicReleasePair; seals: ReaderSeals; credentials: () => Promise<HeadersInit>;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  work.assertPrivatePairResources(pair);
  const seals = parseReaderSeals(rawSeals, pair);
  return async ({ identity, claimDigest, manifestDigest, manifestBytes, paths, absence = null, signal: callerSignal }: {
    identity: PairTaskIdentity; claimDigest: string; manifestDigest: string; manifestBytes: number;
    paths: readonly string[]; absence?: ReaderNamespaceAbsence | null; signal?: AbortSignal;
  }) => {
    const request = parseReaderRequest({ schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), identity,
      claimDigest, manifestDigest, manifestBytes, nonce: randomBytes(32).toString("hex"), paths, absence }, pair);
    const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(PAIR_READER_DEADLINE_MS)]);
    let response: Response | undefined;
    try {
      return await withinReaderDeadline(signal, async () => {
      signal.throwIfAborted();
      const headers = new Headers(await credentials());
      signal.throwIfAborted();
      headers.set("content-type", "application/json");
      headers.set("cache-control", "no-store");
      // Native fetch computes the wire length from these exact bytes. A manual
      // content-length can be rejected by undici before the request is sent.
      const encoded = new TextEncoder().encode(JSON.stringify(request));
      response = await fetch(`${seals.deployment.origin}${PAIR_READER_PATH}`, {
        method: "POST", headers, body: encoded, redirect: "manual", cache: "no-store", signal,
      });
      if (response.status !== 200 || response.headers.get("content-type") !== "application/json" ||
          response.headers.get("cache-control") !== "private, no-store") readerRefused();
      const bytes = await readBoundedBody(response.body, PAIR_READER_REPLY_LIMIT, signal);
      const reply = parseReaderReply(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), pair, request);
      signal.throwIfAborted();
      return reply;
      });
    } catch { readerRefused(); }
    finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
  };
}
