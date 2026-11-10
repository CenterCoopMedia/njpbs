import { useCallback, useState } from "react";
import {
  DEFAULT_MEDIA_DISPLAY,
  DEFAULT_VIDEO_MEDIA_DISPLAY,
  readMediaDisplay,
  resetMediaDisplay,
  writeMediaDisplay,
  type MediaDisplayPreferencesFor,
  type MediaDisplaySurface,
} from "./media-display";

// The images tab's display preferences as React state.
// Storage is read once on mount and written on each change; the URL is never involved.

function browserStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaults<Surface extends MediaDisplaySurface>(surface: Surface): MediaDisplayPreferencesFor<Surface> {
  const value = surface === "video" ? DEFAULT_VIDEO_MEDIA_DISPLAY : DEFAULT_MEDIA_DISPLAY;
  return { ...value, fields: { ...value.fields } } as MediaDisplayPreferencesFor<Surface>;
}

export function useMediaDisplay<Surface extends MediaDisplaySurface = "images">(
  surface: Surface = "images" as Surface,
) {
  const [display, setState] = useState<MediaDisplayPreferencesFor<Surface>>(
    () => readMediaDisplay(surface, browserStore()),
  );

  const setDisplay = useCallback((next: MediaDisplayPreferencesFor<Surface>) => {
    setState(next);
    writeMediaDisplay(surface, browserStore(), next);
  }, [surface]);

  const resetDisplay = useCallback(() => {
    setState(defaults(surface));
    resetMediaDisplay(surface, browserStore());
  }, [surface]);

  return { display, setDisplay, resetDisplay };
}
