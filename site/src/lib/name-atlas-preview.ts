import { internalSurfaceRoutesEnabled } from "./build-target";

type Env = Record<string, string | undefined>;

/** This opt-in is safe only on an Access-protected host. No public publisher
 * or frozen CMS draft may inherit the research reader, even with the opt-in. */
export function nameAtlasRoutesEnabled(env: Env = {}, frozenPreview = false): boolean {
  return internalSurfaceRoutesEnabled(env)
    && !frozenPreview
    && !["1", "true", "yes", "on"].includes((env.WORKERS_CI ?? "").trim().toLowerCase())
    && !(env.PUBLIC_BUILD_BATCH_ID ?? "").trim()
    && !(env.PUBLIC_ARTIFACT_BUNDLE_PATH ?? "").trim()
    && !(env.CMS_PREVIEW_INPUT_PATH ?? "").trim()
    && !(env.CMS_PREVIEW_INPUT_SHA256 ?? "").trim();
}

/** Scan emitted assets as well as route names: a renamed Vite chunk must not
 * quietly carry the raw reader into an otherwise public-safe build. */
export function containsNameAtlasContent(source: string): boolean {
  return source.includes(NAME_ATLAS_PAYLOAD_FINGERPRINT) || /nj-name-atlas|An Atlas of Names|atlas-municipalities|atlas-share-fallback/.test(source);
}

// Fingerprint of the frozen research payload, including data-only asset copies.
export const NAME_ATLAS_PAYLOAD_FINGERPRINT = "D77#BppuVG00cb&S|Z^xJU~ekH^VRt!!QiP^QuYC&1s`O*=*4Y*{_?wQ)C*iRb``Mo&&LT`~";
