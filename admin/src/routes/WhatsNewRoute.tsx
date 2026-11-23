import "./WhatsNewRoute.css";
import { stationDateForNotes, WhatsNewNotes } from "../components/WhatsNewNotes";
import { WHATS_NEW_NOTES } from "../data/whats-new";

export function WhatsNewRoute() {
  const today = stationDateForNotes(Date.now());
  const notes = WHATS_NEW_NOTES.filter(note => note.date <= today);

  return (
    <div className="whats-new-archive">
      {notes.length > 0 ? <WhatsNewNotes notes={notes} /> : <p>No release notes yet.</p>}
    </div>
  );
}
