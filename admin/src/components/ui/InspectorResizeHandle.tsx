import { useRef, type PointerEvent } from "react";
import { clampInspectorWidth, INSPECTOR_WIDTH_BOUNDS, rootFontSize, stepInspectorWidth, type InspectorWidthBounds } from "../../lib/inspector-width";
import "./InspectorResizeHandle.css";

/** The Inspector's splitter, shared by the editor Outline and Details panes. */
export function InspectorResizeHandle({ bounds = INSPECTOR_WIDTH_BOUNDS, controls, edge = "left", label = "Resize details", onChange, width }: {
  bounds?: InspectorWidthBounds;
  controls?: string;
  edge?: "left" | "right";
  label?: string;
  onChange: (width: number, persist?: boolean) => void;
  width: number;
}) {
  const drag = useRef<{ id: number; x: number; width: number; px: number } | null>(null);
  function move(event: PointerEvent<HTMLDivElement>, persist: boolean) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const delta = (event.clientX - start.x) / start.px;
    onChange(clampInspectorWidth(start.width + (edge === "left" ? -delta : delta), bounds), persist);
    if (persist) drag.current = null;
  }
  return <div
    aria-controls={controls}
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemax={bounds.max}
    aria-valuemin={bounds.min}
    aria-valuenow={width}
    aria-valuetext={`${width} rem wide`}
    className={`ui-inspector-resize${edge === "right" ? " ui-inspector-resize-right" : ""}`}
    onKeyDown={event => {
      const next = stepInspectorWidth(width, event.key, bounds, edge);
      if (next === null) return;
      event.preventDefault();
      onChange(next);
    }}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width, px: rootFontSize() };
    }}
    onPointerMove={event => move(event, false)}
    onPointerUp={event => move(event, true)}
    onPointerCancel={() => {
      if (!drag.current) return;
      drag.current = null;
      onChange(width);
    }}
    onLostPointerCapture={() => {
      if (!drag.current) return;
      drag.current = null;
      onChange(width);
    }}
    role="separator"
    tabIndex={0}
  />;
}
