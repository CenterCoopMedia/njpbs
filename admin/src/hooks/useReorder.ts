import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type RefCallback } from "react";

export interface ReorderItem {
  id: string;
  label: string;
  group?: string;
  disabled?: boolean;
}
export interface ReorderTarget { targetId: string; after: boolean }
type ItemProps = HTMLAttributes<HTMLElement> & {
  ref: RefCallback<HTMLElement>;
  "data-reorder-item": string;
  "data-reorder-dragging"?: boolean;
  "data-reorder-drop"?: "before" | "after";
};

/** The grip interaction only. Each surface keeps its own validation, history and saving. */
export function useReorder({ items, onMove, disabled = false, canDrop, mouseDrag = "native" }: {
  items: readonly ReorderItem[];
  onMove: (id: string, target: ReorderTarget) => void;
  disabled?: boolean;
  canDrop?: (id: string, targetId: string) => boolean;
  mouseDrag?: "native" | "pointer";
}) {
  const helpId = useId();
  const instructions = "Drag the grip to move. On touch, hold the grip before dragging. With the grip focused, use Up or Down to move. Press Escape to cancel a drag. You can also use the Move controls.";
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [hint, setHint] = useState<ReorderTarget | null>(null);
  const active = useRef<string | null>(null);
  const target = useRef<ReorderTarget | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const focus = useRef<string | null>(null);
  const pendingMove = useRef<{ id: string; order: string } | null>(null);
  const touch = useRef<{ id: string; x: number; y: number; pointer: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const frame = useRef<number | null>(null);

  function clear() {
    if (touch.current) clearTimeout(touch.current.timer);
    touch.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    active.current = null;
    target.current = null;
    setDragging(null);
    setHint(null);
  }
  function cancel() {
    if (active.current) {
      focus.current = active.current;
      setAnnouncement("Move canceled. Order unchanged.");
    }
    clear();
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (active.current || touch.current)) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      if (touch.current) clearTimeout(touch.current.timer);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);
  const signature = items.map(item => `${item.id}:${item.group ?? ""}:${Boolean(item.disabled)}`).join("|");
  // Invalidate before input can start a drag on the newly committed items.
  useLayoutEffect(() => { if (active.current || touch.current) cancel(); }, [disabled, signature]);
  useLayoutEffect(() => {
    const pending = pendingMove.current;
    if (pending) {
      pendingMove.current = null;
      const item = items.find(candidate => candidate.id === pending.id);
      const siblings = items.filter(candidate => candidate.group === item?.group);
      const order = siblings.map(candidate => candidate.id).join("|");
      setAnnouncement(item && order !== pending.order
        ? `${item.label} moved to position ${siblings.findIndex(candidate => candidate.id === item.id) + 1} of ${siblings.length}.`
        : "Order unchanged. Choose another position or use the Move controls.");
    }
    if (!focus.current) return;
    handles.current.get(focus.current)?.focus({ preventScroll: true });
    focus.current = null;
  });

  function allowed(id: string, targetId: string) {
    const source = items.find(item => item.id === id);
    const destination = items.find(item => item.id === targetId);
    return !disabled && source && !source.disabled && destination && id !== targetId
      && source.group === destination.group && (canDrop?.(id, targetId) ?? true);
  }
  function begin(id: string) {
    const item = items.find(item => item.id === id);
    if (disabled || !item || item.disabled) return;
    active.current = id;
    setDragging(id);
    setAnnouncement(`${item.label} grabbed. Choose a position, or press Escape to cancel.`);
  }
  function dropTarget(hit: Element | null): string | null {
    const source = active.current;
    if (!source) return null;
    // Follow DOM ancestry, including portal hosts, and prefer the nearest valid item.
    // A span may land over its target's planks; a plank must stay in its own column.
    let element = hit?.closest<HTMLElement>("[data-reorder-item]") ?? null;
    while (element) {
      const id = element.dataset.reorderItem;
      if (id && elements.current.get(id) === element && allowed(source, id)) return id;
      element = element.parentElement?.closest<HTMLElement>("[data-reorder-item]") ?? null;
    }
    return null;
  }
  function preview(targetId: string, clientY: number) {
    const id = active.current;
    const element = elements.current.get(targetId);
    if (!id || !element || !allowed(id, targetId)) {
      target.current = null;
      setHint(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const next = { targetId, after: clientY > rect.top + rect.height / 2 };
    if (target.current?.targetId === next.targetId && target.current.after === next.after) return;
    target.current = next;
    setHint(next);
  }
  function move(id: string, destination: ReorderTarget) {
    if (!allowed(id, destination.targetId)) return;
    const item = items.find(item => item.id === id)!;
    const siblings = items.filter(candidate => candidate.group === item.group);
    const remaining = siblings.filter(candidate => candidate.id !== id);
    const position = remaining.findIndex(candidate => candidate.id === destination.targetId) + Number(destination.after);
    if (position === siblings.findIndex(candidate => candidate.id === id)) {
      focus.current = id;
      setAnnouncement("Order unchanged.");
      return;
    }
    pendingMove.current = { id, order: siblings.map(candidate => candidate.id).join("|") };
    focus.current = id;
    onMove(id, destination);
    setAnnouncement("Moving content.");
  }
  function finish() {
    if (active.current && target.current) move(active.current, target.current);
    else if (active.current) setAnnouncement("No valid drop position. Order unchanged.");
    clear();
  }
  function touchFrame() {
    const pointer = touch.current;
    if (!pointer || !active.current) return;
    const hit = document.elementFromPoint(pointer.x, pointer.y);
    const targetId = dropTarget(hit);
    if (targetId) preview(targetId, pointer.y);
    else { target.current = null; setHint(null); }
    // Scroll the nearest scrollport while holding at its edge, including a nested rail list.
    let scrollport = hit instanceof HTMLElement ? hit : hit?.parentElement ?? null;
    while (scrollport && !(scrollport.scrollHeight > scrollport.clientHeight && /auto|scroll/.test(getComputedStyle(scrollport).overflowY))) scrollport = scrollport.parentElement;
    const bounds = scrollport?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const delta = pointer.y < bounds.top + 44 ? -8 : pointer.y > bounds.bottom - 44 ? 8 : 0;
    if (delta) (scrollport ?? document.scrollingElement)?.scrollBy?.(0, delta);
    frame.current = requestAnimationFrame(touchFrame);
  }
  function handleProps(id: string): ButtonHTMLAttributes<HTMLButtonElement> & { ref: RefCallback<HTMLButtonElement> } {
    const item = items.find(candidate => candidate.id === id);
    return {
      ref: node => { if (node) handles.current.set(id, node); else handles.current.delete(id); },
      "aria-label": `Move: ${item?.label ?? id}`,
      "aria-describedby": helpId,
      "aria-keyshortcuts": "ArrowUp ArrowDown Escape",
      "aria-pressed": dragging === id,
      title: disabled ? "Reordering is unavailable while this surface is read-only or busy."
        : !item || item.disabled ? "This item has a fixed position." : "Drag to move. Use Up or Down when focused.",
      disabled: disabled || !item || item.disabled,
      draggable: mouseDrag === "native" && !disabled && !!item && !item.disabled,
      onKeyDown: event => {
        if (disabled || !item || item.disabled) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const siblings = items.filter(candidate => candidate.group === item?.group);
        const index = siblings.findIndex(candidate => candidate.id === id);
        const down = event.key === "ArrowDown";
        const neighbor = siblings[index + (down ? 1 : -1)];
        if (neighbor) move(id, { targetId: neighbor.id, after: down });
        else setAnnouncement(`${item?.label} is already ${down ? "last" : "first"} in this group.`);
      },
      onDragStart: event => {
        if (disabled || !item || item.disabled) { event.preventDefault(); return; }
        event.stopPropagation();
        begin(id);
        event.dataTransfer.effectAllowed = "move";
        // Text editors must not interpret an internal move as dropped prose.
        event.dataTransfer.setData("application/x-boardwalk-reorder", id);
      },
      onDragEnd: () => { if (active.current) cancel(); else clear(); },
      onPointerDown: event => {
        if (event.pointerType === "mouse" && mouseDrag === "native" || disabled || !item || item.disabled || event.button !== 0) return;
        const button = event.currentTarget;
        button.setPointerCapture?.(event.pointerId);
        touch.current = { id, x: event.clientX, y: event.clientY, pointer: event.pointerId, timer: setTimeout(() => {
          begin(id);
          frame.current = requestAnimationFrame(touchFrame);
        }, 250) };
        if (event.pointerType === "mouse") {
          clearTimeout(touch.current.timer);
          begin(id);
          frame.current = requestAnimationFrame(touchFrame);
        }
      },
      onPointerMove: event => {
        const pointer = touch.current;
        if (!pointer || pointer.pointer !== event.pointerId) return;
        if (!active.current && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) { clear(); return; }
        pointer.x = event.clientX;
        pointer.y = event.clientY;
      },
      onPointerUp: event => {
        if (touch.current?.pointer === event.pointerId) {
          // Input can reach pointer-up before the next animation frame.
          if (active.current) touchFrame();
          finish();
        }
      },
      // Native HTML drag takes over the mouse pointer and emits pointercancel.
      // Only a canceled touch gesture should cancel this interaction here.
      onPointerCancel: () => { if (touch.current) cancel(); },
    };
  }
  function itemProps(id: string): ItemProps {
    return {
      ref: node => { if (node) elements.current.set(id, node); else elements.current.delete(id); },
      "data-reorder-item": id,
      "data-reorder-dragging": dragging === id || undefined,
      "data-reorder-drop": hint?.targetId === id ? hint.after ? "after" : "before" : undefined,
      onDragOver: event => {
        if (!active.current) return;
        event.preventDefault();
        event.stopPropagation();
        const targetId = dropTarget(event.target instanceof Element ? event.target : null);
        event.dataTransfer.dropEffect = targetId ? "move" : "none";
        preview(targetId ?? "", event.clientY);
      },
      onDrop: event => {
        if (!active.current) return;
        event.preventDefault();
        event.stopPropagation();
        const targetId = dropTarget(event.target instanceof Element ? event.target : null);
        preview(targetId ?? "", event.clientY);
        finish();
      },
    };
  }
  return { handleProps, itemProps, announcement, helpId, instructions };
}
