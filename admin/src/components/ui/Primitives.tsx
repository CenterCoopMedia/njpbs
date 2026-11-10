import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useControlSize, type ControlSize } from "../../context/ControlSizingContext";
import { useControlPresentation } from "../../context/ControlPresentationContext";
import { Icon, type IconName } from "./Icon";
import { Spinner } from "./LoadingIndicator";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet" | "menu" | "menu-danger";

export type ButtonSize = ControlSize;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function buttonClassName(variant: ButtonVariant = "secondary", size: ButtonSize = "legacy", className?: string) {
  if (variant === "menu" || variant === "menu-danger") {
    return classes("ui-menu-item", variant === "menu-danger" && "ui-menu-item-danger", className);
  }
  return classes("button", `button-${variant}`, size !== "legacy" && `button-size-${size}`, className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    type = "button",
    variant = "secondary",
    size,
    ...props
  },
  ref,
) {
  const inheritedSize = useControlSize();
  const resolvedSize = size ?? inheritedSize ?? "legacy";
  return (
    <button
      className={buttonClassName(variant, resolvedSize, className)}
      ref={ref}
      type={type}
      {...props}
    />
  );
});

// The pending glyph inside a control: the shared spinner at the size a button label allows.
export function ActivityIndicator() {
  return <Spinner className="activity-indicator" size="xs" />;
}

interface AsyncActionButtonProps extends Omit<ButtonProps, "aria-busy" | "children"> {
  label: string;
  /** Stable glyph slot; compact phone layouts may show it instead of the label. */
  icon?: IconName;
  pending: boolean;
  pendingAnnouncement?: string;
  pendingLabel: string;
  /** Reserve an alternate idle label when the action changes wording. Never reserves progress text. */
  reserveLabel?: string;
}

