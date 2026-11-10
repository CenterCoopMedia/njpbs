import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ACCESS_TIERS, ALL_CAPABILITIES, TIER_CAPABILITIES, hasCapability, isAccessTier, withRegisteredMediaSections, type AccessTier } from "../../../packages/content-core/src/rbac";
import { ACCESS_TIER_TEXT } from "../lib/access-tier-text";
import { CAPABILITY_LABELS } from "../lib/access-change";
import { accessStateFromUserDoc, normalizeGrants, principalFromUserDoc } from "../lib/principal";
import { roleDisplayName } from "../lib/role-text";
import { staffOffboarding } from "../lib/staff-offboarding";
import type { ReactivateStaffRequest, StaffAccessLevelRequest } from "../lib/functions";
import type { AdminUserRecord } from "./UsersTable";
import { Button, EmptyState, InlineMessage, Select, StatusBadge, TableFrame, TextInput } from "./ui/Primitives";

function currentLevel(user: AdminUserRecord): string {
  if (Object.hasOwn(user, "accessTier")) {
    return isAccessTier(user.accessTier) ? ACCESS_TIER_TEXT[user.accessTier].name : "Invalid level — no access";
  }
  const roles = [user.role, ...normalizeGrants(user.grants).map((grant) => grant.role)].filter(Boolean);
  return roles.length ? `Legacy access: ${roles.map((role) => roleDisplayName(role!)).join(", ")}` : "No access assigned";
}

