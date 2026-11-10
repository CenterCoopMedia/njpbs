import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  PUBLICATION_PROBE_ORIGIN,
  PUBLICATION_PROBE_PATH,
  requestPublicPublicationReceipt,
} from "./activate-public-worker-candidate.ts";
import { canonicalPublicationReceipt } from "../src/lib/public-publication-receipt.ts";
import { readRetainedPublicContext } from "../src/lib/retained-public-context.ts";

/** Reuse the publisher's real-root probe; no database or provider credential.
 * The caller freezes this result into one private preview input immediately.
 */
export async function readPreviewPublicContext(
  publisherStateDirectory: string,
  requestPublication: typeof requestPublicPublicationReceipt = requestPublicPublicationReceipt,
) {
  if (!path.isAbsolute(publisherStateDirectory)) throw new Error("Preview context requires the publisher's absolute state directory");
  const url = new URL(`${PUBLICATION_PROBE_PATH}?cms-context=code`, PUBLICATION_PROBE_ORIGIN).toString();
  const publication = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
  const queue = /^cms-([A-Za-z0-9]{20})$/.exec(publication.buildBatchId);
  if (!queue) throw new Error("The active publication has no retained serializer context");
  const file = path.join(publisherStateDirectory, "jobs", queue[1], "public-context.json");
  const publicContext = await readRetainedPublicContext(file, publication);
  const observedAfter = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
  if (!isDeepStrictEqual(publication, observedAfter)) {
    throw new Error("The public publication changed while reading preview context");
  }
  return { publicContext, publication };
}
