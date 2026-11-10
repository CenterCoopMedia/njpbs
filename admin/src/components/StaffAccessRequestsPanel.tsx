import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  decideStaffAccessRequest,
  listStaffAccessRequests,
  type PendingStaffAccessRequest,
} from "../lib/functions";
import {
  Button,
  InlineMessage,
  Panel,
  Select,
  StatusBadge,
} from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

import { ROLE_TEXT } from "../lib/role-text";
import { RoleExplanation } from "./RoleExplanation";

type ApprovalRole = "staff" | "editor" | "contributor";
type Confirmation = {
  request: PendingStaffAccessRequest;
  decision: "approve" | "deny";
};

function requestTime(value: string | null): string {
  if (!value) return "Time unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Time unavailable";
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function StaffAccessRequestsPanel({ tiersActive = false }: { tiersActive?: boolean }) {
  const { getIdToken } = useAuth();
  const [requests, setRequests] = useState<PendingStaffAccessRequest[]>([]);
  const [roles, setRoles] = useState<Record<string, ApprovalRole>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [pendingUid, setPendingUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getIdToken();
      const response = await listStaffAccessRequests(token);
      setRequests(response.requests);
      setHasLoaded(true);
      setRoles((current) => {
        const next = { ...current };
        for (const request of response.requests) {
          next[request.uid] ??= "staff";
        }
        return next;
      });
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The request queue could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  }, [getIdToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide() {
    if (!confirmation || pendingUid) return;
    const { request, decision } = confirmation;
    setPendingUid(request.uid);
    setError(null);
    setSuccess(null);
    try {
      const token = await getIdToken();
      const role = roles[request.uid] ?? "staff";
      await decideStaffAccessRequest(token, {
        targetUid: request.uid,
        requestVersion: request.requestVersion,
        decision,
        ...(decision === "approve" ? { role } : {}),
      });
      setRequests((current) =>
        current.filter((item) => item.uid !== request.uid),
      );
      setSuccess(
        decision === "approve"
          ? `${request.email} now has ${ROLE_TEXT[role].name} access.`
          : `${request.email} was not approved.`,
      );
      setConfirmation(null);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "The request decision failed",
      );
    } finally {
      setPendingUid(null);
    }
  }

  return (
    <section
      className="staff-request-surface"
      aria-labelledby="staff-request-heading"
    >
      <div className="surface-intro">
        <div>
          <h2 id="staff-request-heading">Account requests</h2>
          <p>
            Approve staff guide access or a CMS authoring role. {tiersActive ? "An Owner" : "A Site owner"} makes this decision.
          </p>
          {tiersActive ? <p>Approvals use existing roles. After approval, use Edit in the staff directory to choose one whole-site level. The existing Editor role can publish; the Editor level cannot.</p> : null}
        </div>
        <StatusBadge
          tone={
            !loading && hasLoaded && requests.length > 0 ? "pending" : "neutral"
          }
        >
          {loading
            ? "Checking queue"
            : hasLoaded
              ? `${requests.length} pending`
              : "Queue unavailable"}
        </StatusBadge>
      </div>

      {loading ? (
        <LoadingIndicator
          label="Loading account requests"
          stages={[
            "Asking the CMS for open access requests",
            "Reading each request's reason and decision state",
          ]}
        />
      ) : null}
      {error ? (
        <InlineMessage tone="error" title="Account request action failed">
          <span>{error}</span>
          <Button onClick={() => void load()}>Try again</Button>
        </InlineMessage>
      ) : null}
      {success ? <InlineMessage tone="success">{success}</InlineMessage> : null}

      {!loading && hasLoaded && requests.length === 0 ? (
        <Panel tone="soft">
          <p>No account requests need a decision.</p>
        </Panel>
      ) : null}

      <div className="staff-request-list">
        {requests.map((request) => {
          const role = roles[request.uid] ?? "staff";
          const confirming = confirmation?.request.uid === request.uid;
          return (
            <Panel className="staff-request-card" key={request.uid}>
              <div className="staff-request-heading">
                <div>
                  <h3>{request.displayName || request.email}</h3>
                  {request.displayName ? <p>{request.email}</p> : null}
                </div>
                <StatusBadge tone="pending">Pending</StatusBadge>
              </div>
              <dl className="staff-request-details">
                <div>
                  <dt>Requested</dt>
                  <dd>{requestTime(request.requestedAt)}</dd>
                </div>
                <div>
                  <dt>Reference</dt>
                  <dd>{request.reference}</dd>
                </div>
                <div>
                  <dt>Reason</dt>
                  <dd>{request.reason}</dd>
                </div>
              </dl>
              <div className="staff-request-decision">
                <div className="staff-request-role-field">
                  <label htmlFor={`request-role-${request.uid}`}>
                    {tiersActive ? "Existing role on approval" : "Approved role"}
                  </label>
                  <Select
                    aria-describedby={`request-role-help-${request.uid}`}
                    disabled={Boolean(pendingUid)}
                    id={`request-role-${request.uid}`}
                    onChange={(event) =>
                      setRoles((current) => ({
                        ...current,
                        [request.uid]: event.target.value as ApprovalRole,
                      }))
                    }
                    value={role}
                  >
                    <option value="staff">
                      Viewer — guide and audio
                    </option>
                    <option value="contributor">
                      Writer — create own drafts
                    </option>
                    <option value="editor">
                      Editor — edit and publish site content
                    </option>
                  </Select>
                  <small id={`request-role-help-${request.uid}`}>
                    {ROLE_TEXT[role].summary}
                  </small>
                  <details>
                    <summary>Can and cannot</summary>
                    <RoleExplanation role={role} headingLevel={4} />
                  </details>
                </div>
                <div className="button-row staff-request-actions">
                  <Button
                    disabled={Boolean(pendingUid)}
                    onClick={() =>
                      setConfirmation({ request, decision: "approve" })
                    }
                    variant="primary"
                  >
                    Review approval
                  </Button>
                  <Button
                    disabled={Boolean(pendingUid)}
                    onClick={() =>
                      setConfirmation({ request, decision: "deny" })
                    }
                    variant="danger"
                  >
                    Review rejection
                  </Button>
                </div>
              </div>
              {confirming ? (
                <InlineMessage
                  tone="warning"
                  title={
                    confirmation.decision === "approve"
                      ? `Confirm ${ROLE_TEXT[role].name} access`
                      : "Confirm rejection"
                  }
                >
                  <p>
                    {confirmation.decision === "approve"
                      ? role === "staff"
                        ? `${request.email} will be able to open the private Boardwalk guide and browse audio in authorized categories. No CMS authoring or administration permission will be created.`
                        : `${request.email} will be able to sign in with ${ROLE_TEXT[role].name} permissions. No Manager or Site owner role will be created.`
                      : `${request.email} will not receive staff access.`}
                  </p>
                  <div className="button-row">
                    <Button
                      disabled={pendingUid === request.uid}
                      onClick={() => void decide()}
                      variant={
                        confirmation.decision === "approve"
                          ? "primary"
                          : "danger"
                      }
                    >
                      {pendingUid === request.uid
                        ? "Saving decision"
                        : confirmation.decision === "approve"
                          ? "Approve account"
                          : "Reject account"}
                    </Button>
                    <Button
                      disabled={pendingUid === request.uid}
                      onClick={() => setConfirmation(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </InlineMessage>
              ) : null}
            </Panel>
          );
        })}
      </div>
    </section>
  );
}