function StaffLevelRow({ user, matches, canManage, currentUserId, onSetLevel, onDeactivate, onReactivate, onPin, focusSearch, sectionIds }: {
  user: AdminUserRecord;
  matches: boolean;
  canManage: boolean;
  currentUserId?: string;
  onSetLevel: (request: StaffAccessLevelRequest) => Promise<void>;
  onDeactivate?: (targetUid: string) => void | Promise<void>;
  onReactivate?: (request: ReactivateStaffRequest) => Promise<void>;
  onPin: (uid: string, pinned: boolean) => void;
  focusSearch: () => void;
  sectionIds: ReadonlySet<string>;
}) {
  const [editing, setEditing] = useState<{ expectedAccess: string; tier: AccessTier | "" } | null>(null);
  const [offboarding, setOffboarding] = useState(false);
  // Stays open after a failed request, even once the row reads active, so the
  // Owner can retry the same level and finish turning sign-in back on.
  const [reactivating, setReactivating] = useState<AccessTier | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [returnFocus, setReturnFocus] = useState<"edit" | "deactivate" | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const deactivateButton = useRef<HTMLButtonElement | null>(null);
  const reactivateButton = useRef<HTMLButtonElement>(null);
  const attachDeactivateButton = useCallback((node: HTMLButtonElement | null) => {
    if (!node && deactivateButton.current === document.activeElement) setReturnFocus("deactivate");
    deactivateButton.current = node;
  }, []);
  const userLabel = user.displayName || user.email || user.id;
  const initials = userLabel.split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "NP";
  const accessState = user.accessState ?? accessStateFromUserDoc(user);
  const stale = editing !== null && accessState !== editing.expectedAccess;
  const self = currentUserId === user.id;
  const active = user.active !== false;
  const shutdown = staffOffboarding(user);
  useEffect(() => {
    if (canManage) return;
    if (editing || offboarding || reactivating) focusSearch();
    setEditing(null);
    setOffboarding(false);
    setReactivating(null);
  }, [canManage, focusSearch]);
  const pinned = Boolean(editing || offboarding || reactivating || submitting || message);
  useEffect(() => {
    if (!pinned) return;
    onPin(user.id, true);
    return () => onPin(user.id, false);
  }, [pinned, onPin, user.id]);
  useEffect(() => {
    if (!returnFocus) return;
    const target = !active && !shutdown.action ? reactivateButton.current : returnFocus === "edit" ? editButton.current : deactivateButton.current;
    if (matches && target && !target.disabled) target.focus();
    else focusSearch();
    setReturnFocus(null);
  }, [returnFocus, matches, focusSearch, active, shutdown.action]);
  const currentPrincipal = withRegisteredMediaSections(principalFromUserDoc(user.id, user, true), sectionIds);
  const added = editing?.tier ? TIER_CAPABILITIES[editing.tier].filter((capability) => !hasCapability(currentPrincipal, capability)) : [];
  const removed = editing?.tier ? ALL_CAPABILITIES.filter((capability) => hasCapability(currentPrincipal, capability) && !TIER_CAPABILITIES[editing.tier as AccessTier].includes(capability)) : [];

  async function apply() {
    if (!canManage || !editing?.tier || stale || self || !active || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await onSetLevel({ targetUid: user.id, accessTier: editing.tier, expectedAccess: editing.expectedAccess });
      setEditing(null);
      setMessage({ error: false, text: "Access level saved." });
      setReturnFocus("edit");
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : "Access could not be updated. Try again." });
    } finally { setSubmitting(false); }
  }

  async function deactivate() {
    if (!canManage || !onDeactivate || self || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await onDeactivate(user.id);
      setOffboarding(false);
      setMessage({ error: false, text: "Account deactivated and sessions revoked." });
      setReturnFocus("deactivate");
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : "Offboarding could not finish. Retry session shutdown." });
    } finally { setSubmitting(false); }
  }

  async function reactivate() {
    if (!canManage || !onReactivate || !reactivating || self || submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await onReactivate({ targetUid: user.id, accessTier: reactivating });
      setMessage({ error: false, text: `Account reactivated at ${ACCESS_TIER_TEXT[reactivating].name}. Sign-in is on.` });
      setReactivating(null);
      setReturnFocus("deactivate");
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : "Reactivation could not finish. Try again at the same level." });
    } finally { setSubmitting(false); }
  }

  return <tr hidden={!matches && !pinned} aria-busy={submitting}>
    <td data-label="Staff member"><div className="user-identity"><span className="user-avatar" aria-hidden="true">{initials}</span><span><strong className="content-title">{userLabel}</strong><small>{user.email}</small></span></div></td>
    <td data-label="Account state"><div className="staff-level-cell"><StatusBadge tone={active ? "brand" : "neutral"}>{active ? "Active" : "Inactive"}</StatusBadge>{!active ? <small>{shutdown.text}</small> : null}</div></td>
    <td data-label="Access level"><div className="staff-level-cell">
      <span className="sr-only" role="status">{submitting ? `${offboarding ? "Shutting down access" : reactivating ? "Reactivating account" : "Saving access"} for ${userLabel}` : ""}</span>
      <strong>{currentLevel(user)}</strong>
      {!Object.hasOwn(user, "accessTier") && normalizeGrants(user.grants).some((grant) => grant.sections !== undefined)
        ? <small>Has area limits. A new level applies to the whole site.</small> : null}
      {canManage && !editing ? <Button
        ref={editButton}
        aria-label={`Edit access level for ${userLabel}`}
        disabled={self || !active || submitting}
        onClick={() => { setEditing({ expectedAccess: accessState, tier: isAccessTier(user.accessTier) ? user.accessTier : "" }); setOffboarding(false); setMessage(null); }}
      >Edit</Button> : null}
      {self && canManage ? <small>You cannot change your own access.</small> : null}
      {editing && canManage ? <div className="staff-level-change" role="group" aria-label={`Change access for ${userLabel}`}>
        <Select autoFocus aria-label={`Access level for ${userLabel}`} value={editing.tier} disabled={submitting || stale || !active}
          onChange={(event) => {
            const tier = event.target.value;
            if (isAccessTier(tier)) setEditing({ ...editing, tier });
          }}>
          <option value="" disabled>Choose a level</option>
          {ACCESS_TIERS.map((tier) => <option key={tier} value={tier}>{ACCESS_TIER_TEXT[tier].name}</option>)}
        </Select>
        {editing.tier ? <>
          <p>{ACCESS_TIER_TEXT[editing.tier].summary}</p>
          <p>This replaces {currentLevel(user)} and all current roles and area grants with one whole-site level: {ACCESS_TIER_TEXT[editing.tier].name}.</p>
          {!Object.hasOwn(user, "accessTier") && normalizeGrants(user.grants).some((grant) => grant.sections !== undefined)
            ? <p>Any area limits are removed. Every ability in the new level applies across the whole site, including abilities previously limited to particular areas.</p> : null}
          <details><summary>Review abilities added and removed</summary>
            {added.length ? <><p>Adds across the whole site:</p><ul>{added.map((capability) => <li key={capability}>{CAPABILITY_LABELS[capability]}</li>)}</ul></> : null}
            {removed.length ? <><p>No longer able to:</p><ul>{removed.map((capability) => <li key={capability}>{CAPABILITY_LABELS[capability]}</li>)}</ul></> : null}
            {!added.length && !removed.length ? <p>The available abilities stay the same. Any area limits are removed.</p> : null}
          </details>
        </> : null}
        {stale ? <InlineMessage tone="warning" title="Access changed">Cancel and review the current row before making another change.</InlineMessage> : null}
        <div className="staff-level-actions">
          <Button aria-label={`${submitting ? "Saving access" : "Confirm level"} for ${userLabel}`} disabled={!editing.tier || stale || !active || self || submitting || editing.tier === user.accessTier} onClick={() => void apply()}>
            {submitting ? "Saving access" : "Confirm level"}
          </Button>
          <Button variant="ghost" disabled={submitting} onClick={() => { setEditing(null); setReturnFocus("edit"); }}>Cancel</Button>
        </div>
      </div> : null}
      {message ? <InlineMessage className="staff-access-message" tone={message.error ? "error" : "success"} title={message.error ? "Access change needs attention" : "Access updated"}>
        {message.text}
        <Button variant="ghost" aria-label={`Dismiss access message for ${userLabel}`} onClick={() => { setMessage(null); setReturnFocus("edit"); }}>Dismiss</Button>
      </InlineMessage> : null}
    </div></td>
    {canManage ? <td data-label="Actions">
      <div className="staff-level-actions">
        {onDeactivate && (active || shutdown.action) ? <Button ref={attachDeactivateButton} variant={active || shutdown.action === "retry" ? "danger" : "secondary"} disabled={self || submitting || editing !== null || reactivating !== null}
          aria-label={`${active ? "Deactivate" : shutdown.action === "retry" ? "Retry offboarding for" : "Check offboarding for"} ${userLabel}`}
          onClick={() => { setOffboarding(true); setMessage(null); }}>
          {active ? "Deactivate" : shutdown.action === "retry" ? "Retry offboarding" : "Check offboarding"}
        </Button> : null}
        {onReactivate && !active && !reactivating ? <Button ref={reactivateButton} disabled={self || submitting || offboarding}
          aria-label={`Reactivate ${userLabel}`}
          onClick={() => { setReactivating("viewer"); setOffboarding(false); setMessage(null); }}>
          Reactivate
        </Button> : null}
      </div>
      {offboarding && canManage ? <div className="staff-level-change" role="group" aria-label={`Confirm deactivation for ${userLabel}`}>
        <p>Remove all Boardwalk access, withdraw the public profile, disable sign-in and revoke active sessions.</p>
        <Button autoFocus variant="danger" aria-label={`${submitting ? "Shutting down access" : "Confirm deactivation"} for ${userLabel}`} disabled={self || submitting} onClick={() => void deactivate()}>{submitting ? "Shutting down access" : "Confirm deactivation"}</Button>
        <Button variant="ghost" disabled={submitting} onClick={() => { setOffboarding(false); setReturnFocus("deactivate"); }}>Cancel</Button>
      </div> : null}
      {reactivating && canManage ? <div className="staff-level-change" role="group" aria-label={`Confirm reactivation for ${userLabel}`}>
        <Select autoFocus aria-label={`Access level after reactivation for ${userLabel}`} value={reactivating} disabled={submitting}
          onChange={(event) => {
            const tier = event.target.value;
            if (isAccessTier(tier)) setReactivating(tier);
          }}>
          {ACCESS_TIERS.map((tier) => <option key={tier} value={tier}>{ACCESS_TIER_TEXT[tier].name}</option>)}
        </Select>
        <p>Turn sign-in back on and give one whole-site level: {ACCESS_TIER_TEXT[reactivating].name}. {ACCESS_TIER_TEXT[reactivating].summary}</p>
        <p>Old roles and area grants do not come back. The public author profile and shared navigation stay off until someone restores them.</p>
        <div className="staff-level-actions">
          <Button aria-label={`${submitting ? "Reactivating account" : "Confirm reactivation"} for ${userLabel}`} disabled={self || submitting} onClick={() => void reactivate()}>
            {submitting ? "Reactivating account" : "Confirm reactivation"}
          </Button>
          <Button variant="ghost" disabled={submitting} onClick={() => { setReactivating(null); setReturnFocus("deactivate"); }}>Cancel</Button>
        </div>
      </div> : null}
    </td> : null}
  </tr>;
}

