import { useSearchParams } from "react-router";
import type { Principal } from "../../../packages/content-core/src/rbac";
import type { MediaSourceSummary } from "../lib/source-media";
import { SourceMediaLibrary } from "./SourceMediaLibrary";
import { UgcSubmissionsRoute } from "./UgcSubmissionsRoute";
import { VideoRecycleBin } from "../components/VideoRecycleBin";
import { DeferredMediaTransferGuard } from "./MediaRouteLeaveGuards";

interface ExitRiskProps {
  extraExitRisk: boolean;
  onDiscardExtra: () => void;
  onDiscardVideo: () => void;
}

type MediaSecondarySurfaceProps =
  | { kind: "submissions" }
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
    } & ExitRiskProps);

function SourceMediaRoute(props: Extract<MediaSecondarySurfaceProps, { kind: "source" }>) {
  const [params] = useSearchParams();
  if (props.source.canDelete && params.get("bin") === "1") {
    const back = new URLSearchParams(params);
    back.delete("bin");
    return <>
      <VideoRecycleBin sourceId={props.source.id} getIdToken={props.getIdToken} backSearch={back.toString()} />
      <DeferredMediaTransferGuard libraryDirty={props.extraExitRisk} videoActive={props.routedVideoActive}
        onDiscardLibrary={props.onDiscardExtra} onDiscardVideo={props.onDiscardVideo} />
    </>;
  }
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

export function MediaSecondarySurface(props: MediaSecondarySurfaceProps) {
  if (props.kind === "submissions") return <UgcSubmissionsRoute />;
  return <SourceMediaRoute {...props} />;
}
