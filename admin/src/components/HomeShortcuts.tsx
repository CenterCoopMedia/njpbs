import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { Principal } from "../../../packages/content-core/src/rbac";
import { eligibleHomeShortcuts, resolveHomeShortcuts, type HomeShortcutId } from "../lib/home-shortcuts";
import { AsyncActionButton, Button, InlineMessage, Select, Toolbar } from "./ui/Primitives";

export interface HomeShortcutsProps {
  principal: Principal;
  stored: unknown;
  onSave: (ids: readonly HomeShortcutId[] | null) => Promise<void>;
}

export function HomeShortcuts({ principal, stored, onSave }: HomeShortcutsProps) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const eligible = eligibleHomeShortcuts(principal);
  const actions = resolveHomeShortcuts(stored, eligible);
  // Check again at activation; a stored ID never supplies a destination or authority.
  const latestPrincipal = useRef(principal);
  latestPrincipal.current = principal;
  if (!actions.length) return null;
  return <div className="home-shortcuts">
    <section className="newsroom-home-actions" aria-label="Home shortcuts">
      <div role="group" aria-label="Home shortcuts">
        {actions.map((action, index) => <Link key={action.id}
          className={`button button-${index === 0 ? "primary" : "secondary"}`}
          to={action.to}
          onClick={event => {
            if (!eligibleHomeShortcuts(latestPrincipal.current).some(candidate => candidate.id === action.id)) event.preventDefault();
          }}
        >{action.label}</Link>)}
      </div>
    </section>
    <Button variant="ghost" onClick={() => { setNotice(""); setEditing(true); }}>Customize Home shortcuts</Button>
    <span className="sr-only" role="status" aria-live="polite">{notice}</span>
    {editing ? <HomeShortcutDialog key={principal.id} principal={principal} stored={stored} onSave={onSave}
      onClose={() => setEditing(false)} onSaved={message => { setNotice(message); setEditing(false); }} /> : null}
  </div>;
}

function HomeShortcutDialog({ principal, stored, onSave, onClose, onSaved }: HomeShortcutsProps & {
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const eligible = eligibleHomeShortcuts(principal);
  const [draft, setDraft] = useState<unknown>(stored);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actions = resolveHomeShortcuts(draft, eligible);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    element?.querySelector<HTMLSelectElement>("select")?.focus();
    return () => { element?.close(); trigger?.focus(); };
  }, []);

  async function save(reset: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave(reset ? null : actions.map(action => action.id));
      onSaved(reset ? "Home shortcuts reset to defaults." : "Home shortcuts saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your Home shortcuts could not be saved. Try again.");
    } finally { setPending(false); }
  }

  return createPortal(<dialog ref={dialog} className="home-shortcut-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <h2 id={titleId}>Your Home shortcuts</h2>
    <p>Choose two destinations for your account. Choices follow your current access.</p>
    <form onSubmit={event => { event.preventDefault(); void save(false); }}>
      <fieldset disabled={pending}>
        <legend className="sr-only">Shortcut choices</legend>
        {actions.map((action, index) => <label key={index}>Shortcut {index + 1}
          <Select value={action.id} onChange={event => setDraft(actions.map((entry, slot) => slot === index ? event.target.value : entry.id))}>
            {eligible.map(option => <option key={option.id} value={option.id}
              disabled={actions.some((entry, slot) => slot !== index && entry.id === option.id)}>{option.label}</option>)}
          </Select>
        </label>)}
      </fieldset>
      <section className="home-shortcut-preview" aria-label="Shortcut preview">
        <h3>Preview</h3>
        <div>{actions.map((action, index) => <span key={action.id} className={`button button-${index === 0 ? "primary" : "secondary"}`}>{action.label}</span>)}</div>
      </section>
      {error ? <InlineMessage tone="error" role="alert">{error}</InlineMessage> : null}
      <Toolbar>
        <Button disabled={pending} onClick={() => void save(true)}>Reset to defaults</Button>
        <Button disabled={pending} onClick={onClose}>Cancel</Button>
        <AsyncActionButton type="submit" variant="primary" label="Save shortcuts" pending={pending} pendingLabel="Saving shortcuts…" />
      </Toolbar>
    </form>
  </dialog>, document.body);
}