export function StaffLevelsTable({ users, sectionIds, ...rowProps }: {
  users: AdminUserRecord[];
  canManage: boolean;
  currentUserId?: string;
  onSetLevel: (request: StaffAccessLevelRequest) => Promise<void>;
  onDeactivate?: (targetUid: string) => void | Promise<void>;
  onReactivate?: (request: ReactivateStaffRequest) => Promise<void>;
  sectionIds: ReadonlySet<string>;
}) {
  const [filter, setFilter] = useState("");
  const id = useId();
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(new Set());
  const onPin = useCallback((uid: string, pinned: boolean) => setPinnedIds((current) => {
    if (current.has(uid) === pinned) return current;
    const next = new Set(current);
    if (pinned) next.add(uid); else next.delete(uid);
    return next;
  }), []);
  const focusSearch = useCallback(() => document.getElementById(id)?.focus(), [id]);
  // Each row keeps an open confirmation or in-flight request visible even when
  // the search changes. Other rows remain mounted with their local state intact.
  const matches = (user: AdminUserRecord) => [user.displayName, user.email, user.id]
    .some((value) => value?.toLowerCase().includes(filter.trim().toLowerCase()));
  const visible = (user: AdminUserRecord) => matches(user) || pinnedIds.has(user.id);
  return <div className="users-table-surface">
    <details className="staff-role-explanations"><summary>What each level can do</summary>
      {ACCESS_TIERS.map((tier) => <div key={tier}><h3>{ACCESS_TIER_TEXT[tier].name}</h3><p>{ACCESS_TIER_TEXT[tier].summary}</p></div>)}
    </details>
    <div className="users-table-filter" role="search">
      <label className="users-table-filter-label" htmlFor={id}>Find a staff member</label>
      <TextInput id={id} type="search" placeholder="Name or email" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <p className="users-table-filter-count">{users.filter(visible).length} of {users.length} shown</p>
    </div>
    {users.length === 0 ? <EmptyState title="No staff accounts found" description="Staff profiles appear after their first approved sign-in." /> :
      <TableFrame><table className="data-table users-table staff-levels-table" aria-label="Staff access">
        <thead><tr><th scope="col">Staff member</th><th scope="col">Account state</th><th scope="col">Access level</th>{rowProps.canManage ? <th scope="col">Actions</th> : null}</tr></thead>
        <tbody>{users.map((user) => <StaffLevelRow key={user.id} user={user} matches={matches(user)} onPin={onPin} focusSearch={focusSearch} sectionIds={sectionIds} {...rowProps} />)}</tbody>
      </table></TableFrame>}
    {users.length > 0 && !users.some(visible) ? <EmptyState title="No staff member matches" description="Try a different name or email." action={<Button onClick={() => setFilter("")}>Clear the search</Button>} /> : null}
  </div>;
}
