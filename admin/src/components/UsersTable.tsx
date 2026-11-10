import { Fragment, useId, useState } from "react";
import { ROLE_TEXT, roleDisplayName } from "../lib/role-text";
import { RoleExplanation } from "./RoleExplanation";
import { normalizeGrants, type CmsUserDoc } from "../lib/principal";
import type { Role } from "../../../packages/content-core/src/rbac";
import type { RoleRequest } from "../lib/functions";
import type { ReactivateStaffRequest, StaffAccessLevelRequest } from "../lib/functions";
import { StaffLevelsTable } from "./StaffLevelsTable";
import { staffOffboarding } from "../lib/staff-offboarding";
import {
  SEEDED_CONTENT_SECTIONS,
  sortContentSections,
  type ContentSectionDefinition,
} from "../../../packages/content-core/src/content-sections";
import {
  assessSelfLockout,
  describeAccessChange,
  isNoopAccessChange,
  type AccessChange,
} from "../lib/access-change";
import {
  TextInput,
  Button,
  EmptyState,
  InlineMessage,
  RoleTag,
  Select,
  StatusBadge,
  TableFrame,
} from "./ui/Primitives";
import "../routes/StaffRoute.css";

export interface AdminUserRecord extends CmsUserDoc {
  id: string;
  // Conservative roster-only signal that the raw profile carries any role or grant,
  // including an unknown legacy role the normalized authorization model will not honor.
  // Setup uses this to avoid silently widening existing access to top-level admin.
  hasAnyAccess?: boolean;
  accessState?: string;
}

interface UsersTableProps {
  users: AdminUserRecord[];
  canManage: boolean;
  tiersActive?: boolean;
  onSetLevel?: (request: StaffAccessLevelRequest) => Promise<void>;
  onDeactivate?: (targetUid: string) => void | Promise<void>;
  onReactivate?: (request: ReactivateStaffRequest) => Promise<void>;
  onGrant: (request: RoleRequest) => void | Promise<void>;
  onRevoke: (request: RoleRequest) => void | Promise<void>;
  /**
   * The signed-in user's id. Optional so the presentational component and the design
   * gallery can render without an auth context; when present it powers the self-lockout
   * guard so a person cannot fire a change the server would reject on their own account.
   */
  currentUserId?: string;
  /**
   * The content section registry (#619) the scoped-grant picker offers. Optional so the
   * presentational component and the design gallery render without a Firestore
   * subscription; the seeded desks stand in. The server revalidates every section name,
   * so an out-of-date picker can never widen a grant.
   */
  sections?: readonly ContentSectionDefinition[];
}

function roleLabel(role: AdminUserRecord["role"]): string {
  if (role === "super_admin") return ROLE_TEXT.super_admin.name;
  if (role === "admin") return ROLE_TEXT.admin.name;
  return "No top-level role";
}

// The desks offered in the picker. The registry is the runtime source (#619); the seeded
// table is the fallback for a standalone render and for a registry read that has not
// resolved, so the form is never empty and never accepts a name the server would refuse.
function sectionOptions(
  sections: readonly ContentSectionDefinition[] | undefined,
): ContentSectionDefinition[] {
  const supplied = sections === undefined || sections.length === 0
    ? [...SEEDED_CONTENT_SECTIONS]
    : [...sections];
  return sortContentSections(supplied);
}

// Desks this person still holds a grant for that the registry no longer lists. A grant
// outlives its section: removing a desk from the registry does not rewrite anybody's
// profile, so the stale name sits there until somebody takes it back. The picker has to
// keep offering those ids or the only way to clean one up is revoking the whole role,
// which takes the person's still-valid desks with it. They are revoke-only -- grantRole
// refuses a name outside the registry, which is the behaviour that makes this cleanup
// path necessary in the first place.
function retiredGrantSections(
  grants: AdminUserRecord["grants"],
  available: readonly ContentSectionDefinition[],
): string[] {
  const registered = new Set(available.map((entry) => entry.id));
  const retired = new Set<string>();
  for (const grant of normalizeGrants(grants)) {
    for (const section of grant.sections ?? []) {
      if (!registered.has(section)) retired.add(section);
    }
  }
  return [...retired].sort();
}

