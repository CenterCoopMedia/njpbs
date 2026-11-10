import { useEffect, useRef, useState } from "react";
import type { AssignContentRequest } from "../lib/functions";
import type { AssignableUser } from "../lib/assignments";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  Select,
} from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

interface AssignmentPanelProps {
  recordId: string;
  baseVersion?: number;
  assignee?: string | null;
  canAssign: boolean;
  disabledReason?: string;
  loadAssignableUsers?: () => Promise<AssignableUser[]>;
  onAssign?: (
    request: AssignContentRequest,
  ) => Promise<Record<string, unknown>>;
  onAssigned?: (record: Record<string, unknown>) => void;
  onReload?: () => void;
  onSubmittingChange?: (submitting: boolean) => void;
}

export function AssignmentPanel({
  recordId,
  baseVersion,
  assignee = null,
  canAssign,
  disabledReason,
  loadAssignableUsers,
  onAssign,
  onAssigned,
  onReload,
  onSubmittingChange,
}: AssignmentPanelProps) {
  const currentValue = assignee ?? "";
  // Scope staged input to both the addressed record and the server value it was composed
  // against. EditorWorkspace stays mounted across record routes, so a plain string state would
  // otherwise carry one record's staged assignee into the next. Including the baseline also
  // adopts a same-record refresh without erasing the success message after our own save.
  const [selection, setSelection] = useState({
    recordId,
    baseline: currentValue,
    value: currentValue,
  });
  const selected =
    selection.recordId === recordId && selection.baseline === currentValue
      ? selection.value
      : currentValue;
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(Boolean(loadAssignableUsers));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [mutationResult, setMutationResult] = useState<{
    tone: "success" | "error";
    title: string;
    message: string;
    conflict?: boolean;
  } | null>(null);
  // ContentTab supplies a stable callback, while isolated/test consumers often use an inline
  // async function. Hold the latest callback in a ref so resolving a load and re-rendering cannot
  // treat an equivalent function identity as a brand-new directory request.
  const loadAssignableUsersRef = useRef(loadAssignableUsers);
  loadAssignableUsersRef.current = loadAssignableUsers;
  const hasAssignableUsersLoader = Boolean(loadAssignableUsers);

  useEffect(() => {
    const loadUsers = loadAssignableUsersRef.current;
    if (!loadUsers) {
      setLoading(false);
      setLoadError("The staff directory is not connected in this workspace.");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadUsers()
      .then((nextUsers) => {
        if (cancelled) return;
        setUsers(nextUsers);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(
          error instanceof Error
            ? error.message
            : "The staff directory could not be loaded.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [hasAssignableUsersLoader, loadAttempt]);

  useEffect(
    () => () => onSubmittingChange?.(false),
    [onSubmittingChange],
  );

  const versionUnavailable =
    baseVersion === undefined
      ? "Save this record once before assigning it."
      : null;
  const permissionUnavailable = !canAssign
    ? "Assignment changes are limited to administrators during alpha."
    : null;
  const connectionUnavailable = !onAssign
    ? "Assignment saving is not connected in this workspace."
    : null;
  const unavailableReason =
    disabledReason ??
    permissionUnavailable ??
    versionUnavailable ??
    connectionUnavailable;
  const currentAssigneeIsMissing =
    currentValue !== "" && !users.some((user) => user.id === currentValue);
  const unchanged = selected === currentValue;
  const controlsUnavailable =
    loading ||
    loadError !== null ||
    Boolean(unavailableReason);
  const controlsDisabled = controlsUnavailable || submitting;
  // A browser moves focus away when a focused button becomes natively disabled. After a
  // successful assignment, keep this exact button focusable while exposing its no-op state to
  // assistive technology. A fresh selection clears the result and enables the action again.
  const assignmentCommitted =
    !controlsUnavailable && unchanged && mutationResult?.tone === "success";

  async function submitAssignment() {
    if (
      controlsDisabled ||
      unchanged ||
      !onAssign ||
      baseVersion === undefined
    ) {
      return;
    }
    setSubmitting(true);
    onSubmittingChange?.(true);
    setMutationResult(null);
    try {
      const saved = await onAssign({
        id: recordId,
        baseVersion,
        assignee: selected || null,
      });
      setMutationResult({
        tone: "success",
        title: "Assignment updated",
        message:
          selected === ""
            ? "This record is now unassigned."
            : "This record now appears in the selected staff member's assignment queue.",
      });
      onAssigned?.(saved);
    } catch (error) {
      const conflict =
        typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 409;
      setMutationResult({
        tone: "error",
        title: "Assignment was not changed",
        message:
          error instanceof Error
            ? error.message
            : "The assignment request failed. Try again.",
        conflict,
      });
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  return (
    <Panel className="assignment-panel" aria-labelledby="assignment-heading">
      <div className="assignment-panel-heading">
        <div>
          <h3 id="assignment-heading">Assignment</h3>
        </div>
      </div>

      {loading ? (
        <LoadingIndicator
          label="Loading staff choices"
          stages={["Reading the staff directory", "Filtering to accounts that can take this work"]}
        />
      ) : null}
      {loadError ? (
        <InlineMessage tone="error" title="Staff choices could not be loaded">
          <span>{loadError}</span>
          <Button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            Try loading staff again
          </Button>
        </InlineMessage>
      ) : null}
      {!loading && !loadError ? (
        <div className="assignment-controls">
          <label>
            <span>Assigned staff member</span>
            <Select
              aria-label="Assigned staff member"
              disabled={controlsDisabled}
              onChange={(event) => {
                setSelection({
                  recordId,
                  baseline: currentValue,
                  value: event.target.value,
                });
                setMutationResult(null);
              }}
              value={selected}
            >
              <option value="">Unassigned</option>
              {currentAssigneeIsMissing ? (
                <option value={currentValue}>
                  Current assignee (no longer in the staff directory)
                </option>
              ) : null}
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.label}
                </option>
              ))}
            </Select>
          </label>
          <AsyncActionButton
            {...(assignmentCommitted ? { "aria-disabled": true } : {})}
            disabled={
              controlsUnavailable || (unchanged && !assignmentCommitted)
            }
            label="Update assignment"
            onClick={submitAssignment}
            pending={submitting}
            pendingAnnouncement="Updating assignment."
            pendingLabel="Updating assignment…"
            variant="primary"
          />
        </div>
      ) : null}
      {unavailableReason ? (
        <p className="assignment-disabled-reason">{unavailableReason}</p>
      ) : null}
      {mutationResult ? (
        <InlineMessage
          tone={mutationResult.tone}
          title={mutationResult.title}
        >
          <span>{mutationResult.message}</span>
          {mutationResult.conflict && onReload ? (
            <Button onClick={onReload}>Reload record</Button>
          ) : null}
        </InlineMessage>
      ) : null}
    </Panel>
  );
}
