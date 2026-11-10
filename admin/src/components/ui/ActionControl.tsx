import { useControlSize } from "../../context/ControlSizingContext";
import { forwardRef, type ReactNode } from "react";
import { useControlPresentation } from "../../context/ControlPresentationContext";
import {
  ICON_CONTROL_REGISTRY,
  type IconControlId,
} from "../../lib/icon-control-registry";
import { Icon } from "./Icon";
import { Button, type ButtonProps } from "./Primitives";
import { Tooltip } from "./Tooltip";

export interface ActionControlProps
  extends Omit<ButtonProps, "aria-label" | "children" | "title"> {
  action: IconControlId;
  presentation?: "icons" | "text";
  contextLabel?: string;
  /** A complete action-and-target name when the normal label/context wording is insufficient. */
  accessibleName?: string;
  graphic?: ReactNode;
  graphicText?: string;
  label?: string;
  tooltipLabel?: string;
}

function classes(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export const ActionControl = forwardRef<HTMLButtonElement, ActionControlProps>(
  function ActionControl(
    {
      action,
      presentation: presentationOverride,
      className,
      contextLabel,
      accessibleName,
      disabled,
      graphic,
      graphicText,
      label,
      tooltipLabel,
      size,
      variant = "ghost",
      ...props
    },
    ref,
  ) {
    const inheritedSize = useControlSize();
    const defaultPresentation = useControlPresentation();
    const presentation = presentationOverride ?? defaultPresentation;
    const spec = ICON_CONTROL_REGISTRY[action];
    const visibleLabel = label ?? spec.label;
    const name = accessibleName ?? (contextLabel
      ? `${visibleLabel}: ${contextLabel}`
      : visibleLabel);
    const iconName = graphicText ? `${graphicText}: ${name}` : name;
    const menuItem = variant === "menu" || variant === "menu-danger";
    const iconMode = !menuItem && (spec.alwaysIcon || presentation === "icons");
    const registeredGraphic = spec.icon ? (
      <Icon name={spec.icon} />
    ) : (
      <span aria-hidden="true" className="action-control-glyph">
        {spec.glyph}
      </span>
    );
    const button = (
      <Button
        data-action={action}
        size={size ?? inheritedSize ?? "legacy"}
        variant={variant}
        aria-label={iconMode ? iconName : accessibleName || contextLabel ? name : undefined}
        className={classes(
          "action-control",
          iconMode ? "action-control-icon" : "action-control-text",
          className,
        )}
        disabled={disabled}
        ref={ref}
        {...props}
      >
        {menuItem ? <>{graphic ?? registeredGraphic}<span>{visibleLabel}</span></> : iconMode ? graphic ?? registeredGraphic : visibleLabel}
      </Button>
    );

    if (!iconMode) return button;
    const tooltip = tooltipLabel ?? name;
    if (!disabled) return <Tooltip content={tooltip}>{button}</Tooltip>;
    // Native disabled buttons cannot trigger help. Their contextual wrapper can
    // receive pointer events without adding a tab stop or enabling the action.
    if (action === "add-item" || action === "remove-item") {
      return <Tooltip content={tooltip}>
        <span className="action-control-disabled-trigger">{button}</span>
      </Tooltip>;
    }
    return button;
  },
);
