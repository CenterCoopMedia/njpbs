import { createSourceMediaRead, type SourceMediaAssetSummary, type SourceMediaRead } from "./source-media";
import { SOURCE_MEDIA_FILE_CHANGED_EVENT } from "./use-source-media-asset-refresh";

export class SourceMediaFileChangedError extends Error {
  constructor() {
    super("This video's file changed. Its details are being refreshed. Save or discard any unsaved edits before trying again.");
  }
}

export async function createVersionedSourceMediaRead(token: string, asset: SourceMediaAssetSummary, action: SourceMediaRead["action"]) {
  const access = await createSourceMediaRead(token, asset.sourceId, asset.id, action);
  if (asset.fileVersion && access.fileVersion && access.fileVersion !== asset.fileVersion) {
    window.dispatchEvent(new CustomEvent(SOURCE_MEDIA_FILE_CHANGED_EVENT, { detail: { sourceId: asset.sourceId, assetId: asset.id } }));
    throw new SourceMediaFileChangedError();
  }
  return access;
}

export function canPlayInBrowser(asset: SourceMediaAssetSummary) {
  return asset.viewingCopy?.state === "ready" || asset.preview === "browser";
}