export function AsyncActionButton({
  "aria-label": accessibleName,
  className,
  disabled,
  icon,
  label,
  onClick,
  pending,
  pendingAnnouncement,
  pendingLabel,
  reserveLabel,
  size,
  variant = "secondary",
  ...props
}: AsyncActionButtonProps) {
  const presentation = useControlPresentation();
  const iconPresentation = variant !== "menu" && variant !== "menu-danger" && presentation === "icons";
  const name = accessibleName ?? label;
  // Some callers supply a contextual name; others supply progress wording.
  // Keep the visible action words in either name, without repeating progress.
  const pendingName = name.includes(label) ? `${name}: ${pendingLabel}` : `${label}: ${name}`;
  return (
    <>
      <Button
        aria-label={pending ? pendingName : name}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        className={classes("async-action-button", icon && iconPresentation ? "button-compact" : undefined, className)}
        disabled={pending ? false : disabled}
        {...props}
        size={size}
        variant={variant}
        onClick={(event) => {
          if (pending) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
      >
        <span className="async-action-label">
          <span aria-hidden="true" className="async-action-icon-slot">
            {pending ? <ActivityIndicator /> : icon ? <Icon className="button-compact-icon" name={icon} /> : null}
          </span>
          <span className="async-action-copy">
            {reserveLabel ? <span aria-hidden="true" className="async-action-idle-reserve">{reserveLabel}</span> : null}
            <span aria-hidden={pending || undefined} className={iconPresentation ? "button-compact-label" : undefined}>{label}</span>
          </span>
          {pending ? <span className="sr-only">{pendingLabel}</span> : null}
        </span>
      </Button>
      {pending && pendingAnnouncement ? (
        <span aria-atomic="true" className="sr-only" role="status">
          {pendingAnnouncement}
        </span>
      ) : null}
    </>
  );
}

interface FieldSizingProps { controlSize?: ControlSize }

export function TextInput({ className, controlSize, ...props }: InputHTMLAttributes<HTMLInputElement> & FieldSizingProps) {
  const inherited = useControlSize();
  return <input className={classes("field-control", `field-size-${controlSize ?? inherited ?? "legacy"}`, className)} {...props} />;
}

export function Select({ className, controlSize, ...props }: SelectHTMLAttributes<HTMLSelectElement> & FieldSizingProps) {
  const inherited = useControlSize();
  return <select className={classes("field-control", `field-size-${controlSize ?? inherited ?? "legacy"}`, className)} {...props} />;
}

export function Textarea({ className, controlSize, autoGrow = false, singleLine = false, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldSizingProps & { autoGrow?: boolean; singleLine?: boolean }) {
  const inherited = useControlSize();
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!singleLine || !area.current) return;
    const element = area.current;
    // Flatten before the browser records an edit. Rewriting a controlled value
    // in onChange corrupts the native undo transaction for a multiline paste.
    const insert = (event: Event, text: string) => {
      if (!/[\r\n]/.test(text) || !event.cancelable) return;
      event.preventDefault();
      element.ownerDocument.execCommand("insertText", false, text.replace(/[\r\n]+/g, " "));
    };
    const paste = (event: ClipboardEvent) => insert(event, event.clipboardData?.getData("text/plain") ?? "");
    const beforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        event.preventDefault(); element.form?.requestSubmit(); return;
      }
      insert(event, event.data ?? event.dataTransfer?.getData("text/plain") ?? "");
    };
    element.addEventListener("paste", paste);
    element.addEventListener("beforeinput", beforeInput);
    return () => {
      element.removeEventListener("paste", paste);
      element.removeEventListener("beforeinput", beforeInput);
    };
  }, [singleLine]);
  useLayoutEffect(() => {
    if (!autoGrow || !area.current) return;
    const element = area.current;
    const fit = () => {
      element.style.height = "0px";
      const style = getComputedStyle(element);
      element.style.height = `${element.scrollHeight + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)}px`;
    };
    fit();
    let disposed = false;
    const fonts = element.ownerDocument.fonts;
    // A swapped web font can change wrapping without changing this box's
    // width, so the ResizeObserver alone cannot notice clipped text.
    if (fonts?.status === "loading") void fonts.ready.then(() => { if (!disposed) fit(); });
    fonts?.addEventListener("loadingdone", fit);
    let width = element.clientWidth;
    let frame: number | null = null;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (element.clientWidth === width || frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; width = element.clientWidth; fit(); });
    }) : null;
    observer?.observe(element);
    window.addEventListener("resize", fit);
    return () => {
      disposed = true;
      fonts?.removeEventListener("loadingdone", fit);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, [autoGrow, props.value]);
  return <textarea ref={area} className={classes("field-control", `field-size-${controlSize ?? inherited ?? "legacy"}`, className)} {...props} />;
}

export interface TabOption<T extends string> {
  value: T;
  label: string;
  panelId: string;
  disabled?: boolean;
}

