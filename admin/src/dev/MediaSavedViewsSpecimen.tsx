import { useRef, useState } from "react";
import { MediaDisplayPopover } from "../components/media/MediaDisplayPopover";
import { MediaFilterPopover } from "../components/media/MediaFilterPopover";
import { Button } from "../components/ui/Primitives";
import type { SavedMediaViewsController } from "../lib/use-saved-media-views";
import type { SavedMediaView } from "../lib/saved-media-views";

const EXAMPLE_VIEWS: SavedMediaView[] = [
  { id: "recent-news", name: "Recent news images", surface: "images", query: "category=news" },
  { id: "approved-art", name: "Approved artwork", surface: "images", query: "category=art&sort=name" },
];

type Mode = "loaded" | "empty" | "save" | "validation";

/** Deterministic personal-view states. The real profile store is never loaded. */
export function MediaSavedViewsSpecimen() {
  const [mode, setMode] = useState<Mode>("loaded");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const filterAnchor = useRef<HTMLButtonElement>(null);
  const displayAnchor = useRef<HTMLButtonElement>(null);
  const [views, setViews] = useState(EXAMPLE_VIEWS);
  const filterOpen = mode === "loaded" || mode === "empty";
  const controller: SavedMediaViewsController = {
    status: "ready",
    views: mode === "empty" ? [] : views,
    currentViewId: "recent-news",
    error,
    busy: false,
    load: async () => undefined,
    apply: (view) => setNotice(`${view.name} opened`),
    save: async (name) => {
      if (mode === "validation" || views.some((view) => view.name.toLowerCase() === name.trim().toLowerCase())) {
        setError("A saved view named “Recent news images” already exists.");
        return false;
      }
      setViews((current) => [...current, {
        id: "new-view", name: name.trim(), surface: "images", query: "category=news&kind=image",
      }]);
      setError(null);
      setNotice(`${name.trim()} saved`);
      return true;
    },
    remove: async (id) => {
      setViews((current) => current.filter((view) => view.id !== id));
      setNotice("View deleted");
      return true;
    },
    resetFilters: () => setNotice("Filters reset"),
  };

  const changeMode = (next: Mode) => {
    setError(null);
    setMode(next);
  };

  return (
    <section aria-label="Personal saved views" className="panel">
      <div className="button-row" role="group" aria-label="Saved view specimen states">
        <Button onClick={() => changeMode("loaded")} variant={mode === "loaded" ? "primary" : "secondary"}>Loaded</Button>
        <Button onClick={() => changeMode("empty")} variant={mode === "empty" ? "primary" : "secondary"}>Empty</Button>
        <Button onClick={() => changeMode("save")} variant={mode === "save" ? "primary" : "secondary"}>Save</Button>
        <Button onClick={() => changeMode("validation")} variant={mode === "validation" ? "primary" : "secondary"}>Validation</Button>
      </div>
      <div className="button-row">
        <Button ref={filterAnchor} onClick={() => changeMode("loaded")} variant="secondary">Filter</Button>
        <Button ref={displayAnchor} onClick={() => changeMode("save")} variant="secondary">Display</Button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      <MediaFilterPopover
        anchorRef={filterAnchor}
        onOpenChange={() => undefined}
        onSelect={() => undefined}
        open={filterOpen}
        properties={[{ id: "kind", label: "Type", picker: "options", options: [
          { value: "image", label: "Images" }, { value: "document", label: "Documents" },
        ] }]}
        savedViews={controller}
      />
      <MediaDisplayPopover
        anchorRef={displayAnchor}
        configuration={{ rows: [], onReset: () => setNotice("Display reset") }}
        onOpenChange={() => undefined}
        open={!filterOpen}
        savedViewDisplayAvailable
        savedViews={controller}
      />
    </section>
  );
}
