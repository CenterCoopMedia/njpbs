import { useCallback, useRef } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { parseMediaWorkspacePath } from "../lib/routes";
import { finishVideoUpload } from "../lib/upload-router";
import { useRegisterExitGuard } from "./ExitGuard";
import { LeaveGuardDialog } from "./LeaveGuardDialog";

export function DeferredMediaTransferGuard({
  libraryDirty,
  videoActive,
  onDiscardLibrary,
  onDiscardVideo,
}: {
  libraryDirty: boolean;
  videoActive: boolean;
  onDiscardLibrary: () => void;
  onDiscardVideo: () => void;
}) {
  const libraryDirtyRef = useRef(libraryDirty);
  const videoActiveRef = useRef(videoActive);
  libraryDirtyRef.current = libraryDirty;
  videoActiveRef.current = videoActive;
  const hasUnsavedWork = useCallback(
    () => libraryDirtyRef.current || videoActiveRef.current,
    [],
  );
  const hasRisk = libraryDirty || videoActive;
  useRegisterExitGuard(hasRisk ? { saving: false, hasUnsavedWork } : null);
  useBeforeUnload((event) => {
    if (!hasRisk) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const discardLibrary = useRef(false);
  const discardVideo = useRef(false);
  const blocker = useBlocker(({ nextLocation }) => {
    const nextRoute = parseMediaWorkspacePath(nextLocation.pathname);
    const leavesWorkspace = nextRoute.kind === "not-found";
    const opensRecycleBin = nextRoute.kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    discardLibrary.current = libraryDirty && (leavesWorkspace || opensRecycleBin);
    discardVideo.current = videoActive && leavesWorkspace;
    return discardLibrary.current || discardVideo.current;
  });
  if (blocker.state !== "blocked") return null;
  return <LeaveGuardDialog
    onConfirm={() => {
      if (discardLibrary.current) onDiscardLibrary();
      if (discardVideo.current) onDiscardVideo();
      blocker.proceed();
    }}
    onCancel={() => blocker.reset()}
  />;
}

export function RoutedVideoLeaveGuard() {
  const blocker = useBlocker(({ nextLocation }) => {
    const kind = parseMediaWorkspacePath(nextLocation.pathname).kind;
    return kind === "not-found";
  });
  useBeforeUnload((event) => {
    event.preventDefault();
    event.returnValue = "";
  });
  const hasUnsavedWork = useCallback(() => true, []);
  useRegisterExitGuard({ saving: false, hasUnsavedWork });
  if (blocker.state !== "blocked") return null;
  return <LeaveGuardDialog
    onConfirm={() => {
      finishVideoUpload();
      blocker.proceed();
    }}
    onCancel={() => blocker.reset()}
  />;
}

export function RoutedLibraryLeaveGuard({ dirty, onDiscard }: {
  dirty: boolean;
  onDiscard: () => void;
}) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const hasUnsavedWork = useCallback(() => dirtyRef.current, []);
  useRegisterExitGuard(dirty ? { saving: false, hasUnsavedWork } : null);
  const blocker = useBlocker(({ nextLocation }) => {
    const nextRoute = parseMediaWorkspacePath(nextLocation.pathname);
    const opensRecycleBin = nextRoute.kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    return dirty && (opensRecycleBin || nextRoute.kind === "not-found");
  });
  return blocker.state === "blocked" ? <LeaveGuardDialog
    onConfirm={() => { onDiscard(); blocker.proceed(); }}
    onCancel={() => blocker.reset()}
  /> : null;
}
