import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MediaComment, MediaCommentTime } from "../../lib/media-feedback";
import { clockLabel, commentTimeLabel, commentTimeSpoken } from "../../lib/media-comment-time";
import "./MediaCommentTimeline.css";

type TimedComment = MediaComment & { time: MediaCommentTime };

/** Markers closer than one target width share a cluster (WCAG 2.5.8 target spacing). */
const TARGET_PX = 24;
const EXCERPT = 80;

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT - 1)}…` : line;
}

export function commentMarkerName(comment: TimedComment): string {
  return `Comment by ${comment.authorName} ${commentTimeSpoken(comment.time)}: ${excerpt(comment.text)}`;
}

export function placedComments(comments: readonly MediaComment[]): TimedComment[] {
  return comments
    .filter((comment): comment is TimedComment => Boolean(comment.time?.currentVersion))
    .sort((a, b) => a.time.startMs - b.time.startMs || a.createdAt.localeCompare(b.createdAt));
}

interface Group {
  comments: TimedComment[];
  x: number;
}

function groups(comments: TimedComment[], durationMs: number, width: number): Group[] {
  const result: Group[] = [];
  for (const comment of comments) {
    const x = Math.min(1, comment.time.startMs / durationMs) * width;
    const last = result.at(-1);
    if (last && x - last.x < TARGET_PX) last.comments.push(comment);
    else result.push({ comments: [comment], x });
  }
  return result;
}

function groupName(group: Group): string {
  if (group.comments.length === 1) return commentMarkerName(group.comments[0]);
  const first = clockLabel(group.comments[0].time.startMs);
  const last = clockLabel(group.comments.at(-1)!.time.startMs);
  return `${group.comments.length} comments ${first === last ? `at ${first}` : `from ${first} to ${last}`}`;
}

/**
 * Comment markers above the review seek line, inside the native player surface. The markers form one toolbar with one tab stop;
 * arrow keys move between markers. Hover or focus shows a preview card that Esc dismisses
 * without moving focus. The comment list stays the main accessible view.
 */
export function MediaCommentTimeline({
  comments,
  durationMs,
  activeId,
  onOpen,
}: {
  comments: readonly MediaComment[];
  durationMs: number;
  activeId?: string;
  onOpen: (comment: MediaComment) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [width, setWidth] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const placed = useMemo(() => placedComments(comments), [comments]);
  const shown = useMemo(() => groups(placed, durationMs, width), [placed, durationMs, width]);

  // The lane mounts only once a comment is placed, so measure again when it appears.
  const laneShown = placed.length > 0 && durationMs > 0;
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [laneShown]);
  useEffect(() => {
    if (focusIndex >= shown.length) setFocusIndex(Math.max(0, shown.length - 1));
    if (expanded !== null && expanded >= shown.length) setExpanded(null);
  }, [expanded, focusIndex, shown.length]);

  if (placed.length === 0 || !(durationMs > 0)) return null;

  function move(index: number) {
    const next = Math.max(0, Math.min(shown.length - 1, index));
    setFocusIndex(next);
    setExpanded(null);
    buttons.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      if (expanded !== null) {
        setExpanded(null);
        buttons.current[expanded]?.focus();
      } else if (preview === null) return;
      setPreview(null);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!(event.target instanceof HTMLButtonElement) || !event.target.dataset.marker) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step) move(focusIndex + step);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(shown.length - 1);
    else return;
    event.preventDefault();
  }

  const card = expanded ?? preview;
  const cardGroup = card === null ? undefined : shown[card];
  const percent = (ms: number) => `${Math.min(100, (ms / durationMs) * 100)}%`;

  return <div className="media-comment-timeline" onKeyDown={onKeyDown} onMouseLeave={() => setPreview(null)}>
    <div className="media-comment-track" role="toolbar" aria-label="Comment markers" aria-orientation="horizontal">
      <div ref={track} className="media-comment-lane">
      {placed.filter(comment => comment.time.endMs !== null).map(comment =>
        <span key={`band-${comment.id}`} aria-hidden="true" className="media-comment-band"
          data-active={comment.id === activeId || undefined}
          style={{ left: percent(comment.time.startMs), width: `calc(${percent(comment.time.endMs! - comment.time.startMs)} + 2px)` }} />)}
      {shown.map((group, index) => {
        const cluster = group.comments.length > 1;
        return <button key={group.comments[0].id} type="button" data-marker="true"
          ref={element => { buttons.current[index] = element; }}
          className="media-comment-marker" data-cluster={cluster || undefined}
          data-active={group.comments.some(comment => comment.id === activeId) || undefined}
          tabIndex={index === focusIndex ? 0 : -1}
          aria-label={groupName(group)}
          aria-expanded={cluster ? expanded === index : undefined}
          style={{ left: `${group.x}px` }}
          onFocus={() => { setFocusIndex(index); setPreview(index); }}
          onBlur={event => { if (!event.currentTarget.closest(".media-comment-timeline")?.contains(event.relatedTarget)) setPreview(null); }}
          onMouseEnter={() => setPreview(index)}
          onClick={() => {
            setFocusIndex(index);
            if (cluster) setExpanded(expanded === index ? null : index);
            else onOpen(group.comments[0]);
          }}>
          {cluster ? <span aria-hidden="true">{group.comments.length}</span> : null}
        </button>;
      })}
      </div>
    </div>
    {cardGroup ? <div className="media-comment-card" data-expanded={expanded !== null || undefined}
      style={{ left: `${Math.max(0, Math.min(cardGroup.x, width - 264))}px` }}
      onMouseEnter={() => setPreview(card)}>
      {expanded !== null
        ? <ul aria-label={groupName(cardGroup)}>
          {cardGroup.comments.map(comment => <li key={comment.id}>
            <button type="button" className="media-comment-card-choice" aria-label={commentMarkerName(comment)}
              onClick={() => onOpen(comment)}>
              <strong>{comment.authorName}</strong> · {commentTimeLabel(comment.time)}
              <span>{excerpt(comment.text)}</span>
            </button>
          </li>)}
        </ul>
        : cardGroup.comments.map(comment => <p key={comment.id} aria-hidden="true">
          <strong>{comment.authorName}</strong> · {commentTimeLabel(comment.time)}
          <span>{cardGroup.comments.length > 1 ? excerpt(comment.text) : comment.text}</span>
        </p>)}
    </div> : null}
  </div>;
}
