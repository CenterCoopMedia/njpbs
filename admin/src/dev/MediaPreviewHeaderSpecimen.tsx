import { useState } from "react";
import { ComponentEditorDialog } from "../components/ComponentEditorDialog";
import { MediaPreviewHeaderActions } from "../components/media/MediaPreviewHeaderActions";
import { ActionControl } from "../components/ui/ActionControl";
import { Icon } from "../components/ui/Icon";
import { Menu } from "../components/ui/Menu";

export function MediaPreviewHeaderSpecimen() {
  const [favorite, setFavorite] = useState(true);
  const [section, setSection] = useState("");
  return <ComponentEditorDialog variant="media" closeLabel="Close" closeVariant="secondary" open layout="video" title="Boardwalk interview.mp4" onClose={() => {}}
    headerFacts="12:04 · 1920 × 1080 · 1.2 GB · Sep 12, 2026 · Videos · Transcript: Ready"
    headerSteps={<div className="media-preview-step">
      <ActionControl action="previous-page" label="Previous file" presentation="icons" graphic={<Icon name="chevron-left" />} />
      <span role="status">2 of 3</span>
      <ActionControl action="next-page" label="Next file" presentation="icons" graphic={<Icon name="chevron-right" />} />
    </div>}
    headerActions={<MediaPreviewHeaderActions
      downloads={<Menu label="Download" icon="download" variant="primary" items={[
        { key: "web", label: "Web copy", description: "48 MB", onSelect: () => {} },
        { key: "original", label: "Original", description: "1.2 GB", onSelect: () => {} },
      ]}>Download</Menu>}
      transcript={{ onSelect: () => setSection("Transcript"), expanded: section === "Transcript", controls: "gallery-transcript" }}
      clip={{ onSelect: () => setSection("Clip"), expanded: section === "Clip", controls: "gallery-clip" }}
      favorite={{ name: "Boardwalk interview.mp4", favorite, onToggle: () => setFavorite(!favorite) }}
      copyLink="/media/videos/video-library?asset=fixture" />}
    body={<div className="component-editor-dialog-content"><p>{section || "Video preview"}</p></div>} />;
}
