import { useRef, useState } from "react";
import { formatMediaDuration } from "../../lib/media-format";
import { ActionControl } from "../ui/ActionControl";
import { Popover } from "../ui/Popover";
import { Button, TextInput } from "../ui/Primitives";
import "./VideoBookmarks.css";

interface Bookmark {
  id: string;
  name: string;
  seconds: number;
}

interface VideoMoments {
  bookmarks: Bookmark[];
  resume: number | null;
}

const maxNameLength = 80;
const emptyMoments: VideoMoments = { bookmarks: [], resume: null };

function validTime(seconds: unknown): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
}

function validBookmark(value: unknown): value is Bookmark {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
    && "name" in value && typeof value.name === "string" && Boolean(value.name.trim()) && value.name.length <= maxNameLength
    && "seconds" in value && validTime(value.seconds);
}

function readMoments(key: string): VideoMoments {
  const raw = localStorage.getItem(key);
  if (!raw) return emptyMoments;
  try {
    const saved = JSON.parse(raw);
    return {
      bookmarks: Array.isArray(saved?.bookmarks) ? saved.bookmarks.filter(validBookmark) : [],
      resume: validTime(saved?.resume) ? saved.resume : null,
    };
  } catch {
    return emptyMoments;
  }
}

function withinVideo(video: HTMLVideoElement | null, seconds: unknown): seconds is number {
  return !!video && video.readyState >= 1 && !video.error && Number.isFinite(video.duration)
    && validTime(seconds) && seconds < video.duration;
}

export function VideoBookmarks({ scope, getPlayer, onSeek }: {
  scope: string;
  getPlayer: () => HTMLVideoElement | null;
  onSeek: (seconds: number) => void;
}) {
  const key = `njpbs.admin.video-moments:${scope}`;
  const anchor = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [marked, setMarked] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [moments, setMoments] = useState(emptyMoments);
  const [message, setMessage] = useState("");

  function toggle() {
    if (open) { setOpen(false); return; }
    const video = getPlayer();
    const seconds = video?.currentTime;
    setMarked(withinVideo(video, seconds) ? seconds : null);
    setName("");
    setMessage("");
    try {
      setMoments(readMoments(key));
    } catch {
      setMoments(emptyMoments);
      setMessage("Bookmarks could not be loaded in this browser.");
    }
    setOpen(true);
  }

  function save(update: (current: VideoMoments) => VideoMoments, success: string) {
    try {
      const next = update(readMoments(key));
      if (next.bookmarks.length || next.resume !== null) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
      setMoments(next);
      setMessage(success);
      return true;
    } catch {
      setMessage("Changes could not be saved in this browser.");
      return false;
    }
  }

  function canUseTime(seconds: number | null): seconds is number {
    if (withinVideo(getPlayer(), seconds)) return true;
    setMessage("That position is unavailable in this preview.");
    return false;
  }

  function jump(seconds: number) {
    if (!canUseTime(seconds)) return;
    setOpen(false);
    onSeek(seconds);
  }

  function focusName() {
    (form.current?.querySelector<HTMLInputElement>("input:not(:disabled)") ?? anchor.current)?.focus();
  }

  return <>
    <ActionControl action="media-bookmarks" ref={anchor} aria-haspopup="dialog" aria-expanded={open} onClick={toggle} />
    <Popover anchorRef={anchor} label="Video bookmarks" open={open} onOpenChange={setOpen}
      placement="bottom-end" dismissibleSheet>
      <div className="video-bookmarks" data-viewer-keys="off">
        <form ref={form} onSubmit={event => {
          event.preventDefault();
          event.stopPropagation();
          if (!name.trim() || !canUseTime(marked)) return;
          const bookmark = { id: crypto.randomUUID(), name: name.trim(), seconds: marked };
          if (save(current => ({ ...current, bookmarks: [...current.bookmarks, bookmark] }), "Bookmark saved.")) {
            setName("");
            focusName();
          }
        }}>
          <label>Bookmark name<TextInput value={name} maxLength={maxNameLength} disabled={marked === null}
            onChange={event => setName(event.target.value)} /></label>
          <Button type="submit" disabled={marked === null || !name.trim()}>
            {marked === null ? "Add bookmark" : `Bookmark ${formatMediaDuration(marked)}`}
          </Button>
        </form>
        {marked === null ? <p>Open a playable preview to save a position.</p> : null}
        {moments.bookmarks.length ? <ul aria-label="Saved bookmarks">
          {moments.bookmarks.map(({ id, name: label, seconds }) => {
            const time = formatMediaDuration(seconds);
            return <li key={id}>
              <Button variant="ghost" onClick={() => jump(seconds)}>{label} · {time}</Button>
              <Button variant="danger-quiet" aria-label={`Delete bookmark ${label} at ${time}`} onClick={() => {
                if (save(current => ({ ...current, bookmarks: current.bookmarks.filter(bookmark => bookmark.id !== id) }), "Bookmark deleted.")) focusName();
              }}>Delete</Button>
            </li>;
          })}
        </ul> : <p>No saved bookmarks.</p>}
        <div className="video-bookmarks-resume">
          <Button disabled={marked === null} onClick={() => {
            if (canUseTime(marked)) save(current => ({ ...current, resume: marked }), "Resume position saved.");
          }}>Save resume position</Button>
          {moments.resume !== null ? <>
            <Button onClick={() => { if (moments.resume !== null) jump(moments.resume); }}>Resume at {formatMediaDuration(moments.resume)}</Button>
            <Button variant="ghost" onClick={() => {
              if (save(current => ({ ...current, resume: null }), "Resume position cleared.")) focusName();
            }}>Clear resume position</Button>
          </> : null}
        </div>
        <p className="video-bookmarks-storage">Saved for you in this browser.</p>
        <p role="status">{message}</p>
      </div>
    </Popover>
  </>;
}
