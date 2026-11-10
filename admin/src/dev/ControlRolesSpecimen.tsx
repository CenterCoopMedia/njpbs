import { useState } from "react";
import { ActionControl } from "../components/ui/ActionControl";
import { Icon } from "../components/ui/Icon";
import { InfoTooltip } from "../components/ui/InfoTooltip";
import { AsyncActionButton, Button, InlineMessage, StatusBadge, Tabs, TextInput } from "../components/ui/Primitives";

/** Local controls only. This specimen never reads or writes a CMS record. */
export function ControlRolesSpecimen() {
  const [selected, setSelected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removeExample, setRemoveExample] = useState(false);
  const [tab, setTab] = useState<"section" | "page">("section");
  return (
    <section aria-label="Control roles and states" style={{ padding: "var(--cms-space-4)", display: "grid", gap: "var(--cms-space-4)", background: "var(--cms-canvas)" }}>
      <h1>Control roles and states</h1>
      <p>Workspace preferences, draft edits and commit actions have separate roles.</p>
      <div aria-label="Surface hierarchy" style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-3)" }}>
        {([['workspace', 'Workspace', '#e6ebf0'], ['context', 'Inspector', '#edf1f6'], ['header', 'Section header', '#f2f4f7'], ['content', 'Content', '#ffffff'], ['selected', 'Selected', '#e9edff']] as const).map(([role, label, color]) => (
          <div key={role} style={{ width: "110px", border: "1px solid var(--cms-swatch-border)" }}>
            <div style={{ height: "48px", background: `var(--cms-surface-${role})` }} />
            <div style={{ padding: "7px", background: "var(--cms-surface-content)", fontSize: "var(--cms-font-tag)" }}>{label}<br />{color}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-4)", alignItems: "start", paddingTop: "var(--cms-space-12)" }}>
        {(["Idle", "Hover", "Focus"] as const).map(state => (
          <div key={state} style={{ display: "grid", gap: "var(--cms-space-2)" }}>
            <ActionControl action="settings" size="standard" contextLabel={state.toLowerCase()} />
            <h2 style={{ fontSize: "var(--cms-font-sm)" }}>{state}</h2>
          </div>
        ))}
        <div style={{ display: "grid", gap: "var(--cms-space-2)" }}>
          <h2 style={{ fontSize: "var(--cms-font-sm)" }}>Selected</h2>
          <ActionControl action="bold" size="standard" aria-pressed={selected} onClick={() => setSelected(value => !value)} />
        </div>
        <div style={{ display: "grid", gap: "var(--cms-space-2)" }}>
          <h2 style={{ fontSize: "var(--cms-font-sm)" }}>Busy</h2>
          <AsyncActionButton label="Preview" icon="monitor" pending pendingLabel="Preparing a saved preview of this revision…" size="standard" variant="ghost" />
        </div>
        <div style={{ display: "grid", gap: "var(--cms-space-2)" }}>
          <h2 style={{ fontSize: "var(--cms-font-sm)" }}>Disabled</h2>
          <Button size="standard" variant="secondary" disabled aria-describedby="control-disabled-reason">Unavailable</Button>
          <p id="control-disabled-reason">No changes to save.</p>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-2)" }}>
        <Button size="standard" variant="primary"><Icon name="upload" />Review &amp; publish</Button>
        <Button size="standard" variant="secondary"><Icon name="save" />Save draft</Button>
        <Button size="standard" variant="danger-quiet" onClick={() => setRemoveExample(true)}><Icon name="trash" />Remove</Button>
        <AsyncActionButton label="Preview" icon="monitor" pending={busy} pendingAnnouncement="Preparing a saved preview of this revision…" pendingLabel="Preparing a saved preview of this revision…" size="standard" variant="ghost" onClick={() => setBusy(true)} />
        <Button variant="ghost" onClick={() => setBusy(false)}>Reset preview</Button>
      </div>
      {removeExample ? <InlineMessage tone="warning" title="Destructive confirmation state">
        <Button variant="danger" disabled>Deleting example…</Button>
        <Button variant="ghost" onClick={() => setRemoveExample(false)}>Close example</Button>
      </InlineMessage> : null}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--cms-space-3)" }}>
        <StatusBadge tone="success" presentation="inline">Draft saved</StatusBadge>
        <StatusBadge tone="unknown" presentation="tag">Needs attention</StatusBadge>
      </div>
      <div style={{ display: "grid", gap: "var(--cms-space-3)", padding: "var(--cms-space-3)", background: "var(--cms-surface-soft)", border: "1px solid var(--cms-line)", borderRadius: "var(--cms-radius-panel)" }}>
        <div className="editor-field-label-row"><label className="editor-field-label" htmlFor="control-title">Section title</label><InfoTooltip label="Section title" content="Use the name readers will recognize." /></div>
        <TextInput id="control-title" defaultValue="Around New Jersey" />
        <InlineMessage tone="error" title="Preview could not be prepared">Keep editing, then try Preview again.</InlineMessage>
      </div>
      <div style={{ background: "var(--cms-surface-context)", padding: "16px" }}>
        <Tabs id="control-details" label="Details scope" value={tab} onChange={setTab} options={[
          { value: "section", label: "Section", panelId: "control-section-panel" },
          { value: "page", label: "Page", panelId: "control-page-panel" },
        ]} />
        <div id="control-section-panel" role="tabpanel" aria-labelledby="control-details-tab-section" hidden={tab !== "section"} style={{ paddingTop: "18px" }}>
          <label className="editor-field-label" htmlFor="control-standard-field">Standard field</label>
          <TextInput id="control-standard-field" controlSize="standard" defaultValue="Connected source" />
        </div>
        <div id="control-page-panel" role="tabpanel" aria-labelledby="control-details-tab-page" hidden={tab !== "page"} style={{ paddingTop: "18px" }}>
          <label className="editor-field-label" htmlFor="control-compact-field">Compact field</label>
          <TextInput id="control-compact-field" controlSize="compact" defaultValue="Home" />
          <label className="editor-field-label" htmlFor="control-readonly-field">Read-only field</label>
          <TextInput id="control-readonly-field" controlSize="standard" readOnly value="Retained stored value" />
        </div>
      </div>
      <div aria-label="Control sizes" style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-3)", alignItems: "center" }}>
        <ActionControl action="edit" size="compact" contextLabel="compact control" />
        <ActionControl action="outline" size="standard" contextLabel="standard control" />
        <ActionControl action="preview" size="comfortable" contextLabel="comfortable control" />
        <span>Fine pointer: 32 / 36 / 44px. Touch: 44px. Field sizes: 36 / 40px; legacy 44px.</span>
      </div>
      <div aria-label="Icon vocabulary" style={{ display: "flex", flexWrap: "wrap", gap: "var(--cms-space-4)" }}>
        {([
          ["home", "Home"], ["page", "Pages"], ["pen-square", "Posts"], ["stack", "All content"],
          ["image", "Media"], ["queue", "Queue"], ["history", "Activity"], ["calendar", "Schedule"],
          ["chart", "Analytics"], ["flag", "Reports"], ["settings", "Settings"],
        ] as const).map(([name, label]) => (
          <span key={name} style={{ display: "grid", gap: "var(--cms-space-1)" }}><Icon name={name} />{label}</span>
        ))}
      </div>
    </section>
  );
}
