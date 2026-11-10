import type { CSSProperties, ReactNode } from "react";
import "./Skeleton.css";

// Loading skeletons: the shape of a page or panel while its data loads. A skeleton region
// replaces a page-load LoadingIndicator; actions (save, upload, publish) keep the spinner.
//
// SkeletonRegion owns the accessibility contract. The container is aria-busy, one
// screen-reader-only status line names the wait, and every shape is aria-hidden. Shapes take
// the size of the content they stand for, so the loaded content does not move the layout.
// The shimmer stops under prefers-reduced-motion and forced colors.

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type Length = number | string;

function length(value: Length | undefined): string | undefined {
  return typeof value === "number" ? `${value}px` : value;
}

export interface SkeletonRegionProps {
  /** The spoken status, such as "Loading posts". Not shown on screen. */
  label: string;
  children: ReactNode;
  className?: string;
}

export function SkeletonRegion({ label, children, className }: SkeletonRegionProps) {
  return (
    <div className={classes("skeleton-region", className)} aria-busy="true" data-skeleton="">
      <span className="sr-only" role="status" aria-label={label}>{label}</span>
      <div className="skeleton-region-shapes" aria-hidden="true">{children}</div>
    </div>
  );
}

export type SkeletonRadius = "small" | "control" | "panel" | "round";

export interface SkeletonBlockProps {
  width?: Length;
  height?: Length;
  radius?: SkeletonRadius;
  className?: string;
  style?: CSSProperties;
}

/** A plain shape: a button, a chip, a field, an image, a chart. Hidden on its own, so a shape
    placed in a loaded table cell, outside a region, is still not announced. */
export function SkeletonBlock({ width, height, radius = "small", className, style }: SkeletonBlockProps) {
  return (
    <span
      aria-hidden="true"
      className={classes("skeleton-shape", "skeleton-block", `skeleton-radius-${radius}`, className)}
      style={{ width: length(width), height: length(height), ...style }}
    />
  );
}

export interface SkeletonTextProps {
  /** Line count. Each line takes the line height of the text it stands for. */
  lines?: number;
  /** Width of the last line, so a paragraph ends short. Other lines fill the width. */
  lastLineWidth?: Length;
  /** Width of a single line, or of every line when lines is 1. */
  width?: Length;
  /** Matches the text role the lines stand for. Font size and line height come from the parent. */
  className?: string;
}

/** Text lines. Put it where the text goes, so it inherits the same font size and line height. */
export function SkeletonText({ lines = 1, lastLineWidth = "60%", width, className }: SkeletonTextProps) {
  return (
    <span className={classes("skeleton-text", className)} aria-hidden="true">
      {Array.from({ length: Math.max(1, lines) }, (_, index) => {
        const last = index === lines - 1;
        const lineWidth = lines === 1 ? length(width) : last ? length(lastLineWidth) : length(width);
        return (
          <span className="skeleton-text-line" key={index}>
            <span className="skeleton-shape skeleton-text-bar" style={{ width: lineWidth }} />
          </span>
        );
      })}
    </span>
  );
}

export interface SkeletonThumbProps {
  /** Width in pixels. Height follows the aspect ratio. */
  size: number;
  shape?: "round" | "square";
  /** Width over height, such as 16 / 9. Square shapes default to 1. */
  aspectRatio?: number;
  className?: string;
}

/** An avatar (round) or a thumbnail (square). */
export function SkeletonThumb({ size, shape = "square", aspectRatio = 1, className }: SkeletonThumbProps) {
  return (
    <span
      aria-hidden="true"
      className={classes("skeleton-shape", "skeleton-thumb", `skeleton-thumb-${shape}`, className)}
      style={{ width: size, height: Math.round(size / aspectRatio) }}
    />
  );
}

/** One column's shape. className is the loaded cell's class, so column widths match. A custom
    cell draws a loaded cell's own markup, such as a title with an action row under it. */
