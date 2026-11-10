import { ControlSizingProvider } from "../../context/ControlSizingContext";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cursorPagingRules, loadMorePagingRules, numberedPagingRules } from "../../lib/media-paging";
import { ActionControl } from "../ui/ActionControl";
import { Button, InlineMessage } from "../ui/Primitives";
import "./MediaPaging.css";

interface PagingBase {
  label?: string;
  loading?: boolean;
  error?: string;
  /** A focusable summary at the start of a newly loaded page. */
  pageStartRef?: RefObject<HTMLElement | null>;
  showStatus?: boolean;
}

export type MediaPagingProps = PagingBase & (
  | { mode: "numbered"; page: number; pageCount: number; onPage: (page: number) => void }
  | { mode: "cursor"; page: number; isLastPage: boolean; onFirst: () => void; onPrevious: () => void; onNext: () => void }
  | { mode: "load-more"; loaded: number; total?: number | null; hasMore: boolean; onMore: () => void }
);

/** Paging presents route-owned state and never starts a list read itself. */
export function MediaPaging(props: MediaPagingProps) {
  return <ControlSizingProvider size="standard"><MediaPagingContent {...props} /></ControlSizingProvider>;
}

function MediaPagingContent(props: MediaPagingProps) {
  const navRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const moveSequence = useRef(0);
  const numbered = props.mode === "numbered" ? numberedPagingRules(props.page, props.pageCount) : null;
  const cursor = props.mode === "cursor" ? cursorPagingRules(props.page, props.isLastPage) : null;
  const loadMore = props.mode === "load-more"
    ? loadMorePagingRules({ loaded: props.loaded, total: props.total, hasMore: props.hasMore, loading: props.loading })
    : null;
  const announcement = numbered?.announcement ?? cursor?.announcement ?? loadMore?.announcement ?? "";
  const previous = useRef({ announcement, loading: Boolean(props.loading), error: props.error });
  const current = useRef(previous.current);
  current.current = { announcement, loading: Boolean(props.loading), error: props.error };

  useEffect(() => {
    const before = previous.current;
    previous.current = { announcement, loading: Boolean(props.loading), error: props.error };
    if (!pendingFocus.current || props.loading) return;
    if (before.announcement === announcement && before.error === props.error && !before.loading) return;
    const focus = document.activeElement;
    if (focus !== document.body && !navRef.current?.contains(focus)) {
      pendingFocus.current = null;
      return;
    }
    const move = pendingFocus.current;
    pendingFocus.current = null;
    const frame = requestAnimationFrame(() => {
      const pageStart = props.pageStartRef?.current;
      if (pageStart) {
        pageStart.focus({ preventScroll: true });
        pageStart.scrollIntoView?.({ block: "start" });
        return;
      }
      const nav = navRef.current;
      const preferred = Array.from(nav?.querySelectorAll<HTMLButtonElement>("button[data-move]") ?? [])
        .find((button) => button.dataset.move === move && !button.disabled);
      const fallback = nav?.querySelector<HTMLButtonElement>("button[data-move]:not(:disabled)");
      (preferred ?? fallback ?? nav)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [announcement, props.error, props.loading, props.pageStartRef]);

  const move = (direction: string, action: () => void) => {
    const before = current.current;
    const sequence = ++moveSequence.current;
    pendingFocus.current = direction;
    action();
    requestAnimationFrame(() => {
      const after = current.current;
      const focus = document.activeElement;
      if (moveSequence.current === sequence && pendingFocus.current === direction
        && after.announcement === before.announcement && after.loading === before.loading && after.error === before.error
        && focus !== document.body && !navRef.current?.contains(focus)) {
        pendingFocus.current = null;
      }
    });
  };

  let actions: ReactNode;
  switch (props.mode) {
    case "numbered":
      actions = <>
        <ActionControl action="previous-page" data-move="previous" disabled={numbered?.previous.disabled || props.loading} label="Previous page" onClick={() => move("previous", () => props.onPage(numbered!.page - 1))} variant="secondary" />
        <ActionControl action="next-page" data-move="next" disabled={numbered?.next.disabled || props.loading} label="Next page" onClick={() => move("next", () => props.onPage(numbered!.page + 1))} variant="secondary" />
      </>;
      break;
    case "cursor":
      actions = <>
        <Button data-move="first" disabled={cursor?.first.disabled || props.loading} onClick={() => move("first", props.onFirst)} variant="secondary">First page</Button>
        <ActionControl action="previous-page" data-move="previous" disabled={cursor?.previous.disabled || props.loading} label="Previous page" onClick={() => move("previous", props.onPrevious)} variant="secondary" />
        <ActionControl action="next-page" data-move="next" disabled={cursor?.next.disabled || props.loading} label="Next page" onClick={() => move("next", props.onNext)} variant="secondary" />
      </>;
      break;
    case "load-more":
      actions = <Button data-move="more" disabled={loadMore?.more.disabled} onClick={() => move("more", props.onMore)} variant="secondary">{loadMore?.more.label}</Button>;
      break;
  }

  return <nav aria-label={props.label ?? "Media pages"} className="media-paging" ref={navRef} tabIndex={-1}>
    {props.showStatus === false ? null : <span className="media-paging-status" role="status">
      {announcement}{props.loading ? " · loading" : ""}
    </span>}
    <div className="media-paging-actions">{actions}</div>
    {props.error ? <InlineMessage className="media-paging-error" title="Paging failed" tone="error">{props.error}</InlineMessage> : null}
  </nav>;
}
