import { useControlSize } from "../context/ControlSizingContext";
import { useControlPresentation } from "../context/ControlPresentationContext";
import { usePublicContentRoute } from "../context/PublicContentStatusContext";
import { publicSiteUrl } from "../lib/dev-origins";
import { EditorActionSlot } from "./EditorActions";
import { Icon } from "./ui/Icon";
import { buttonClassName } from "./ui/Primitives";

export function LivePostAction({ documentId }: { documentId: string }) {
  const route = usePublicContentRoute("cmsPosts", documentId);
  const size = useControlSize() ?? "legacy";
  const iconPresentation = useControlPresentation() === "icons";
  if (!route) return null;
  return (
    <EditorActionSlot group="preview">
      <a
        aria-label="View live post (opens in a new tab)"
        className={buttonClassName("ghost", size)}
        href={publicSiteUrl(route.path)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Icon name="external-link" />
        <span className={iconPresentation ? "button-compact-label" : undefined}>View live post</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </EditorActionSlot>
  );
}
