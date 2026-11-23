import "./WhatsNewNotes.css";
import { instantToStationLocal } from "../../../packages/content-core/src/station-time";
import type { WhatsNewNote } from "../data/whats-new";

const KIND_LABELS: Record<WhatsNewNote["kind"], string> = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

const monthHeading = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function stationDateForNotes(now: number): string {
  return instantToStationLocal(new Date(now).toISOString()).slice(0, 10);
}

function groupByMonth(notes: readonly WhatsNewNote[]) {
  const groups: { month: string; id: string; notes: WhatsNewNote[] }[] = [];
  for (const note of notes) {
    const month = monthHeading.format(new Date(`${note.date}T00:00:00Z`));
    const last = groups.at(-1);
    if (last?.month === month) last.notes.push(note);
    else groups.push({ month, id: `notes-${note.date.slice(0, 7)}`, notes: [note] });
  }
  return groups;
}

export function WhatsNewNotes({ notes, inDialog = false }: { notes: readonly WhatsNewNote[]; inDialog?: boolean }) {
  const MonthHeading = inDialog ? "h3" : "h2";
  const NoteHeading = inDialog ? "h4" : "h3";
  const groups = groupByMonth(notes);

  return (
    <div className="whats-new-notes">
      {!inDialog && groups.length > 1 && (
        <nav aria-label="Jump to a month" className="whats-new-month-links">
          <ul role="list">
            {groups.map(group => <li key={group.id}><a href={`#${group.id}`}>{group.month}</a></li>)}
          </ul>
        </nav>
      )}
      {groups.map(group => (
        <section key={group.id} aria-label={group.month}>
          <MonthHeading
            className="whats-new-month"
            id={inDialog ? undefined : group.id}
            tabIndex={inDialog ? undefined : -1}
          >
            {group.month}
          </MonthHeading>
          <ul role="list">
            {group.notes.map(note => (
              <li key={`${note.date}-${note.title}`}>
                <p className="whats-new-meta">
                  <time dateTime={note.date}>{dayLabel.format(new Date(`${note.date}T00:00:00Z`))}</time>
                  <span className={`whats-new-kind whats-new-kind-${note.kind}`}>{KIND_LABELS[note.kind]}</span>
                </p>
                <NoteHeading className="whats-new-note-title">{note.title}</NoteHeading>
                <p className="whats-new-note-body">{note.body}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
