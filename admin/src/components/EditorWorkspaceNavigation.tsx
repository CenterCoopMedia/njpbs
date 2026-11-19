import type { RecordKind } from "../../../packages/content-core/src/editor-admin";
import { Link, useInRouterContext, useLocation } from "react-router";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { PAGE_DESTINATIONS, RECORD_DESTINATIONS, pageDestination, recordDestination } from "../lib/content-nav";
import { editorBackDestination, readListOrigin } from "../lib/editor-back";
import { createRecordPath, recordListPath } from "../lib/routes";
import type { Surface } from "./EditorWorkspace";
import { Icon } from "./ui/Icon";
import { Button, EmptyState } from "./ui/Primitives";

export function labelForSurface(surface: Surface): string {
  if (surface.kind === "page-list") return "Site pages";
  if (surface.kind === "library") return "All content";
  return surface.kind === "record" || surface.kind === "record-list"
    ? recordDestination(surface.record).label
    : pageDestination(surface.pageId).label;
}

export function renderIsolatedSurfacePicker(
  surface: Surface,
  saving: boolean,
  selectIsolatedSurface: (surface: Surface) => void,
  isSameSurface: (current: Surface, value: Surface) => boolean,
) {
  return (
    <div
      className="content-surface-picker"
      aria-label="Component surface picker"
    >
      {RECORD_DESTINATIONS.map((choice) => (
        <Button
          aria-label={choice.label}
          aria-current={
            surface.kind === "record" && surface.record === choice.record
              ? "page"
              : undefined
          }
          disabled={saving}
          key={choice.record}
          onClick={() =>
            selectIsolatedSurface({
              kind: "record",
              record: choice.record,
              id: null,
            })
          }
          variant="ghost"
        >
          <Icon name="file" />
          <span>{choice.label}</span>
        </Button>
      ))}
      {PAGE_DESTINATIONS.map((choice) => {
        const value: Surface = {
          kind: "page",
          pageId: choice.pageId,
          section: choice.section,
        };
        return (
          <Button
            aria-label={choice.label}
            aria-current={
              isSameSurface(surface, value) ? "page" : undefined
            }
            disabled={saving}
            key={choice.pageId}
            onClick={() => selectIsolatedSurface(value)}
            variant="ghost"
          >
            <Icon name="content" />
            <span>{choice.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function renderUnavailableRecord(
  recordSurface: Extract<Surface, { kind: "record" }>,
  title: string,
  description: string,
  canCreate: boolean,
) {
  const label = labelForSurface(recordSurface).toLowerCase();
  return (
    <EmptyState
      title={title}
      description={description}
      action={
        <div className="button-row">
          <Link
            className="button button-secondary"
            to={recordListPath(recordSurface.record)}
          >
            Back to {label} list
          </Link>
          {canCreate ? (
            <Link
              className="button button-primary"
              to={createRecordPath(recordSurface.record)}
            >
              Create a new {label}
            </Link>
          ) : null}
        </div>
      }
    />
  );
}

/*
  The one visible way out of an open editor (#1037). It is a router Link, not a history step, so
  it rides the same navigation guard as every other exit: a leave that would drop unsaved work is
  held and confirmed by the content layout's blocker, while a move that keeps the editor mounted
  goes through with the draft intact. Where it points is decided by editorBackDestination from the
  list the editor was opened from, so a filtered library comes back filtered while a direct link,
  or a reload that carried no origin, falls back to the editor's own list.
*/
interface EditorBackLinkProps {
  surface: { kind: "record"; record: RecordKind } | { kind: "page" };
  listLabel?: string;
}

// The isolated specimen gallery renders editor surfaces outside a router to check their geometry.
// There is nowhere to navigate there, so the action is simply absent rather than throwing on a
// router hook. Every routed surface — every surface a person actually edits in — renders it.
export function EditorBackLink(props: EditorBackLinkProps) {
  const view = useEditorWorkspaceView();
  const inRouter = useInRouterContext();
  if (view?.kind) return null;
  return inRouter ? <RoutedEditorBackLink {...props} /> : null;
}

function RoutedEditorBackLink({ surface, listLabel }: EditorBackLinkProps) {
  const location = useLocation();
  const destination = editorBackDestination({
    surface,
    listLabel,
    origin: readListOrigin(location.state),
  });
  return (
    <Link className="editor-back" to={destination.to}>
      <Icon name="arrow-left" />
      {destination.label}
    </Link>
  );
}