function ScopedGrantSummary({ grants }: { grants: AdminUserRecord["grants"] }) {
  const normalizedGrants = normalizeGrants(grants);
  if (normalizedGrants.length === 0) {
    return <span className="role-grant-empty">No role grants</span>;
  }

  return (
    <span className="role-grant-list">
      {normalizedGrants.map((grant, index) => {
      const sections =
        grant.sections === undefined
          ? "Entire site"
          : grant.sections.length > 0
            ? grant.sections.join(", ")
            : "No areas";
        return (
          <span
            className="role-grant-fact"
            key={`${grant.role}:${sections}:${index}`}
          >
            <strong>{roleDisplayName(grant.role)}</strong>
            <small>{sections}</small>
          </span>
        );
      })}
    </span>
  );
}

function userInitials(user: AdminUserRecord): string {
  const source = user.displayName || user.email || user.id;
  return (
    source
      .split(/\s+|@/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "NP"
  );
}

const sectionsValidationMessage =
  "Select at least one area, or choose Entire site.";

function toRoleRequest(targetUid: string, change: AccessChange): RoleRequest {
  const request: RoleRequest = { targetUid, role: change.role };
  if (change.sections !== undefined) request.sections = [...change.sections];
  if (
    change.action === "grant" &&
    change.sections === undefined &&
    (change.role === "staff" || change.role === "editor" || change.role === "contributor")
  ) {
    request.siteWide = true;
  }
  return request;
}

function UserActions({
  user,
  onDeactivate,
  onGrant,
  onRevoke,
  onSubmittingChange,
  currentUserId,
  superAdminCount,
  sections,
}: {
  user: AdminUserRecord;
  onDeactivate: UsersTableProps["onDeactivate"];
  onGrant: UsersTableProps["onGrant"];
  onRevoke: UsersTableProps["onRevoke"];
  onSubmittingChange: (submitting: boolean) => void;
  currentUserId?: string;
  superAdminCount: number;
  sections?: readonly ContentSectionDefinition[];
}) {
  const [role, setRole] = useState<Extract<Role, "editor" | "contributor">>(
    "editor",
  );
  const [scope, setScope] = useState<"site-wide" | "sections">("site-wide");
  const [selectedSections, setSelectedSections] = useState<string[]>([]);
  const availableSections = sectionOptions(sections);
  const retiredSections = retiredGrantSections(user.grants, availableSections);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  // Store only the requested change, never the computed impact or request. The impact,
  // self-lockout verdict, and request are all derived from the current row (`user`) on
  // every render below, so a live snapshot that changes the target's role while the
  // confirmation is open updates the confirmation automatically instead of confirming
  // against a stale role.
  const [pendingChange, setPendingChange] = useState<AccessChange | null>(null);
  const [offboardingPending, setOffboardingPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mutationResult, setMutationResult] = useState<{
    tone: "success" | "error";
    title: string;
    message: string;
  } | null>(null);
  const userLabel = user.email || user.id;
  const active = user.active !== false;
  const shutdown = staffOffboarding(user);

  // Clear any in-progress confirmation and messages. Called before offering a new
  // confirmation and whenever the scoped form changes, so a stale confirm can never
  // linger over a change the person has since edited.
  function resetPrompts() {
    if (submitting) return;
    setValidationMessage(null);
    setPendingChange(null);
    setOffboardingPending(false);
    setMutationResult(null);
  }

  // Stage a confirmation. The self-lockout guard and impact are evaluated at render time
  // from current data, so this only records what the person asked to do; nothing is sent
  // until they confirm.
  function requestChange(change: AccessChange) {
    if (submitting) return;
    setValidationMessage(null);
    setMutationResult(null);
    setOffboardingPending(false);
    setPendingChange(change);
  }

  function requestDeactivation() {
    if (submitting || !onDeactivate) return;
    setValidationMessage(null);
    setMutationResult(null);
    setPendingChange(null);
    setOffboardingPending(true);
  }

  function toggleSection(id: string, checked: boolean) {
    resetPrompts();
    setSelectedSections((current) =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((selected) => selected !== id),
    );
  }

  function requestEditorialChange(action: AccessChange["action"]) {
    if (scope === "site-wide") {
      requestChange({ action, role });
      return;
    }
    // Keep the wire shape the server already validates: a list of section ids, or
    // siteWide. The picker changes how the list is chosen, not what is sent. Order it by
    // the registry, then the retired desks, so the confirmation reads the same way the
    // form does.
    const chosen = [
      ...availableSections.map((entry) => entry.id),
      ...retiredSections,
    ].filter((id) => selectedSections.includes(id));
    if (chosen.length === 0) {
      setPendingChange(null);
      setMutationResult(null);
      setValidationMessage(sectionsValidationMessage);
      return;
    }
    // A retired desk is a cleanup target, not a scope to hand out: grantRole refuses a
    // name outside the registry, so staging this grant would only buy a server error.
    const retiredChoice = chosen.filter((id) => retiredSections.includes(id));
    if (action === "grant" && retiredChoice.length > 0) {
      setPendingChange(null);
      setMutationResult(null);
      setValidationMessage(
        `Areas that are no longer registered can only be revoked: ${retiredChoice.join(", ")}.`,
      );
      return;
    }
    requestChange({ action, role, sections: chosen });
  }

  async function confirmChange() {
    if (!pendingChange || submitting) return;
    // Re-check against current data at submit time. A live change between the last render
    // and this click could have made the request blocked or a no-op; the render already
    // reflects that, and this guard makes sure a stale click can never slip it through.
    const verdict = assessSelfLockout({
      actingUserId: currentUserId,
      targetUserId: user.id,
      change: pendingChange,
      superAdminCount,
    });
    if (verdict.severity === "blocked") return;
    if (pendingChange.action === "grant" && pendingChange.role === user.role) return;

    const request = toRoleRequest(user.id, pendingChange);
    const action = pendingChange.action;
    setMutationResult(null);
    setSubmitting(true);
    onSubmittingChange(true);
    try {
      if (action === "grant") {
        await onGrant(request);
      } else {
        await onRevoke(request);
      }
      setPendingChange(null);
      setMutationResult({
        tone: "success",
        title: `Access updated for ${userLabel}`,
        message: action === "grant" ? "Role grant saved." : "Role removal saved.",
      });
    } catch (requestError) {
      setMutationResult({
        tone: "error",
        title: `Access for ${userLabel} could not be updated`,
        message:
          requestError instanceof Error
            ? requestError.message
            : "The role service did not return an error message.",
      });
    } finally {
      setSubmitting(false);
      onSubmittingChange(false);
    }
  }

  async function confirmDeactivation() {
    if (
      !offboardingPending ||
      submitting ||
      !onDeactivate ||
      currentUserId === user.id
    ) {
      return;
    }

    setMutationResult(null);
    setSubmitting(true);
    onSubmittingChange(true);
    try {
      await onDeactivate(user.id);
      setOffboardingPending(false);
      setMutationResult({
        tone: "success",
        title: `Account deactivated for ${userLabel}`,
        message: "CMS access and active sessions were disabled.",
      });
    } catch (requestError) {
      setMutationResult({
        tone: "error",
        title: `Offboarding for ${userLabel} needs attention`,
        message:
          requestError instanceof Error
            ? requestError.message
            : "The offboarding service did not return an error message.",
      });
    } finally {
      setSubmitting(false);
      onSubmittingChange(false);
    }
  }

  function cancelChange() {
    if (submitting) return;
    setPendingChange(null);
    setOffboardingPending(false);
    setMutationResult(null);
  }

  // Derive everything the confirmation shows from the current row on every render, so a
  // live role change updates an open dialog and confirm-time display always matches
  // current state. Precedence: a self-lockout block is shown first (it is the reason the
  // request cannot proceed at all); then a no-op (the grant would set the role the target
  // already holds); otherwise the capability impact, including the demotion warning.
  const pendingVerdict = pendingChange
    ? assessSelfLockout({
        actingUserId: currentUserId,
        targetUserId: user.id,
        change: pendingChange,
        superAdminCount,
      })
    : null;
  const pendingBlockedReason =
    pendingVerdict && pendingVerdict.severity === "blocked"
      ? pendingVerdict.reason
      : null;
  // The grants the row was rendered from. Both questions below are asked against them
  // rather than against the change alone, because a confirmation left open while another
  // admin edits the same account is exactly when the two disagree.
  const userGrants = normalizeGrants(user.grants);
  // A change the server would apply nothing for: a re-grant of the role already held, a
  // revoke of a top-level role the target does not hold (refused with a 409), or a
  // full-role revoke of a role they hold no grants for. Say so instead of advertising an
  // effect that will be refused or silently dropped. See isNoopAccessChange.
  const pendingIsNoop =
    pendingChange !== null &&
    !pendingBlockedReason &&
    isNoopAccessChange(pendingChange, user.role, userGrants);
  const pendingImpact =
    pendingChange && !pendingBlockedReason && !pendingIsNoop
      ? describeAccessChange(pendingChange, user.role, userGrants)
      : null;
  const offboardingBlockedReason =
    offboardingPending && currentUserId === user.id
      ? "You cannot deactivate your own staff account. Ask another Site owner to complete offboarding."
      : null;

  return (
    <div className="access-editor" aria-busy={submitting}>
      <div
        className="access-editor-section access-editor-administration"
        hidden={!active}
      >
        <div>
          <h3>Administrative roles</h3>
          <p><strong>Manager:</strong> {ROLE_TEXT.admin.summary}</p>
          <p><strong>Site owner:</strong> {ROLE_TEXT.super_admin.summary}</p>
        </div>
        <div className="access-action-grid">
          <Button
            disabled={submitting}
            onClick={() => requestChange({ action: "grant", role: "admin" })}
          >
            Grant Manager
          </Button>
          <Button
            disabled={submitting}
            variant="danger"
            onClick={() => requestChange({ action: "revoke", role: "admin" })}
          >
            Revoke Manager
          </Button>
          <Button
            disabled={submitting}
            onClick={() => requestChange({ action: "grant", role: "super_admin" })}
          >
            Grant Site owner
          </Button>
          <Button
            disabled={submitting}
            variant="danger"
            onClick={() => requestChange({ action: "revoke", role: "super_admin" })}
          >
            Revoke Site owner
          </Button>
        </div>
      </div>

      <div
        className="access-editor-section access-editor-guide"
        hidden={!active}
      >
        <div>
          <h3>Viewer access</h3>
          <p>{ROLE_TEXT.staff.summary}</p>
        </div>
        <div className="button-row">
          <Button
            disabled={submitting}
            onClick={() => requestChange({ action: "grant", role: "staff" })}
          >
            Grant Viewer
          </Button>
          <Button
            disabled={submitting}
            variant="danger"
            onClick={() => requestChange({ action: "revoke", role: "staff" })}
          >
            Revoke Viewer
          </Button>
        </div>
      </div>

      <div className="access-editor-section scoped-access-editor" hidden={!active}>
        <div>
          <h3>Editorial roles</h3>
          <p>Grant Editor or Writer access for the entire site or named areas.</p>
        </div>
        <div className="scoped-form">
          <div className="compact-field">
            <label htmlFor={`role-${user.id}`}>Role</label>
            <Select
              aria-label={`Editorial role for ${userLabel}`}
              id={`role-${user.id}`}
              disabled={submitting}
              value={role}
              onChange={(event) => {
                resetPrompts();
                setRole(event.target.value as Extract<Role, "editor" | "contributor">);
              }}
            >
              <option value="editor">Editor</option>
              <option value="contributor">Writer</option>
            </Select>
            <p>{ROLE_TEXT[role].summary}</p>
          </div>
          <fieldset
            aria-label={`Access scope for ${userLabel}`}
            className="access-scope-field"
            disabled={submitting}
          >
            <legend>Access scope</legend>
            <label className="access-scope-option">
              <input
                aria-describedby={`site-wide-scope-help-${user.id}`}
                aria-label="Entire site"
                checked={scope === "site-wide"}
                name={`scope-${user.id}`}
                onChange={() => {
                  resetPrompts();
                  setScope("site-wide");
                }}
                type="radio"
                value="site-wide"
              />
              <span>
                <strong>Entire site</strong>
                <small id={`site-wide-scope-help-${user.id}`}>
                  Can work across every content area.
                </small>
              </span>
            </label>
            <label className="access-scope-option">
              <input
                aria-describedby={`section-scope-help-${user.id}`}
                aria-label="Named areas"
                checked={scope === "sections"}
                name={`scope-${user.id}`}
                onChange={() => {
                  resetPrompts();
                  setScope("sections");
                }}
                type="radio"
                value="sections"
              />
              <span>
                <strong>Named areas</strong>
                <small id={`section-scope-help-${user.id}`}>
                  Limit access to listed content areas.
                </small>
              </span>
            </label>
          </fieldset>
          {scope === "sections" ? (
            <fieldset
              aria-describedby={`sections-help-${user.id}`}
              aria-invalid={validationMessage !== null}
              aria-label={`Areas for ${userLabel}`}
              className="compact-field scoped-sections-field"
              disabled={submitting}
            >
              <legend>Areas</legend>
              {availableSections.map((entry) => (
                <label className="access-scope-option" key={entry.id}>
                  <input
                    aria-label={entry.label}
                    checked={selectedSections.includes(entry.id)}
                    id={`section-${entry.id}-${user.id}`}
                    onChange={(event) => toggleSection(entry.id, event.target.checked)}
                    type="checkbox"
                    value={entry.id}
                  />
                  <span>
                    <strong>{entry.label}</strong>
                    <small>{entry.description}</small>
                  </span>
                </label>
              ))}
              {retiredSections.map((id) => (
                <label className="access-scope-option access-scope-retired" key={id}>
                  <input
                    aria-label={`${id} (no longer registered)`}
                    checked={selectedSections.includes(id)}
                    id={`section-${id}-${user.id}`}
                    onChange={(event) => toggleSection(id, event.target.checked)}
                    type="checkbox"
                    value={id}
                  />
                  <span>
                    <strong>{id}</strong>
                    <small>No longer registered. Can be revoked, not granted.</small>
                  </span>
                </label>
              ))}
              <small id={`sections-help-${user.id}`}>
                Choose the areas this person can work in.
              </small>
            </fieldset>
          ) : null}
          <p className="access-scope-summary" aria-live="polite">
            {scope === "site-wide"
              ? `Selected role: ${role === "editor" ? "Editor" : "Writer"}. Scope: entire site.`
              : selectedSections.length === 0
                ? `Selected role: ${role === "editor" ? "Editor" : "Writer"}. Scope: no areas selected.`
                : `Selected role: ${role === "editor" ? "Editor" : "Writer"}. Scope: ${selectedSections.length} selected ${selectedSections.length === 1 ? "area" : "areas"}.`}
          </p>
          <div className="scoped-action-row">
            <Button disabled={submitting} onClick={() => requestEditorialChange("grant")}>
              {scope === "site-wide" ? "Grant role" : "Grant selected areas"}
            </Button>
            {scope === "sections" ? (
              // Both revokes take access away, so both wear the danger treatment; a ghost
              // button between a bordered grant and a red revoke read as a disabled control.
              <Button
                disabled={submitting}
                variant="danger"
                onClick={() => requestEditorialChange("revoke")}
              >
                Revoke selected areas
              </Button>
            ) : null}
            <Button
              disabled={submitting}
              variant="danger"
              onClick={() => requestChange({ action: "revoke", role })}
            >
              Revoke full role
            </Button>
          </div>
        </div>
        {validationMessage ? (
          <InlineMessage tone="error">{validationMessage}</InlineMessage>
        ) : null}
      </div>

      {!active ? (
        <InlineMessage tone={shutdown.action === "retry" ? "warning" : "info"} title="This account is inactive">
          Role changes stay unavailable. {shutdown.text}
        </InlineMessage>
      ) : null}

      {onDeactivate && (active || shutdown.action) ? (
        <div className="access-editor-section account-state-editor">
          <div>
            <h3>Account state</h3>
            <p>
              {active
                ? "End CMS access and revoke active sessions."
                : shutdown.text}
            </p>
          </div>
          <div className="account-state-actions">
            <Button
              disabled={submitting}
              variant={active || shutdown.action === "retry" ? "danger" : "secondary"}
              onClick={requestDeactivation}
            >
              {active ? "Deactivate account" : shutdown.action === "retry" ? "Retry offboarding" : "Check offboarding"}
            </Button>
          </div>
        </div>
      ) : null}

      {pendingBlockedReason ? (
        <InlineMessage tone="error" title="This change is blocked">
          {pendingBlockedReason}
        </InlineMessage>
      ) : null}

      {offboardingBlockedReason ? (
        <InlineMessage tone="error" title="This change is blocked">
          {offboardingBlockedReason}
        </InlineMessage>
      ) : null}

      {mutationResult ? (
        <InlineMessage
          aria-label={`${mutationResult.title}. ${mutationResult.message}${
            mutationResult.tone === "error"
              ? " You can try the confirmed change again."
              : ""
          }`}
          className="access-mutation-state"
          tone={mutationResult.tone}
          title={mutationResult.title}
        >
          {mutationResult.message}
          {mutationResult.tone === "error" ? " You can try the confirmed change again." : null}
        </InlineMessage>
      ) : null}

      {pendingIsNoop && pendingChange ? (
        <InlineMessage tone="info" title={`No change for ${userLabel}`}>
          <p>
            {pendingChange.action === "grant"
              ? `${userLabel} already has this role, so the grant would not change their access.`
              : `${userLabel} does not hold this role, so there is nothing to revoke. Their access may have changed since this list was loaded.`}
          </p>
          <div className="access-confirm-actions">
            <Button variant="ghost" onClick={cancelChange}>
              Dismiss
            </Button>
          </div>
        </InlineMessage>
      ) : null}

      {active && pendingChange && pendingImpact ? (
        <div
          className="access-confirm"
          role="group"
          aria-label={`Confirm ${pendingImpact.headline} for ${userLabel}`}
        >
          <p className="sr-only" role="status">
            {submitting
              ? `Updating access for ${userLabel}`
              : `Confirmation ready for ${pendingImpact.headline} access for ${userLabel}`}
          </p>
          <InlineMessage
            tone={
              pendingChange.action === "revoke" || pendingImpact.replacesRole
                ? "warning"
                : "info"
            }
            title={`${pendingImpact.headline} for ${userLabel}`}
          >
            <p>{pendingImpact.summary}</p>
            {pendingImpact.removedCapabilities.length > 0 ? (
              <>
                <p className="access-confirm-list-label">No longer able to:</p>
                <ul className="access-confirm-capabilities access-confirm-removed">
                  {pendingImpact.removedCapabilities.map((capability) => (
                    <li key={capability}>{capability}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {pendingImpact.capabilities.length > 0 ? (
              <>
                {pendingImpact.replacesRole ? (
                  <p className="access-confirm-list-label">Now able to:</p>
                ) : null}
                <ul className="access-confirm-capabilities">
                  {pendingImpact.capabilities.map((capability) => (
                    <li key={capability}>{capability}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {submitting ? (
              <InlineMessage
                className="access-mutation-progress"
                title={`Updating access for ${userLabel}`}
              >
                Keep this row open while the role service finishes.
              </InlineMessage>
            ) : null}
            <div className="access-confirm-actions">
              <Button
                variant={pendingChange.action === "revoke" ? "danger" : "primary"}
                disabled={submitting}
                onClick={confirmChange}
              >
                {submitting
                  ? "Applying the change"
                  : pendingChange.action === "grant"
                    ? "Confirm grant"
                    : "Confirm revoke"}
              </Button>
              <Button variant="ghost" disabled={submitting} onClick={cancelChange}>
                Cancel
              </Button>
            </div>
          </InlineMessage>
        </div>
      ) : null}

      {offboardingPending && !offboardingBlockedReason ? (
        <div
          className="access-confirm"
          role="group"
          aria-label={`Confirm account deactivation for ${userLabel}`}
        >
          <p className="sr-only" role="status">
            {submitting
              ? `Offboarding ${userLabel}`
              : `Confirmation ready for account deactivation for ${userLabel}`}
          </p>
          <InlineMessage
            tone="warning"
            title={active ? `Deactivate ${userLabel}` : `${shutdown.action === "check" ? "Check" : "Retry"} offboarding for ${userLabel}`}
          >
            {active ? (
              <>
                <p>This removes every CMS role and grant.</p>
                <p>It disables their sign-in and revokes active sessions.</p>
              </>
            ) : (
              <p>CMS access is inactive. Complete account shutdown by withdrawing the public profile, disabling sign-in and revoking sessions.</p>
            )}
            {submitting ? (
              <InlineMessage
                className="access-mutation-progress"
                title={`Offboarding ${userLabel}`}
              >
                Keep this row open while sessions shut down.
              </InlineMessage>
            ) : null}
            <div className="access-confirm-actions">
              <Button
                variant="danger"
                disabled={submitting}
                onClick={confirmDeactivation}
              >
                {submitting
                  ? "Shutting down access"
                  : active
                    ? "Deactivate staff account"
                    : shutdown.action === "check" ? "Confirm offboarding" : "Retry session shutdown"}
              </Button>
              <Button variant="ghost" disabled={submitting} onClick={cancelChange}>
                Cancel
              </Button>
            </div>
          </InlineMessage>
        </div>
      ) : null}
    </div>
  );
}

export function UsersTable({
  users,
  canManage,
  onGrant,
  onRevoke,
  onDeactivate,
  currentUserId,
  sections,
  tiersActive = false,
  onSetLevel,
  onReactivate,
}: UsersTableProps) {
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [submittingUserId, setSubmittingUserId] = useState<string | null>(null);
  // A name or address fragment that narrows the roster. The whole roster still arrives; this
  // is how a person finds one account without reading every row or reaching for the browser's
  // find command, the way every other roster-shaped surface in the admin already lets them.
  const [filter, setFilter] = useState("");
  const filterId = useId();
  if (tiersActive) return <StaffLevelsTable users={users} canManage={canManage && Boolean(onSetLevel)}
    sectionIds={new Set(sectionOptions(sections).map((entry) => entry.id))}
    currentUserId={currentUserId} onSetLevel={onSetLevel ?? (async () => {})} onDeactivate={onDeactivate} onReactivate={onReactivate} />;
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  // The row being edited, or one whose request is still in flight, stays on screen whatever
  // the search says: filtering it out would unmount its confirmation, progress, and receipt
  // while the server carried on without them.
  const visibleUsers =
    normalizedFilter === ""
      ? users
      : users.filter(
          (user) =>
            user.id === expandedUserId ||
            user.id === submittingUserId ||
            [user.displayName, user.email, user.id].some((value) =>
              typeof value === "string" && value.toLocaleLowerCase().includes(normalizedFilter),
            ),
        );

  if (users.length === 0) {
    return (
      <EmptyState
        title="No staff accounts found"
        description="Staff profiles will appear after their first approved sign-in."
      />
    );
  }

  // How many accounts hold site-wide super admin, so the self-lockout guard can tell the
  // last super admin (an unrecoverable removal) from a change others could still undo.
  const superAdminCount = users.filter(
    (user) => user.active !== false && user.role === "super_admin",
  ).length;

  return (
    <div className="users-table-surface">
      <details className="staff-role-explanations">
        <summary>What each role can and cannot do</summary>
        {(["staff", "contributor", "editor", "admin", "super_admin"] as const).map((role) => (
          <RoleExplanation key={role} role={role} headingLevel={3} />
        ))}
      </details>
      <div className="users-table-filter" role="search">
        <label className="users-table-filter-label" htmlFor={filterId}>
          Find a staff member
        </label>
        <TextInput
          autoComplete="off"
          id={filterId}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Name or email"
          type="search"
          value={filter}
        />
        <p className="users-table-filter-count" data-testid="users-table-filter-count">
          {normalizedFilter === ""
            ? `${users.length} ${users.length === 1 ? "staff member" : "staff members"}`
            : `${visibleUsers.length} of ${users.length} shown`}
        </p>
      </div>
      {visibleUsers.length === 0 ? (
        <EmptyState
          title="No staff member matches"
          description={`Nothing on the roster matches “${filter.trim()}”.`}
          action={<Button onClick={() => setFilter("")}>Clear the search</Button>}
        />
      ) : (
    <TableFrame>
      <table className="data-table users-table" aria-label="Staff access">
        <thead>
          <tr>
            <th>Staff member</th>
            <th>Account state</th>
            <th>Top-level role</th>
            <th>Role grants</th>
            {canManage ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {visibleUsers.map((user) => {
            const userLabel = user.email || user.id;
            const expanded = expandedUserId === user.id;
            return (
              <Fragment key={user.id}>
                <tr>
                  <td data-label="Staff member">
                    <div className="user-identity">
                      <span className="user-avatar" aria-hidden="true">
                        {userInitials(user)}
                      </span>
                      <span>
                        <strong className="content-title">
                          {user.displayName || "No display name"}
                        </strong>
                        <small>{user.email || "No email"}</small>
                      </span>
                    </div>
                  </td>
                  <td data-label="Account state">
                    <StatusBadge tone={user.active === false ? "neutral" : "brand"}>
                      {user.active === false ? "Inactive" : "Active"}
                    </StatusBadge>
                  </td>
                  <td data-label="Top-level role">
                    <RoleTag assigned={Boolean(user.role)}>{roleLabel(user.role)}</RoleTag>
                  </td>
                  <td data-label="Role grants" className="scoped-grants-cell">
                    <ScopedGrantSummary grants={user.grants} />
                  </td>
                  {canManage ? (
                    <td data-label="Actions">
                      <div className="staff-level-actions">
                        <Button
                          aria-label={expanded ? undefined : `Manage access for ${userLabel}`}
                          aria-controls={`access-editor-${user.id}`}
                          aria-expanded={expanded}
                          disabled={submittingUserId !== null}
                          onClick={() => setExpandedUserId(expanded ? null : user.id)}
                        >
                          {expanded ? "Close access editor" : "Manage access"}
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
                {canManage && expanded ? (
                  <tr className="access-editor-row">
                    <td colSpan={5} id={`access-editor-${user.id}`}>
                      <UserActions
                        user={user}
                        onDeactivate={onDeactivate}
                        onGrant={onGrant}
                        onRevoke={onRevoke}
                        onSubmittingChange={(isSubmitting) =>
                          setSubmittingUserId(isSubmitting ? user.id : null)
                        }
                        currentUserId={currentUserId}
                        superAdminCount={superAdminCount}
                        sections={sections}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableFrame>
      )}
    </div>
  );
}
