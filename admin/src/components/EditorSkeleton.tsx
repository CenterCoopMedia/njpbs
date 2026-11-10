import type { EditorSurface } from "../lib/routes";
import { Panel, TableFrame } from "./ui/Primitives";
import { type SkeletonCell, SkeletonBlock, SkeletonRegion, SkeletonTableRows, SkeletonText, SkeletonThumb } from "./ui/Skeleton";

// Editor-shaped skeletons. This file stays small and free of editor code, so the content
// route can show it while the editor workspace chunk downloads.

function EditorFieldsShapes() {
  return (
    <div className="editor-skeleton-fields">
      <div className="editor-field">
        <span className="editor-field-label"><SkeletonText width={64} /></span>
        <SkeletonBlock height="var(--cms-control-height)" radius="control" />
      </div>
      <div className="editor-field">
        <span className="editor-field-label"><SkeletonText width={88} /></span>
        <SkeletonBlock height={96} radius="control" />
      </div>
      <div className="editor-field">
        <span className="editor-field-label"><SkeletonText width={48} /></span>
        <SkeletonBlock className="editor-skeleton-body" radius="panel" />
      </div>
    </div>
  );
}

/** A record or page editor's fields while the saved document loads. */
export function EditorFormSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label}>
      <EditorFieldsShapes />
    </SkeletonRegion>
  );
}

function isBrowseSurface(surface: EditorSurface | null): boolean {
  return surface?.kind === "page-list" || surface?.kind === "record-list" || surface?.kind === "library";
}

/** All content and Posts load the content library; the other record lists load RecordList. */
function usesContentLibrary(surface: EditorSurface | null): boolean {
  return surface?.kind === "library" || (surface?.kind === "record-list" && surface.record === "post");
}

/** RecordList's headings for a typed record list other than Posts. */
export const RECORD_LIST_HEADINGS = ["Name", "Status", "Last updated", "Actions"];

/** Reserve the accepted visible Edit action followed by its quiet More target. */
function RowActionShapes() {
  return (
    <div className="browse-row-actions">
      <SkeletonBlock width={56} height="var(--cms-control-compact-target)" radius="control" />
      <SkeletonBlock width="var(--cms-control-compact-target)" height="var(--cms-control-compact-target)" radius="control" />
    </div>
  );
}

/**
 * A typed record list's columns: the native opening title, metadata and trailing action slot
 * use the loaded classes and compact control height. Use with rowClassName content-index-row
 * inside a record-list content-index container.
 */
export const RECORD_LIST_COLUMNS: SkeletonCell[] = [
  {
    kind: "custom",
    className: "content-title",
    content: (
      <div className="content-index-identity">
        <span className="content-index-title-static"><SkeletonText width="12rem" /></span>
      </div>
    ),
  },
  { kind: "chip" },
  { kind: "text", width: "60%" },
  { kind: "custom", className: "content-index-actions-cell", content: <RowActionShapes /> },
];

export const EVENT_RECORD_LIST_HEADINGS = ["Name", "Status", "Starts", "Last updated", "Actions"];
export const EVENT_RECORD_LIST_COLUMNS: SkeletonCell[] = [
  ...RECORD_LIST_COLUMNS.slice(0, 2), { kind: "text", width: "60%" }, ...RECORD_LIST_COLUMNS.slice(2),
];

/** RecordList's New control while the list loads, in the loaded actions row. */
export function RecordListCreateShape() {
  return (
    <div className="record-list-actions" aria-hidden="true">
      <SkeletonBlock width={128} height="var(--cms-control-height)" radius="control" />
    </div>
  );
}

/** The content library's headings after the optional Select column. */
const CONTENT_LIBRARY_HEADINGS = ["Name", "Type", "Status", "Assignment", "Last updated", "Actions"];

/**
 * The library's thumbnail, title and inline date use their loaded offsets. Commands
 * occupy a separate trailing column.
 */
function ContentNameShape() {
  return (
    <div className="content-index-identity">
      <span className="content-index-title-static">
        <SkeletonThumb size={60} aspectRatio={60 / 44} className="content-row-thumbnail" />
        {/* The title box fits its content, so the lines take fixed widths within the 19rem cell. */}
        <SkeletonText lines={2} width="13rem" lastLineWidth="8rem" />
      </span>
      <span className="content-index-date-inline">
        <SkeletonText lines={2} width="13rem" lastLineWidth="8rem" />
      </span>
    </div>
  );
}

/**
 * The content library's table (All content and Posts) with its loaded headings, row class and
 * cell classes. The library's own loading state and the editor code-load fallback both use it.
 */
