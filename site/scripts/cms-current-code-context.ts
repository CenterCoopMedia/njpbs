import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { assertContextMatchesPublication } from "../src/lib/retained-public-context";
import type { PublicationTarget } from "../../functions/lib/publication-target";
import type { CurrentCodeReference } from "../../functions/lib/current-public-code-source";
const require = createRequire(import.meta.url);
const { assertPublicationTarget, assertPublicationDatabase } = require("../../functions/lib/publication-target.js");
const { createCurrentCodeTransport } = require("../../functions/lib/current-public-code-source.js") as {
  createCurrentCodeTransport(options: { target: PublicationTarget; rendererSha: string; request?: typeof fetch; readSecret?: () => string }): {
    readCurrentCode(): Promise<{ reference: CurrentCodeReference; bytes: Buffer }>;
    readCurrentCodeReference(): Promise<CurrentCodeReference> } };

/** Private historical retention preserves the ordinary qualified DTO exactly.
 * The internal art catalog is separately retained from the same verified wire;
 * legacy normalization intentionally removes it from that DTO. */
export function qualifyHistoricalCodeContext(qualified: { reference: CurrentCodeReference; bytes: Buffer }) {
  if (qualified.bytes.length !== qualified.reference.manifest.byteLength ||
      createHash("sha256").update(qualified.bytes).digest("hex") !== qualified.reference.manifest.sha256) {
    throw new Error("Qualified current CODE bytes differ");
  }
  const original = JSON.parse(qualified.bytes.toString("utf8"));
  const publicContext = assertContextMatchesPublication(original, qualified.reference.publication);
  return { publicContext, publication: qualified.reference.publication, reference: qualified.reference,
    ...(original.programImageDescriptors ? { originalProgramImageCatalog: original.programImageDescriptors } : {}) };
}

/** Equivalent to the code-mode cloud storage reader's qualified DTO boundary.
 * The private Worker probes actual CODE before/after its fixed object read.
 * This Node boundary applies the existing full context/publication validator.
 * The caller must repeat this read after packet IO and pin its local authority;
 * neither the packet operation nor a stored family supplies current CODE. */
export function createCurrentCodeContextReader({ target, rendererSha, firestore, request, readSecret }: {
  target: PublicationTarget; rendererSha: string; firestore: { projectId: string };
  request?: typeof fetch; readSecret?: () => string;
}) {
  target = assertPublicationTarget(target); assertPublicationDatabase(firestore, target);
  const transport = createCurrentCodeTransport({ target, rendererSha, request, readSecret });
  return { readCurrentCodeReference: () => transport.readCurrentCodeReference(),
    async readHistoricalCodeContext() { return qualifyHistoricalCodeContext(await transport.readCurrentCode()); }, async readCurrentCodeContext() {
    const qualified = await transport.readCurrentCode();
    if (createHash("sha256").update(qualified.bytes).digest("hex") !== qualified.reference.manifest.sha256) {
      throw new Error("Qualified current CODE bytes differ");
    }
    const publicContext = assertContextMatchesPublication(JSON.parse(qualified.bytes.toString("utf8")), qualified.reference.publication);
    return { publicContext, publication: qualified.reference.publication, reference: qualified.reference };
  } };
}
