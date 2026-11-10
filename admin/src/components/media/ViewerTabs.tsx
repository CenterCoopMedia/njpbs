import { useId } from "react";
import { Button } from "../ui/Primitives";

/** Tabs hide existing work panes; their callers keep each pane mounted. */
export function ViewerTabs<T extends string>({ label, value, items, onChange, className }: {
  label: string;
  value: T;
  items: readonly { value: T; label: string; panelId: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const id = useId();
  return <div className={className} role="tablist" aria-label={label} data-viewer-keys="off" onKeyDown={event => {
    const index = items.findIndex(item => item.value === value);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowRight" ? (index + 1) % items.length
        : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(items[next].value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }}>
    {items.map(item => <Button key={item.value} id={`${id}-${item.value}`} variant="ghost" role="tab"
      tabIndex={item.value === value ? 0 : -1} aria-selected={item.value === value}
      aria-controls={item.panelId} onClick={() => onChange(item.value)}>{item.label}</Button>)}
  </div>;
}
