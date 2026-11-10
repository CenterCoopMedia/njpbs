import type { Principal } from "../../../packages/content-core/src/rbac";
import type { CmsUserDoc } from "../lib/principal";
import type { MediaSourceSummary } from "../lib/source-media";
import { canUseMediaLibrary } from "../lib/access";
import { useMediaCategories } from "../lib/use-media-categories";
import { MediaCollectionsLibrary } from "./MediaCollectionsLibrary";
import { MediaFavoritesLibrary } from "./MediaFavoritesLibrary";
import { SourceMediaLibrary } from "./SourceMediaLibrary";
import { UgcSubmissionsRoute } from "./UgcSubmissionsRoute";

interface ExitRiskProps {
  extraExitRisk: boolean;
  videoTransferActive: boolean;
  onDiscardExtra: () => void;
  onDiscardVideo: () => void;
}

type MediaSecondarySurfaceProps =
  | { kind: "submissions" }
  | ({
      kind: "favorites";
      principal: Principal;
      userId: string;
      getIdToken: () => Promise<string>;
    } & ExitRiskProps)
  | ({
      kind: "collections";
      collectionId: string | null;
      principal: Principal;
      userId: string;
      userDoc: CmsUserDoc | null;
      getIdToken: () => Promise<string>;
    } & ExitRiskProps)
  | ({
      kind: "source";
      principal: Principal;
      source: MediaSourceSummary;
      userId: string;
      getIdToken: () => Promise<string>;
      routedLibraryActive: boolean;
      routedRejectedFiles: readonly string[];
      routedUploadRevision: number;
      routedVideoActive: boolean;
      suppressUpload: boolean;
      hasExtraExitRisk: () => boolean;
    } & Omit<ExitRiskProps, "videoTransferActive">);

function FavoritesMediaRoute({
  principal,
  userId,
  getIdToken,
  extraExitRisk,
  videoTransferActive,
  onDiscardExtra,
  onDiscardVideo,
}: Extract<MediaSecondarySurfaceProps, { kind: "favorites" }>) {
  const { state: categoryRegistry } = useMediaCategories();
  return <MediaFavoritesLibrary
    principal={principal}
    userId={userId}
    getIdToken={getIdToken}
    extraExitRisk={extraExitRisk}
    videoTransferActive={videoTransferActive}
    onDiscardExtra={onDiscardExtra}
    onDiscardVideo={onDiscardVideo}
    categoryRegistry={categoryRegistry}
  />;
}

function CollectionsMediaRoute({
  collectionId,
  principal,
  userId,
  userDoc,
  getIdToken,
  extraExitRisk,
  videoTransferActive,
  onDiscardExtra,
  onDiscardVideo,
}: Extract<MediaSecondarySurfaceProps, { kind: "collections" }>) {
  const { state: categoryRegistry } = useMediaCategories(
    Boolean(collectionId) && canUseMediaLibrary(principal),
  );
  return <MediaCollectionsLibrary
    collectionId={collectionId}
    userId={userId}
    userDoc={userDoc}
    principal={principal}
    categories={categoryRegistry.categories}
    canBrowseImages={canUseMediaLibrary(principal)}
    getIdToken={getIdToken}
    extraExitRisk={extraExitRisk}
    videoTransferActive={videoTransferActive}
    onDiscardExtra={onDiscardExtra}
    onDiscardVideo={onDiscardVideo}
  />;
}

export function MediaSecondarySurface(props: MediaSecondarySurfaceProps) {
  if (props.kind === "submissions") return <UgcSubmissionsRoute />;
  if (props.kind === "favorites") return <FavoritesMediaRoute {...props} />;
  if (props.kind === "collections") return <CollectionsMediaRoute {...props} />;
  return <SourceMediaLibrary
    principal={props.principal}
    source={props.source}
    getIdToken={props.getIdToken}
    userId={props.userId}
    extraExitRisk={props.extraExitRisk}
    routedLibraryActive={props.routedLibraryActive}
    routedRejectedFiles={props.routedRejectedFiles}
    routedUploadRevision={props.routedUploadRevision}
    routedVideoActive={props.routedVideoActive}
    suppressUpload={props.suppressUpload}
    hasExtraExitRisk={props.hasExtraExitRisk}
    onDiscardExtra={props.onDiscardExtra}
    onDiscardVideo={props.onDiscardVideo}
  />;
}
