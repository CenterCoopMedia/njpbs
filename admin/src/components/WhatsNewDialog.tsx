import "./WhatsNewDialog.css";
import { useEffect, useRef, useState } from "react";
import type { WhatsNewNote } from "../data/whats-new";
import { ROUTE_PATHS } from "../lib/routes";
import { hasUnreadWhatsNew, markWhatsNewSeen } from "../lib/whats-new-seen";
import { Button, buttonClassName, InlineMessage } from "./ui/Primitives";
import { Icon } from "./ui/Icon";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { stationDateForNotes, WhatsNewNotes } from "./WhatsNewNotes";

type NotesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; notes: readonly WhatsNewNote[] };

// The notes load on first open, so they stay out of the shell's startup bundle.
const loadNotes = () => import("../data/whats-new").then(module => module.WHATS_NEW_NOTES);

function recentNotes(notes: readonly WhatsNewNote[], now: number) {
  const today = stationDateForNotes(now);
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
          <a
            aria-label="View full changelog (opens in a new tab)"
            className={buttonClassName("secondary", "standard", "whats-new-archive-link")}
            href={ROUTE_PATHS.whatsNew}
            rel="noopener noreferrer"
            target="_blank"
          >
            View full changelog <Icon name="external-link" />
          </a>
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
            <WhatsNewNotes notes={notes} inDialog />
          )}
        </div>
      </dialog>
    </>
  );
}
