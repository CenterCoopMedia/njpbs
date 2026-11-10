import { MemoryRouter, useLocation } from "react-router";
import { MediaTabs } from "../components/media/MediaTabs";
import { WorkspaceUploadButton } from "../components/media/WorkspaceUploadButton";
import { currentMediaTabId, mediaTabs } from "../lib/media-tabs";
import { parseMediaWorkspacePath } from "../lib/routes";

const sources = [
  { id: "video-library", label: "Videos" },
  { id: "nj-spotlight", label: "NJ Spotlight News originals" },
];

// Counts come from data already in hand; Collections never has one.
const tabs = mediaTabs({
  canUseImages: true,
  canReviewSubmissions: true,
  sources,
  counts: { images: 1204, "video-library": 412, "nj-spotlight": 86, voiceovers: 196, favorites: 38 },
});

function Strip() {
  const location = useLocation();
  const currentId = currentMediaTabId(parseMediaWorkspacePath(location.pathname), sources);
  return <div className="media-workspace-bar">
    <MediaTabs currentId={currentId} tabs={tabs} />
    <WorkspaceUploadButton />
  </div>;
}

// Gallery specimen for the media workspace bar on a tab that uses the shared upload control.
// Links move within an in-memory router, so the current mark follows a click. At 320 the strip
// scrolls with an end fade, counts hide, and Upload takes the next line.
export function MediaTabsSpecimen() {
  return (
    <MemoryRouter initialEntries={["/media/favorites"]}>
      <div className="panel">
        <Strip />
      </div>
    </MemoryRouter>
  );
}