/** Automatic-activation tabs. Consumers own and retain the corresponding panels. */
export function Tabs<T extends string>({ id, label, value, options, onChange }: {
  id: string;
  label: string;
  value: T;
  options: readonly TabOption<T>[];
  onChange: (value: T) => void;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  return <div className="control-tabs" role="tablist" aria-label={label}>
    {options.map(option => <button
      key={option.value}
      type="button"
      role="tab"
      className="control-tab"
      id={`${id}-tab-${option.value}`}
      aria-controls={option.panelId}
      aria-selected={value === option.value}
      tabIndex={value === option.value ? 0 : -1}
      disabled={option.disabled}
      ref={element => { if (element) refs.current.set(option.value, element); else refs.current.delete(option.value); }}
      onClick={() => onChange(option.value)}
      onKeyDown={event => {
        const enabled = options.filter(item => !item.disabled);
        const index = enabled.findIndex(item => item.value === option.value);
        let next: TabOption<T> | undefined;
        if (event.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
        else if (event.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
        else if (event.key === "Home") next = enabled[0];
        else if (event.key === "End") next = enabled.at(-1);
        if (!next) return;
        event.preventDefault();
        onChange(next.value);
        refs.current.get(next.value)?.focus();
      }}
    >{option.label}</button>)}
  </div>;
}

interface PanelProps extends HTMLAttributes<HTMLElement> {
  tone?: "default" | "soft" | "warning";
}

export function Panel({ className, tone = "default", ...props }: PanelProps) {
  return <section className={classes("panel", `panel-${tone}`, className)} {...props} />;
}

export type StatusTone =
  | "draft"
  | "neutral"
  | "brand"
  | "pending"
  | "publishing"
  | "success"
  | "cancelled"
  | "deleted"
  | "failed"
  | "unknown";

interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  presentation?: "badge" | "inline" | "tag";
}

const STATUS_ICONS: Record<StatusTone, IconName> = {
  draft: "file",
  neutral: "file",
  brand: "check",
  pending: "activity",
  publishing: "activity",
  success: "check",
  cancelled: "remove",
  deleted: "trash",
  failed: "close",
  unknown: "info",
};

export function StatusBadge({
  children,
  className,
  tone = "neutral",
  presentation = "badge",
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={classes("status-badge", `status-badge-${tone}`, `status-presentation-${presentation}`, className)}
      {...props}
    >
      <Icon name={STATUS_ICONS[tone]} />
      {children}
    </span>
  );
}

interface RoleTagProps extends HTMLAttributes<HTMLSpanElement> {
  assigned?: boolean;
}

/**
 * A standing fact about an account, such as a top-level role. It deliberately does not go through
 * StatusBadge: a status is something that changes as work moves, and the dot invites a reader to
 * treat it that way. A role is a decision someone made about a person, so it reads as plain ink
 * text, and an absent role reads as the absence it is (#1036).
 */
export function RoleTag({ assigned = true, className, ...props }: RoleTagProps) {
  return (
    <span
      className={classes("role-tag", assigned ? null : "role-tag-none", className)}
      {...props}
    />
  );
}

interface StatusLabelProps extends Omit<StatusBadgeProps, "presentation"> {
  label?: string;
}

export function StatusLabel({
  children,
  className,
  label = "Status",
  tone = "neutral",
  ...props
}: StatusLabelProps) {
  return (
    <span className={classes("status-label", className)}>
      <span className="status-label-key">{label}:</span>
      {" "}
      <StatusBadge tone={tone} {...props}>
        {children}
      </StatusBadge>
    </span>
  );
}

interface InlineMessageProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  title?: string;
  tone?: "info" | "success" | "error" | "warning";
}

export function InlineMessage({
  children,
  className,
  title,
  tone = "info",
  ...props
}: InlineMessageProps) {
  // Errors interrupt; successes and warnings are announced politely. A warning that is not
  // announced at all is a warning a screen-reader user never learns about, which defeats the
  // point of raising it before the mistake lands.
  const role =
    tone === "error"
      ? "alert"
      : tone === "success" || tone === "warning"
        ? "status"
        : undefined;

  return (
    <div
      className={classes("inline-message", `inline-message-${tone}`, className)}
      role={role}
      {...props}
    >
      {title ? <strong className="inline-message-title">{title}</strong> : null}
      <div className="inline-message-copy">{children}</div>
    </div>
  );
}

interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  action?: ReactNode;
  description?: string;
  title: string;
}

export function EmptyState({
  action,
  className,
  description,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div className={classes("empty-state", className)} {...props}>
      <p className="empty-state-title">{title}</p>
      {description ? <p className="empty-state-description">{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

export function TableFrame({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const overflow = getComputedStyle(frame).overflowX;
      setScrollable((overflow === "auto" || overflow === "scroll") && frame.scrollWidth > frame.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    if (frame.firstElementChild) observer.observe(frame.firstElementChild);
    return () => observer.disconnect();
  }, [children]);
  return <div className={classes("table-frame", className)} ref={frameRef}
    role={scrollable ? "region" : labelled ? "group" : undefined}
    aria-label={scrollable ? "Scrollable table" : undefined}
    tabIndex={scrollable ? 0 : undefined} {...props}>{children}</div>;
}

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={classes("toolbar", className)} {...props} />;
}