export function ContentLibraryTableShapes({ withSelect, postOnly }: { withSelect: boolean; postOnly: boolean }) {
  const headings = withSelect ? ["Select", ...CONTENT_LIBRARY_HEADINGS] : CONTENT_LIBRARY_HEADINGS;
  const columns: SkeletonCell[] = [
    { kind: "custom", className: "content-title", content: <ContentNameShape /> },
    { kind: "text", width: "55%" },
    { kind: "chip" },
    { kind: "text", width: "65%" },
    { kind: "text", width: "70%", className: "content-index-date" },
    { kind: "custom", className: "content-index-actions-cell", content: <RowActionShapes /> },
  ];
  if (withSelect) {
    columns.unshift({
      kind: "custom",
      className: "content-library-select-cell",
      content: <SkeletonBlock width={18} height={18} radius="control" />,
    });
  }
  return (
    // Hidden shapes: the frame must not become a Tab stop when the table overflows.
    <TableFrame className="content-browse-frame" tabIndex={-1}>
      <table className="data-table browse-table content-browse-table">
        <thead>
          <tr>{headings.map((heading) => (
            <th scope="col" key={heading} className={heading === "Select" ? "content-library-select-cell" : heading === "Actions" ? "content-index-actions-cell" : heading === "Last updated" ? "content-index-updated" : undefined}>
              {heading === "Select" ? (
                <><span className="sr-only">Select</span><SkeletonBlock width={18} height={18} radius="control" /></>
              ) : heading === "Actions" ? <span className="sr-only">Actions</span> : heading}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          <SkeletonTableRows columns={columns} rows={8} headings={headings} rowClassName="content-index-row" />
        </tbody>
      </table>
    </TableFrame>
  );
}

/**
 * Site pages: the directory's container and table, which become two-column cards on phones.
 * The outer wrapper is the loaded directory's, so its rule that drops the inner frame border matches.
 */
function PagesDirectoryTableShapes() {
  const headings = ["Page", "Area", "Status", "Actions"];
  return (
    <div className="pages-directory content-index">
      <div className="pages-directory-list">
        <TableFrame className="content-browse-frame" tabIndex={-1}>
          <table className="data-table browse-table pages-directory-table content-browse-table">
            <thead>
              <tr>
                {headings.map((heading) => <th scope="col" key={heading}>{heading}</th>)}
              </tr>
            </thead>
            <tbody>
              <SkeletonTableRows
                columns={[{ kind: "text", width: "72%", lines: 2 }, { kind: "text", width: "55%" }, { kind: "chip", width: 88 }, { kind: "custom", className: "content-index-actions-cell", content: <RowActionShapes /> }]}
                headings={headings}
                rowClassName="content-index-row"
                rows={8}
              />
            </tbody>
          </table>
        </TableFrame>
      </div>
    </div>
  );
}

/**
 * The content studio's canvas while the editor workspace code downloads: a list surface shows a
 * table, an editor surface shows its fields. The canvas and region classes match the loaded
 * workspace, so its width and padding do not change when the code arrives.
 */
export function ContentStudioSkeleton({
  surface,
  label,
  withSelect = false,
  canCreate = false,
}: {
  surface: EditorSurface | null;
  label: string;
  /** The library shows a Select column when the user can move records to the Recycle bin. */
  withSelect?: boolean;
  /** A typed record list shows its New control when the user can create. */
  canCreate?: boolean;
}) {
  const browse = isBrowseSurface(surface);
  const eventList = surface?.kind === "record-list" && surface.record === "event";
  const recordHeadings = eventList ? EVENT_RECORD_LIST_HEADINGS : RECORD_LIST_HEADINGS;
  return (
    <SkeletonRegion label={label} className="content-studio">
      <Panel className={browse ? "editor-canvas content-browse-panel" : "editor-canvas"}>
        <div
          className={
            browse
              ? "editor-form-region editor-form-region-wide content-browse-region"
              : "editor-form-region editor-form-region-wide"
          }
        >
          {surface?.kind === "page-list" ? (
            <PagesDirectoryTableShapes />
          ) : usesContentLibrary(surface) ? (
            <ContentLibraryTableShapes withSelect={withSelect} postOnly={surface?.kind === "record-list"} />
          ) : browse ? (
            <div className="record-list content-index">
              {canCreate ? <RecordListCreateShape /> : null}
              <TableFrame tabIndex={-1}>
                <table className="data-table browse-table">
                  <thead>
                    <tr>{recordHeadings.map((heading) => <th scope="col" key={heading}>{heading}</th>)}</tr>
                  </thead>
                  <tbody>
                    <SkeletonTableRows
                      columns={eventList ? EVENT_RECORD_LIST_COLUMNS : RECORD_LIST_COLUMNS}
                      headings={recordHeadings}
                      rowClassName="content-index-row"
                      rows={8}
                    />
                  </tbody>
                </table>
              </TableFrame>
            </div>
          ) : (
            <EditorFieldsShapes />
          )}
        </div>
      </Panel>
    </SkeletonRegion>
  );
}
