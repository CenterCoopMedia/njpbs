import { useId, useLayoutEffect, useRef, type ReactElement } from "react";
import { useControlPresentation } from "../../context/ControlPresentationContext";
import type { PageSelectionState } from "../../lib/media-selection";
import type { MediaTileAction, MediaTileActionId } from "../../lib/media-tile-actions";
import { Checkbox } from "../ui/Checkbox";
import { Icon } from "../ui/Icon";
import { InfoTooltip } from "../ui/InfoTooltip";
import { Button, type ButtonProps } from "../ui/Primitives";
import { Tooltip } from "../ui/Tooltip";
import "./SelectionBar.css";

function actionTooltip(button: ReactElement<ButtonProps>, label: string, key: string) {
  return <Tooltip content={label} key={key}>{button.props.disabled
    ? <span className="action-control-disabled-trigger">{button}</span> : button}</Tooltip>;
}

// The floating selection bar for the images and video libraries. It shows only with a selection: the count with the off-page count
// and any cap, the tri-state Select this page, the promoted actions from media-tile-actions,
// and Clear selection. It has no live region; the route's always-mounted status announces
// the count. The caller owns focus after Clear selection.

export interface SelectionBarProps {
  /** The group's name, such as "Collection selection" or "Video selection". */
  label: string;
  count: number;
  /** Selected items not on the visible page. */
  offPage: number;
  /** The selection cap, shown as "7 of 100 selected". */
  cap?: number;
  /** The info tooltip's words, such as "Selection carries across image pages and filters." */
  info?: string;
  pageState: PageSelectionState;
  pageDisabled?: boolean;
  onPageChange: (checked: boolean) => void;
  /** mediaBarActions(mediaSelectionActions(...)). Clear selection is drawn last on its own. */
  actions: readonly MediaTileAction[];
  actionsDisabled?: boolean;
  /** A transition that may show the caller's unsaved-changes prompt. */
  allowActionWhileDisabled?: MediaTileActionId;
  onAction: (id: MediaTileActionId) => void;
  clearDisabled?: boolean;
  onClear: () => void;
  /** A rejected change's message, such as the 100-video cap. */
  error?: string;
}

export function SelectionBar({
  actions,
  actionsDisabled = false,
  allowActionWhileDisabled,
  cap,
  clearDisabled = false,
  count,
  error,
  info,
  label,
  offPage,
  onAction,
  onClear,
  onPageChange,
  pageDisabled = false,
  pageState,
}: SelectionBarProps) {
  const reasonId = useId();
  const presentation = useControlPresentation();
  const dock = useRef<HTMLDivElement>(null);
  const visible = count > 0;
  useLayoutEffect(() => {
    const element = dock.current;
    const parent = element?.parentElement;
    if (!visible || !element || !parent) return;
    const property = "--media-selection-bar-height";
    const previous = parent.style.getPropertyValue(property);
    let measured = "";
    const measure = () => {
      measured = `${element.getBoundingClientRect().height}px`;
      parent.style.setProperty(property, measured);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (parent.style.getPropertyValue(property) === measured) {
        if (previous) parent.style.setProperty(property, previous);
        else parent.style.removeProperty(property);
      }
    };
  }, [visible]);
  if (count <= 0) return null;
  const promoted = actions.filter((action) => action.id !== "clear-selection");
  const reasons = [...new Set(promoted.flatMap((action) => action.disabledReason ? [action.disabledReason] : []))];
  const message = [...reasons, error].filter(Boolean).join(" ");
  const clear = <Button aria-label="Clear selection" size="standard"
    className="media-selection-bar-action media-selection-bar-clear" disabled={clearDisabled}
    onClick={onClear} variant="ghost">
    <Icon name="close" /><span className="media-selection-bar-label">Clear selection</span>
  </Button>;

  return (
    <div className="media-selection-dock" ref={dock}>
      <div aria-label={label} className="media-selection-bar" data-presentation={presentation} role="group"
        onFocusCapture={event => {
          const port = event.currentTarget;
          const target = event.target.closest<HTMLElement>(".ui-checkbox") ?? event.target;
          const frame = port.getBoundingClientRect();
          const control = target.getBoundingClientRect();
          const top = frame.top + port.clientTop;
          const bottom = top + port.clientHeight;
          const delta = control.top < top ? control.top - top
            : control.bottom > bottom ? control.bottom - bottom : 0;
          if (delta) port.scrollTop += delta;
        }}>
        <p className="media-selection-bar-summary">
          <span className="media-selection-bar-count">
            {count}
            {cap === undefined ? null : <span className="media-selection-bar-cap"> of {cap}</span>}
            {" selected"}
            {offPage > 0 ? <span className="media-selection-bar-off-page"> · {offPage} not on this page</span> : null}
          </span>
          {info ? <InfoTooltip content={info} label="selection" /> : null}
        </p>
        <Checkbox
          checked={pageState === "all"}
          className="media-selection-bar-page"
          disabled={pageDisabled}
          hideLabel
          indeterminate={pageState === "some"}
          label="Select this page"
          onChange={(event) => onPageChange(event.currentTarget.checked)}
          visibleLabel={
            <>
              <span className="media-selection-bar-page-long">Select this page</span>
              <span className="media-selection-bar-page-short">This page</span>
            </>
          }
        />
        <span aria-hidden="true" className="media-selection-bar-divider" />
        {promoted.map((action) => {
          const button = <Button
            aria-label={action.label}
            aria-describedby={action.disabledReason ? reasonId : undefined}
            className="media-selection-bar-action"
            disabled={(actionsDisabled && action.id !== allowActionWhileDisabled) || Boolean(action.disabledReason)}
            onClick={() => onAction(action.id)}
            variant="ghost"
            size="standard"
          >
            <Icon name={action.icon} />
            <span className="media-selection-bar-label">{action.label}</span>
          </Button>;
          return actionTooltip(button, action.label, action.id);
        })}
        <span aria-hidden="true" className="media-selection-bar-divider" />
        {actionTooltip(clear, "Clear selection", "clear-selection")}
        {message ? <p className="media-selection-bar-error" id={reasonId} role="alert">{message}</p> : null}
      </div>
    </div>
  );
}