export type SkeletonCell = { className?: string } & (
  | { kind: "text"; width?: Length; lines?: number }
  | { kind: "thumb"; size: number; shape?: "round" | "square"; aspectRatio?: number; width?: Length; lines?: number }
  | { kind: "chip"; width?: Length }
  | { kind: "actions"; count?: number; width?: Length }
  | { kind: "custom"; content: ReactNode }
);

function SkeletonCellShape({ cell }: { cell: SkeletonCell }) {
  if (cell.kind === "custom") return <>{cell.content}</>;
  if (cell.kind === "chip") return <SkeletonBlock width={cell.width ?? 72} height={22} radius="round" />;
  if (cell.kind === "actions") {
    return (
      <span className="skeleton-actions">
        {Array.from({ length: cell.count ?? 1 }, (_, index) => (
          <SkeletonBlock key={index} width={cell.width ?? 32} height={32} radius="control" />
        ))}
      </span>
    );
  }
  if (cell.kind === "thumb") {
    return (
      <span className="skeleton-media-cell">
        <SkeletonThumb size={cell.size} shape={cell.shape} aspectRatio={cell.aspectRatio} />
        <SkeletonText lines={cell.lines ?? 2} width={cell.width ?? "80%"} lastLineWidth="45%" />
      </span>
    );
  }
  return <SkeletonText lines={cell.lines ?? 1} width={cell.width ?? "70%"} lastLineWidth="45%" />;
}

export interface SkeletonTableRowsProps {
  columns: readonly SkeletonCell[];
  rows?: number;
  /** The loaded table's headings. Each cell takes its heading as data-label, so the narrow
      card layout shows the same captions and grid areas as the loaded rows. */
  headings?: readonly string[];
  /** The loaded rows' class, for tables whose narrow layout selects on it. */
  rowClassName?: string;
}

/**
 * Body rows for a real table. Render them inside the table's own tbody, under its real
 * header, so the columns keep their widths when the data arrives. Mark the table aria-busy.
 */
export function SkeletonTableRows({ columns, rows = 6, headings, rowClassName }: SkeletonTableRowsProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr className={classes("skeleton-row", rowClassName)} aria-hidden="true" key={row}>
          {columns.map((cell, column) => (
            <td key={column} className={cell.className} data-label={headings?.[column]}><SkeletonCellShape cell={cell} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

export interface SkeletonTableProps extends SkeletonTableRowsProps {
  label: string;
  /** The loaded table's column headings, in order. */
  headings: readonly string[];
  /** The loaded table's class names, so header height and column widths match. */
  tableClassName?: string;
  className?: string;
}

/** A whole table while it loads: the real headings over skeleton rows. */
export function SkeletonTable({ label, headings, columns, rows, rowClassName, tableClassName, className }: SkeletonTableProps) {
  return (
    <div className={classes("skeleton-region", className)} aria-busy="true" data-skeleton="">
      <span className="sr-only" role="status" aria-label={label}>{label}</span>
      <table className={classes("data-table", tableClassName)} aria-hidden="true">
        <thead>
          <tr>
            {headings.map((heading) => <th scope="col" key={heading}>{heading}</th>)}
          </tr>
        </thead>
        <tbody>
          <SkeletonTableRows columns={columns} rows={rows} headings={headings} rowClassName={rowClassName} />
        </tbody>
      </table>
    </div>
  );
}

export interface SkeletonCardGridProps {
  count?: number;
  /** One card's shape. Defaults to a heading line over two text lines. */
  card?: ReactNode;
  className?: string;
}

/** A grid of cards. The grid columns come from the className, which should be the loaded grid's. */
export function SkeletonCardGrid({ count = 4, card, className }: SkeletonCardGridProps) {
  return (
    <div className={classes("skeleton-card-grid", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-card" key={index}>
          {card ?? (
            <>
              <SkeletonText width="55%" />
              <SkeletonText lines={2} width="90%" lastLineWidth="50%" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
