import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { archiveItemRef } from "../stage-wordpress-archive.mjs";

export const HEX_DIGEST = /^[a-f0-9]{64}$/;
export const SOURCE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const POST_ID = /^[1-9][0-9]{0,19}$/;
export const matches = (value, pattern) => typeof value === "string" && pattern.test(value);

export async function readRegularFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > limit) return null;
    const chunks = [];
    let length = 0;
    for await (const chunk of file.createReadStream({ start: 0, end: limit, autoClose: false })) {
      chunks.push(chunk);
      length += chunk.length;
    }
    return length <= limit && length === stat.size ? Buffer.concat(chunks, length) : null;
  } finally {
    await file.close();
  }
}

export function matchesStagingReceipt(staged, receipt, sourceRef, kind) {
  return staged?.kind === kind && staged.record?.kind === kind &&
    staged.formatVersion === 1 && Number.isSafeInteger(staged.version) && staged.version >= 1 &&
    staged.record.lifecycle === "staged" && staged.record.postId === sourceRef.postId &&
    matches(staged.record.revision?.sha256, HEX_DIGEST) &&
    isDeepStrictEqual(staged.sourceRef, sourceRef) && isDeepStrictEqual(receipt?.sourceRef, sourceRef) &&
    receipt.kind === kind && receipt.action === "create" &&
    isDeepStrictEqual(receipt.revision, staged.record.revision);
}

export async function attachmentProblem({ firestore, reader, staged, receipt, sourceRef, revisionSha256 }) {
  if (!staged) return "missing-staged-attachment";
  if (!matchesStagingReceipt(staged, receipt, sourceRef, "attachment")) return "invalid-staged-attachment";
  if (staged.record.revision.sha256 !== revisionSha256) return "source-revision-conflict";
  const { sourceStatus, parentPostId } = staged.record;
  if (sourceStatus === "publish") return null;
  if (sourceStatus !== "inherit") return "nonpublic-source";
  if (!matches(parentPostId, POST_ID)) return "unverified-parent";
  const parentSource = { source: sourceRef.source, postId: parentPostId };
  const ref = archiveItemRef(firestore, parentSource.source, parentSource.postId);
  const [parent, accepted] = await reader.getAll(ref, ref.collection("archiveImportReceipts").doc("staged"));
  const story = parent.data();
  if (!matchesStagingReceipt(story, accepted.data(), parentSource, "story")) return "unverified-parent";
  return story.record.sourceStatus === "publish" ? null : "nonpublic-source";
}
