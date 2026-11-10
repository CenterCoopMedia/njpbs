import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { focusAfterChipRemoval } from "../../lib/media-filters";
import { tabEdgeFade } from "../../lib/media-tabs";
import { Chip } from "../ui/Chip";
import { Button } from "../ui/Primitives";
import "./MediaFilterChips.css";

export interface MediaFilterEdit {
  field: string;
  value: string;
  /** The chip body, to anchor the picker and take focus back when it closes. */
  anchor: HTMLButtonElement;
}

export interface MediaFilterChipModel {
  key: string;
  field: string;
  value: string;
  label: string;
  /** Visible qualifier for a client-only filter. */
  scopeLabel?: string;
}

export interface MediaFilterChipsProps {
  /** Applied filters in order, from filterChips(): Type, then Category. */
  chips: readonly MediaFilterChipModel[];
  /** Reopens the matching picker with this chip's value selected. */
  onEdit: (edit: MediaFilterEdit) => void;
  onRemove: (chip: MediaFilterChipModel) => void;
  /** Clears every chip and the search; sort stays (clearFilterChips). */
  onClearAll: () => void;
  /** Show the reset action when a surface allows only one chip alongside search. */
  showClearAllWithOneChip?: boolean;
  /** Takes focus once no chip is left. */
  filterButtonRef: RefObject<HTMLElement | null>;
}

type Pending = { removedKey: string; index: number; count: number } | { clearAll: true };

function splitLabel(label: string): { property?: string; value: string } {
  const at = label.indexOf(": ");
  return at < 0 ? { value: label } : { property: label.slice(0, at), value: label.slice(at + 2) };
}

// The applied-filter chip row. Focus moves only once the
// chip list has changed, so a removal the page refuses, for example over unsaved details,
// leaves focus where it was.
export function MediaFilterChips({ chips, filterButtonRef, onClearAll, onEdit, onRemove, showClearAllWithOneChip = false }: MediaFilterChipsProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  const keys = JSON.stringify(chips.map((chip) => chip.key));

  const updateFade = useCallback(() => {
    const row = rowRef.current;
    if (row) row.dataset.fade = tabEdgeFade(row);
  }, []);

  useLayoutEffect(() => {
    updateFade();
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    const present = new Set<string>(JSON.parse(keys));
    if ("removedKey" in pending && present.has(pending.removedKey)) return;
    const target = "clearAll" in pending ? { target: "filter" as const } : focusAfterChipRemoval(pending.index, pending.count);
    const removers = rowRef.current?.querySelectorAll<HTMLButtonElement>(".ui-chip-remove") ?? [];
    if (target.target === "chip" && removers.length > 0) removers[Math.min(target.index, removers.length - 1)].focus();
    else filterButtonRef.current?.focus();
  }, [filterButtonRef, keys, updateFade]);

  useEffect(() => {
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [updateFade]);

  if (chips.length === 0) return null;

  return (
    <div aria-label="Applied filters" className="media-filter-chips" data-fade="none" onScroll={updateFade} ref={rowRef} role="group">
      {chips.map((chip, index) => {
        const { property, value } = splitLabel(chip.label);
        return (
          <Chip
            key={chip.key}
            label={`Edit filter ${chip.label}`}
            onRemove={() => {
              pendingRef.current = { removedKey: chip.key, index, count: chips.length };
              onRemove(chip);
            }}
            onSelect={() => {
              const anchor = rowRef.current?.querySelectorAll<HTMLButtonElement>(".ui-chip-body")[index];
              if (anchor) onEdit({ field: chip.field, value: chip.value, anchor });
            }}
            popup="dialog"
            property={property}
            value={value}
            variant="filter"
          />
        );
      })}
      {[...new Set(chips.flatMap((chip) => chip.scopeLabel ? [chip.scopeLabel] : []))].map((label) => (
        <span className="media-filter-scope" key={label}>{label}</span>
      ))}
      {chips.length >= 2 || showClearAllWithOneChip ? (
        <Button
          onClick={() => {
            pendingRef.current = { clearAll: true };
            onClearAll();
          }}
          variant="ghost"
        >
          Clear all
        </Button>
      ) : null}
    </div>
  );
}
