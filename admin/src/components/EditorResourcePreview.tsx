import type { AdminBlock } from "../lib/block-factory";
import { useVideoRightsWarnings, VIDEO_MISSING_WARNING, VIDEO_RIGHTS_UNCHECKED_WARNING } from "../lib/video-rights";
import { useOptionalShell } from "../routes/ShellContext";
import { Button } from "./ui/Primitives";
import { Icon } from "./ui/Icon";
import { useVideoRightsReview } from "./useVideoRightsReview";

const sourceNames: Record<string, string> = {
  spotlight_news: "NJ Spotlight News", pbs_featured: "Featured programs", pbs_more: "More programs",
  station_posts: "NJ PBS posts", pbs_programs: "PBS programs",
};

/** A bounded layout illustration describes configuration without inventing feed results. */
export function SectionSourcePreview({ block }: { block: AdminBlock }) {
  const data = block.data;
  if (block.type === "content_shelf") return <div className="editor-source-summary">
    <p>{sourceNames[String(data.source)] ?? String(data.source ?? "Source not set")} · Up to {String(data.itemLimit ?? "—")} items</p>
    <div className="editor-source-layout" aria-hidden="true">{[0, 1, 2].map(index => <div key={index} className="editor-source-skeleton">
      <span><Icon name="image" /></span><div><i /><i /><i /></div>
    </div>)}</div>
    <p className="editor-source-note"><Icon name="link" />Source configuration<span>Layout illustration</span></p>
  </div>;
  if (block.type === "home_newscast") return <div className="editor-resource-summary">
    <span className="editor-resource-symbol"><Icon name="microphone" /></span>
    <div><strong>NJ PBS News with Rob Nelson</strong><small>Program feed · Source content is checked separately</small></div>
  </div>;
  if (block.type === "embed") return <div className="editor-resource-summary">
    <span className="editor-resource-symbol"><Icon name="play" /></span>
    <div><strong>{String(data.caption || "Embedded media")}</strong><small className="editor-resource-url">{String(data.url || "URL not set")}</small></div>
  </div>;
  return <div className="editor-resource-summary">
    <span className="editor-resource-symbol"><Icon name="mail" /></span>
    <div><strong>{String(data.actionLabel || data.heading || "Newsletter signup")}</strong>
      <small>{Array.isArray(data.newsletterIds) ? data.newsletterIds.length ? `${data.newsletterIds.length} saved newsletter selections` : "Standard newsletter band" : data.newsletterIds == null ? "Standard newsletter band" : "Saved newsletter selection needs review"}</small></div>
  </div>;
}

/** The advisory comes from the existing library check, never from a dismissible UI flag. */
export function VideoResourcePreview({ block, onInspect, onMediaPickerDirtyChange }: {
  block: AdminBlock; onInspect?: () => void; onMediaPickerDirtyChange?: (dirty: boolean) => void;
}) {
  const getIdToken = useOptionalShell()?.getIdToken;
  const assetId = typeof block.data.assetId === "string" ? block.data.assetId : "";
  const rights = useVideoRightsReview(assetId, onMediaPickerDirtyChange);
  const warnings = useVideoRightsWarnings(assetId ? [assetId] : []);
  const warning = warnings[0]?.message ?? (!getIdToken && assetId ? VIDEO_RIGHTS_UNCHECKED_WARNING : null);
  return <>
    <div className="editor-resource-summary editor-video-resource">
      <span className="editor-resource-symbol"><Icon name="play" /></span>
      <div><strong>{String(block.data.title || "Choose a video")}</strong><small>Uploaded video · Source details are checked separately</small></div>
    </div>
    {warning ? <div className="editor-resource-warning" role="status"><span><Icon name="flag" />{warning}</span>
      <Button size="compact" variant="ghost" onClick={warning === VIDEO_MISSING_WARNING && onInspect ? onInspect : rights.open}>Review<Icon name="chevron-right" /></Button>
    </div> : null}
    {rights.dialog}
  </>;
}
