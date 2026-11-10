import { useLayoutEffect, useRef } from "react";
import { FOCUSABLE } from "./floating";

const TEXT_ENTRY = 'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]), textarea, select';
/** One tab stop for command buttons; text entry and nested widgets own their keys. */
export function useToolbarNavigation(root: HTMLElement | null) {
  const active = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!root) return;
    const original = new Map<HTMLElement, string | null>();
    const candidates = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => {
      if (element.matches(TEXT_ENTRY) || element.closest('.ui-overflow-toolbar-search')) return false;
      if (element.closest('[role="toolbar"]') !== root) return false;
      const nested = element.closest('dialog, [role="dialog"], [role="menu"], [role="listbox"]');
      if (nested && root.contains(nested)) return false;
      return true;
    });
    const controls = () => candidates().filter(element => {
      if (element.matches(':disabled')) return false;
      if (element.getAttribute('aria-disabled') === 'true' && element.getAttribute('data-toolbar-disabled-focusable') !== 'true') return false;
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        if (parent.hidden || parent.inert || parent.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parent === root) break;
      }
      return true;
    });
    const update = () => {
      const list = controls();
      if (!list.includes(active.current!)) active.current = list[0] ?? null;
      for (const element of candidates()) {
        if (!original.has(element)) original.set(element, element.getAttribute('tabindex'));
        const value = element === active.current ? 0 : -1;
        if (element.getAttribute("tabindex") !== String(value)) element.tabIndex = value;
      }
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (controls().includes(target)) { active.current = target; update(); }
    };
    const key = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      if (event.key.startsWith("Arrow") && event.target instanceof Element && event.target.closest("[data-toolbar-local-arrows]")) return;
      const list = controls(); const index = list.indexOf(event.target as HTMLElement);
      if (index < 0) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length;
      active.current = list[next]; update(); active.current?.focus();
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-toolbar-disabled-focusable', 'hidden', 'inert', 'aria-hidden', 'style', 'class'] });
    root.addEventListener('focusin', focus); root.addEventListener('keydown', key);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect(); root.removeEventListener('focusin', focus); root.removeEventListener('keydown', key); window.removeEventListener('resize', update);
      for (const [element, value] of original) if (value === null) element.removeAttribute('tabindex'); else element.setAttribute('tabindex', value);
    };
  }, [root]);
}
