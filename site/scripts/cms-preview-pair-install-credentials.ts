import { parseCmsPublicationFirebaseServiceAccount } from "./cms-publication-credentials";
import { parsePreviewStorageCredential } from "./cms-preview-storage-credential";

/** Explicit private preview identity, never the broader deploy/publisher key. */
export function parsePreviewPairInstallAccount(raw: string, projectId: "njpbs-site" | "njpbs-site-dev") {
  const account = parseCmsPublicationFirebaseServiceAccount(raw, projectId);
  const expected = projectId === "njpbs-site-dev" ? "cms-dev-preview-renderer@njpbs-site-dev.iam.gserviceaccount.com"
    : "cms-preview-renderer@njpbs-site.iam.gserviceaccount.com";
  if (account.clientEmail !== expected) throw new Error("Private preview service identity refused");
  return account;
}
/** Validation is an upload precondition, before the durable version grant. */
export function assertPreviewPairUploadSecrets({ rawStorage, edgeSecret, developmentAccess }: {
  rawStorage: string; edgeSecret: string; developmentAccess?: { clientId: string; clientSecret: string };
}) {
  parsePreviewStorageCredential(rawStorage);
  if (typeof edgeSecret !== "string" || edgeSecret.length < 32 || /[\r\n]/.test(edgeSecret)) throw new Error("Private preview edge credential refused");
  if (developmentAccess && (!developmentAccess.clientId || !developmentAccess.clientSecret ||
      /[\r\n]/.test(developmentAccess.clientId + developmentAccess.clientSecret))) throw new Error("Private preview Access credentials refused");
}
