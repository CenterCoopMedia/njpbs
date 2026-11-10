import { useEffect, useState } from "react";
import { MediaToolbar, type MediaToolbarPopover } from "../components/media/MediaToolbar";
import type { MediaFilterProperty } from "../components/media/MediaFilterPopover";
import type { MediaListQuery } from "../lib/functions";
import { DEFAULT_MEDIA_QUERY, type MediaLocationState } from "../lib/media-query";
import { useMediaDisplay } from "../lib/use-media-display";
import { MEDIA_TOOLBAR_RESULT, mediaToolbarCategoryLabel } from "./media-toolbar-fixture";

/** Resolves once the brand fonts are in, so a popover is placed against final widths. */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    void (fonts ? fonts.ready : Promise.resolve()).then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

// The composed images toolbar over local state, with one popover opened once fonts load.
// Nothing is requested; display choices use this browser's storage like the real page.
export function MediaToolbarSpecimenFrame({
  popover,
  property,
  query,
}: {
  popover: MediaToolbarPopover;
  property?: MediaFilterProperty;
  query?: Partial<MediaListQuery>;
}) {
  const ready = useFontsReady();
  const [state, setState] = useState<MediaLocationState>({ query: { ...DEFAULT_MEDIA_QUERY, ...query }, selectedId: null });
  const { display, resetDisplay, setDisplay } = useMediaDisplay();
  return (
    <section className="panel" aria-label="Images">
      <MediaToolbar
        categoryLabel={mediaToolbarCategoryLabel}
        display={display}
        initialFilterProperty={property}
        initialPopover={ready ? popover : undefined}
        key={ready ? "ready" : "loading"}
        mayUpload
        onDisplayChange={setDisplay}
        onDisplayReset={resetDisplay}
        onSelectPage={() => {}}
        onStateChange={setState}
        onUpload={() => {}}
        result={MEDIA_TOOLBAR_RESULT}
        state={state}
      />
    </section>
  );
}
