import "./WhatsNewDialog.css";
import { useEffect, useRef, useState } from "react";
import { instantToStationLocal } from "../../../packages/content-core/src/station-time";
import type { WhatsNewNote } from "../data/whats-new";
import { hasUnreadWhatsNew, markWhatsNewSeen } from "../lib/whats-new-seen";
import { Button, InlineMessage } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

const KIND_LABELS: Record<WhatsNewNote["kind"], string> = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

type NotesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; notes: readonly WhatsNewNote[] };

// The notes load on first open, so they stay out of the shell's startup bundle.
const loadNotes = () => import("../data/whats-new").then(module => module.WHATS_NEW_NOTES);

const monthHeading = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function groupByMonth(notes: readonly WhatsNewNote[]) {
  const groups: { month: string; notes: WhatsNewNote[] }[] = [];
  for (const note of notes) {
    const month = monthHeading.format(new Date(`${note.date}T00:00:00Z`));
    const last = groups.at(-1);
    if (last?.month === month) last.notes.push(note);
    else groups.push({ month, notes: [note] });
  }
  return groups;
}

function recentNotes(notes: readonly WhatsNewNote[], now: number) {
  const today = instantToStationLocal(new Date(now).toISOString()).slice(0, 10);
  // Include today and the preceding 20 station dates, even across DST changes.
  const firstDay = new Date(`${today}T00:00:00Z`);
  firstDay.setUTCDate(firstDay.getUTCDate() - 20);
  const since = firstDay.toISOString().slice(0, 10);
  return notes.filter(note => note.date >= since && note.date <= today);
}

// Not a shared IconName: those names are also the custom navigation icon set that the server
// validates. The attributes match Icon so the glyph sits with the guide and report icons.
function GiftIcon() {
  return (
    <svg aria-hidden="true" className="icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v9h14v-9M12 8v13M12 8c-1.5-4-6-4.5-6-2s4 2 6 2c2 0 6 .5 6-2s-4.5-2-6 2" />
    </svg>
  );
}

// The launcher stays icon only in both control modes, like the guide and report controls beside
// it; a text label there crowds the page title out of a 320px header. Menus show the label.
export function WhatsNewDialog({ userId, menuItem = false, initiallyOpen = false }: { userId: string; menuItem?: boolean; initiallyOpen?: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [unread, setUnread] = useState(() => hasUnreadWhatsNew(userId));
  const [state, setState] = useState<NotesState>({ status: "idle" });
  const [openedAt, setOpenedAt] = useState(Date.now);
  const notes = state.status === "ready" ? recentNotes(state.notes, openedAt) : [];

  function markSeenIfOpen() {
    if (!dialogRef.current?.open) return;
    markWhatsNewSeen(userId);
    setUnread(false);
  }

  function fetchNotes() {
    setState({ status: "loading" });
    loadNotes().then(
      notes => {
        setState({ status: "ready", notes });
        markSeenIfOpen();
      },
      () => setState({ status: "error" }),
    );
  }

  function close() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function open() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    setOpenedAt(Date.now());
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    if (state.status === "idle" || state.status === "error") fetchNotes();
    else if (state.status === "ready") markSeenIfOpen();
  }

  // An update notice opens a fresh tab so its notes come from the current deployment.
  useEffect(() => {
    if (initiallyOpen) open();
  }, [initiallyOpen]);

  return (
    <>
      <Button
        aria-haspopup="dialog"
        aria-label={unread ? "What's new, unread updates" : "What's new"}
        className="whats-new-launch"
        data-unread={unread || undefined}
        onClick={open}
        title="What's new"
        variant={menuItem ? "menu" : "ghost"}
      >
        <GiftIcon />
        <span className={menuItem ? undefined : "workspace-more-label"}>What's new</span>
      </Button>
      <dialog
        aria-labelledby="whats-new-title"
        className="whats-new-dialog"
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="whats-new-panel">
          <div className="whats-new-head">
            <div>
              <h2 id="whats-new-title">What's new</h2>
              <p>The last three weeks of changes to Boardwalk, newest first.</p>
            </div>
            <Button aria-label="Close what's new" onClick={close} title="Close" variant="ghost">
              <span aria-hidden="true">×</span>
            </Button>
          </div>
          {state.status === "loading" || state.status === "idle" ? (
            <LoadingIndicator label="Loading what's new" />
          ) : state.status === "error" ? (
            <InlineMessage tone="error" title="The notes could not load">
              <p>Check your connection, then try again.</p>
              <Button onClick={fetchNotes}>Try again</Button>
            </InlineMessage>
          ) : notes.length === 0 ? (
            <p>No changes in the last three weeks.</p>
          ) : (
            <div className="whats-new-notes">
              {groupByMonth(notes).map(group => (
                <section key={group.month} aria-label={group.month}>
                  <h3>{group.month}</h3>
                  <ul>
                    {group.notes.map(note => (
                      <li key={`${note.date}-${note.title}`}>
                        <p className="whats-new-meta">
                          <time dateTime={note.date}>{dayLabel.format(new Date(`${note.date}T00:00:00Z`))}</time>
                          <span className={`whats-new-kind whats-new-kind-${note.kind}`}>{KIND_LABELS[note.kind]}</span>
                        </p>
                        <h4>{note.title}</h4>
                        <p>{note.body}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
