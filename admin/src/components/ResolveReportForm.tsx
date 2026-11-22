import { useId, useRef, useState, type FormEvent } from "react";
import { AsyncActionButton, InlineMessage, Textarea } from "./ui/Primitives";

export function ResolveReportForm({ version, onResolve }: {
  version: number;
  onResolve: (baseVersion: number, mutationId: string, note: string) => Promise<void>;
}) {
  const titleId = useId();
  const hintId = useId();
  const [confirmedVersion, setConfirmedVersion] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ version: number; note: string; id: string } | null>(null);
  const confirmed = confirmedVersion === version;

  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = note.trim();
    if (!confirmed || !trimmed || pending) return;
    if (attempt.current?.note !== trimmed || attempt.current.version !== version) {
      attempt.current = { version, note: trimmed, id: crypto.randomUUID() };
    }
    setPending(true);
    setError(null);
    try {
      await onResolve(version, attempt.current.id, trimmed);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The report could not be saved. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId}>Fix delivery</h3>
      <form className="report-resolution-form" onSubmit={(event) => void resolve(event)}>
        <label className="report-resolution-confirm">
          <input
            checked={confirmed}
            disabled={pending}
            onChange={(event) => setConfirmedVersion(event.target.checked ? version : null)}
            type="checkbox"
          />
          I verified that the fix is available where the problem occurred.
        </label>
        {confirmed ? <>
          <label className="report-resolution-note">
            Resolution note
            <Textarea
              aria-describedby={hintId}
              maxLength={1_000}
              onChange={(event) => setNote(event.target.value)}
              readOnly={pending}
              required
              rows={3}
              value={note}
            />
          </label>
          <p className="field-hint" id={hintId}>The reporter can read this note. Describe the fix and how you checked it.</p>
          <div className="button-row">
            <AsyncActionButton type="submit" variant="primary" label="Resolve report" pending={pending} pendingLabel="Saving resolution" disabled={!note.trim()} />
          </div>
        </> : null}
        {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      </form>
    </section>
  );
}
