import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  decideStaffAccessRequest,
  listStaffAccessRequests,
  type ApprovalAccessTier,
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

import { ACCESS_TIER_TEXT } from "../lib/access-tier-text";

const APPROVAL_TIERS: readonly ApprovalAccessTier[] = ["viewer", "contributor", "editor", "publisher"];
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

export function StaffAccessRequestsPanel() {
  const { getIdToken } = useAuth();
  const [requests, setRequests] = useState<PendingStaffAccessRequest[]>([]);
  const [tiers, setTiers] = useState<Record<string, ApprovalAccessTier>>({});
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
      setTiers((current) => {
        const next = { ...current };
        for (const request of response.requests) {
          next[request.uid] ??= "viewer";
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
      const accessTier = tiers[request.uid] ?? "viewer";
      await decideStaffAccessRequest(token, {
        targetUid: request.uid,
        requestVersion: request.requestVersion,
        decision,
        ...(decision === "approve" ? { accessTier } : {}),
      });
      setRequests((current) =>
        current.filter((item) => item.uid !== request.uid),
      );
      setSuccess(
        decision === "approve"
          ? `${request.email} now has ${ACCESS_TIER_TEXT[accessTier].name} access.`
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
            Approve a request at one whole-site access level. An Owner makes this decision.
          </p>
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
          const tier = tiers[request.uid] ?? "viewer";
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
                    Access level on approval
                  </label>
                  <Select
                    aria-describedby={`request-role-help-${request.uid}`}
                    disabled={Boolean(pendingUid)}
                    id={`request-role-${request.uid}`}
                    onChange={(event) =>
                      setTiers((current) => ({
                        ...current,
                        [request.uid]: event.target.value as ApprovalAccessTier,
                      }))
                    }
                    value={tier}
                  >
                    {APPROVAL_TIERS.map((option) => (
                      <option key={option} value={option}>
                        {ACCESS_TIER_TEXT[option].name}
                      </option>
                    ))}
                  </Select>
                  <small id={`request-role-help-${request.uid}`}>
                    {ACCESS_TIER_TEXT[tier].summary}
                  </small>
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
                      ? `Confirm ${ACCESS_TIER_TEXT[tier].name} access`
                      : "Confirm rejection"
                  }
                >
                  <p>
                    {confirmation.decision === "approve"
                      ? `${request.email} will be able to sign in with ${ACCESS_TIER_TEXT[tier].name} access. No Admin or Owner access will be created.`
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
