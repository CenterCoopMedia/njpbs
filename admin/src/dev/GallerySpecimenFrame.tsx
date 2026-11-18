import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// The gallery loads these stylesheets on the document. Specimens in shadow roots
// also need the class rules in their own trees. The CSS variables inherit from the document.
import stylesText from "../styles.css?inline";
import mediaRouteStylesText from "../routes/MediaRoute.css?inline";
import contentScanFlowStylesText from "../content-scan-flow.css?inline";
import workspaceStylesText from "../cms-workspace.css?inline";
import dropOverlayStylesText from "../components/media/DropOverlay.css?inline";
import uploadSheetStylesText from "../components/media/UploadSheet.css?inline";
import uploadTrayStylesText from "../components/media/UploadTray.css?inline";

export interface Shot {
  id: string;
  title: string;
  note: string;
  width?: number;
  isolateDocument?: boolean;
  render: () => ReactNode;
}

// A default specimen renders into its own shadow root, so its DOM ids and the
// aria-labelledby / aria-controls targets they resolve are scoped to that one specimen. A
// sized specimen instead renders this page again in iframe embed mode. That gives it both a
// separate id namespace and a real viewport, so the unchanged production media queries run
// at the proof width. A state-isolated specimen uses the same child-document path without a
// fixed-width claim; this keeps fixture-only navigation state out of the gallery document.
// On the all-states view several EditorWorkspace specimens share the page, each carrying the
// same fixed ids (page-title, and block-<id> from the shared seed); in one document those
// collide, and a label reference in a later specimen can resolve into the first. These
// isolated trees make an accessibility audit see the admin's real wiring rather than a
// gallery artifact (#596).
//
// The children are portaled into the shadow root rather than rendered as light-DOM siblings,
// so they stay part of this one React tree: state, context, and the specimen's own effects
// behave exactly as they do in the real admin.
export function ShadowScope({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A host can only hold one shadow root; reuse it if a prior mount (React StrictMode's
    // double-invoke in dev) already attached one.
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // The admin class rules, plus the document-body base the specimen would otherwise inherit
    // from `body` -- which does not exist inside a shadow tree. The token values come from the
    // document root by inheritance.
    style.textContent = `${stylesText}\n${mediaRouteStylesText}\n${contentScanFlowStylesText}\n${workspaceStylesText}\n${dropOverlayStylesText}\n${uploadSheetStylesText}\n${uploadTrayStylesText}\n.gx-specimen{--studio-control-height:var(--target-comfortable);--studio-icon-control:var(--target-comfortable);color:var(--color-ink);font-family:var(--font-sans);font-size:var(--font-size-base);line-height:var(--line-height-copy);}`;
    shadow.appendChild(style);
    const container = document.createElement("div");
    container.className = "gx-specimen";
    shadow.appendChild(container);
    setMount(container);
    return () => {
      style.remove();
      container.remove();
      setMount(null);
    };
  }, []);

  return (
    <div className="gx-host" ref={hostRef}>
      {mount ? createPortal(children, mount) : null}
    </div>
  );
}

function embeddedShotUrl(id: string): string {
  const search = new URLSearchParams({ embed: id });
  return `${window.location.pathname}?${search.toString()}`;
}

export function EmbeddedSpecimen({ shot }: { shot: Shot }) {
  const width = shot.width;
  const title = width
    ? `${shot.title} — ${width}px responsive viewport`
    : `${shot.title} — isolated document`;
  return (
    <iframe
      className="gx-embedded-specimen"
      data-gallery-isolated="true"
      data-gallery-viewport-width={width}
      height="720"
      loading="eager"
      src={embeddedShotUrl(shot.id)}
      style={{ width: width ? `${width}px` : "100%" }}
      title={title}
      width={width}
    />
  );
}
