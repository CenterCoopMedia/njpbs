import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import staticReturn, { type StaticPostProof } from "../../functions/lib/no-build-post-static-proof.js";
import paths from "../../functions/lib/post-background-paths.js";
import { artifactFiles, verifyPreparedPublicWorkerArtifact, type PreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";
import type { PublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
const { outputForPath } = paths;

export type { StaticPostProof } from "../../functions/lib/no-build-post-static-proof";

/** Seal every static aggregate file, all retained detail paths and both ordinary
 * receipts from this already verified complete artifact. Missing paths stay
 * authoritative absences, never an invitation to try older Assets. */
export async function prepareStaticPostProof({ input: rawInput, artifact, prepared, distDirectory }: {
  input: unknown; artifact: PublicArtifactInventoryReceipt;
  prepared: PreparedPublicWorkerArtifact; distDirectory: string;
}): Promise<StaticPostProof> {
  const input = staticReturn.projectStaticInput(rawInput);
  const family = artifact.families.find(family => family.collection === "cmsPosts" && family.complete);
  const identity = family?.artifacts.find(post => post.documentId === input.postId);
  if (!family || (input.visible
    ? identity?.sourceVersion !== input.sourceVersion || identity.canonicalPath !== `/posts/${input.slug}/` ||
      identity.aliases.some(alias => !input.ownedSlugs.some(slug => alias === `/posts/${slug}/`))
    : identity !== undefined)) throw new Error("The static artifact does not contain the admitted Post version");
  await verifyPreparedPublicWorkerArtifact({ preparedArtifact: prepared, distDirectory });
  const files = (await artifactFiles(distDirectory)).map(file => ({ ...file,
    path: `/${file.path.replace(/(^|\/)index\.html$/, "$1")}`,
  })).filter(file => (outputForPath(file.path) && outputForPath(file.path) !== "home") || input.ownedSlugs.some(slug => file.path === `/posts/${slug}/`) ||
    file.path === "/_content-status.json");
  // _publication.json is excluded from the artifact hash by its existing
  // primitive; its independently sealed publication receipt binds it instead.
  const publication = await readFile(path.join(distDirectory, "_publication.json"));
  if (publication.length > 2048 || createHash("sha256").update(publication).digest("hex") !== prepared.publicationReceiptDigest) {
    throw new Error("The static publication receipt changed");
  }
  files.push({ path: "/_publication.json", bytes: publication.length,
    digest: prepared.publicationReceiptDigest });
  const proof = staticReturn.projectStaticProof({ ...input, files });
  const statusFile = proof.files.find(file => file.path === "/_content-status.json")!;
  const bytes = await readFile(path.join(distDirectory, "_content-status.json"));
  if (bytes.length !== statusFile.bytes || createHash("sha256").update(bytes).digest("hex") !== statusFile.digest) {
    throw new Error("The static content inventory changed");
  }
  const inventory = JSON.parse(bytes.toString("utf8"));
  const contentKey = createHash("sha256").update(`cmsPosts/${input.postId}`).digest("hex");
  if (inventory?.buildBatchId !== prepared.buildBatchId || inventory.commitSha !== prepared.commitSha ||
      inventory.generation !== prepared.generation || !Array.isArray(inventory.routes) || inventory.routes.length > 10_000) {
    throw new Error("The static content inventory has no matching publication identity");
  }
  const routes = inventory.routes.filter((route: { contentKey?: string; path?: string }) =>
    route.contentKey === contentKey || input.ownedSlugs.some(slug => route.path === `/posts/${slug}/`));
  if (input.visible ? routes.length !== 1 || routes[0].path !== `/posts/${input.slug}/` ||
      routes[0].contentKey !== contentKey || routes[0].sourceVersion !== input.sourceVersion : routes.length !== 0) {
    throw new Error("The static content inventory does not prove the current Post visibility");
  }
  return proof;
}

