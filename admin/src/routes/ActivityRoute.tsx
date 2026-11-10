import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  diffStates,
  type FieldChange,
  type Json,
} from "../../../packages/content-core/src/audit-diff";
import { useAuth } from "../context/AuthContext";
import { canViewAudit } from "../lib/access";
import {
  cmsListAudit,
  type AuditEntry,
  type ListAuditResponse,
  type ResolvedActivity,
} from "../lib/functions";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  Select,
  StatusBadge,
  TextInput,
} from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { Icon, type IconName } from "../components/ui/Icon";
import { RequireCapability } from "./RequireCapability";
import "../workflow-surfaces.css";

const ACTION_LABELS: Record<string, string> = {
  "bug_report.create": "CMS problem reported",
  "bug_report.nudge": "Report follow-up nudge requested",
  "bug_report.nudge_approved": "Report follow-up approved",
  "bug_report.nudge_ignored": "Report nudge ignored",
  "bug_report.acknowledge": "Problem report acknowledged",
  "bug_report.assign": "Problem report assignment changed",
  "bug_report.relate": "Related problem reports changed",
  "bug_report.resolution": "Problem report resolution updated",
  "bug_report.status": "Problem report status changed",
  "bug_report.take_over": "Problem report taken over",
  "cms.assign": "Assignment changed",
  "cms.bulk_archive": "Content deleted",
  "cms.archive": "Content deleted",
  "cms.preview.request": "Preview requested",
  "cms.publish": "Content published",
  "cms.publish-snapshot": "Publish snapshot saved",
  "cms.live-blog-update": "Live blog update requested",
  "cms.save": "Content saved",
  "cms.restore": "Deleted content restored",
  "cms.schedule-publish": "Scheduled content published",
  "cms.schedule-publish-failed": "Scheduled publication failed",
  "cms.unpublish": "Content unpublished",
  "media.metadata.update": "Media details updated",
  // Keep labels for historical rows from the retired onboarding system.
  "onboarding.invite_queue": "Onboarding invitation queued",
  "onboarding.invite_retry": "Onboarding invitation retried",
  "onboarding.plan_save": "Onboarding plan saved",
  "roles.bootstrap": "Site owner bootstrapped",
  "roles.grant": "Role granted",
  "roles.provision": "Staff access provisioned",
  "roles.revoke": "Role revoked",
  "staff.deactivate": "Staff account deactivated",
  "staff.level.replace": "Staff access level replaced",
  "staff.reactivate": "Staff account reactivated",
};

const ACTIVITY_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeStyle: "short",
  timeZone: "America/New_York",
});

const ACTIVITY_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "America/New_York",
});

function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const words = action.replace(/[._-]+/g, " ").trim();
  return words
    ? `${words[0]?.toUpperCase()}${words.slice(1)}`
    : "Unknown action";
}

// The server resolves people and content names at read time (#1038). This map
// stays as the fallback for a browser talking to a server that has not shipped
// that join yet, so the surface degrades to the stored fields rather than to a
// blank row.
function entryActionLabel(entry: AuditEntry): string {
  return entry.resolved?.action.label ?? actionLabel(entry.action);
}

function actorLabel(entry: AuditEntry): string {
  return (
    entry.resolved?.actor.label ??
    entry.actorEmail ??
    entry.actorUid ??
    "Unknown actor"
  );
}

function actorBadge(resolved: ResolvedActivity | undefined): string | null {
  if (resolved?.actor.status === "deactivated") return "Deactivated";
  if (resolved?.actor.status === "deleted") return "Deleted";
  if (resolved?.actor.status === "system") return "Automated";
  return null;
}

// Rows a support conversation needs by exact id. The stored target string is only
// worth repeating here when it is not already the visible label.
function supportDetails(
  entry: AuditEntry,
): readonly { term: string; value: string }[] {
  const rows: { term: string; value: string }[] = [
    { term: "Activity ID", value: entry.id },
    { term: "Recorded timestamp", value: entry.at ?? "Unavailable" },
  ];
  if (entry.resolved?.target.id) {
    rows.push({ term: "Target ID", value: entry.resolved.target.id });
  }
  if (entry.actorUid) rows.push({ term: "Account ID", value: entry.actorUid });
  // The address as it was recorded, which is how an auditor traces an account
  // that has since been renamed or deleted. The server withholds it entirely
  // from a caller who may not see accounts, so this row is simply absent there.
  if (entry.actorEmail) {
    rows.push({ term: "Recorded email", value: entry.actorEmail });
  }
  rows.push({ term: "Action code", value: entry.action });
  const sourceDetail =
    entry.resolved?.source.detail ??
    (typeof entry.source === "string" ? entry.source : null);
  if (sourceDetail) rows.push({ term: "Recorded source", value: sourceDetail });
  if (entry.automation) {
    rows.push({ term: "Staff request", value: entry.automation.requestReference });
    rows.push({ term: "Plan digest", value: entry.automation.planDigest });
  }
  return rows;
}

function textValue(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function evidenceText(value: unknown): string {
  if (value === null || value === undefined) return "No recorded value";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "This evidence could not be displayed.";
  }
}

function formattedTime(at: string | null): string {
  if (!at) return "Time unavailable";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return ACTIVITY_TIME_FORMATTER.format(date);
}

function searchText(entry: AuditEntry): string {
  return [
    entry.action,
    actionLabel(entry.action),
    entryActionLabel(entry),
    entry.resolved?.actor.label,
    entry.resolved?.target.label,
    entry.resolved?.target.type,
    entry.resolved?.source.label,
    entry.actorEmail,
    entry.actorUid,
    textValue(entry.target, ""),
    textValue(entry.source, ""),
    entry.automation?.requestReference,
    evidenceText(entry.before),
    evidenceText(entry.after),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function snapshotForDiff(value: unknown): Json | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value as Json;
  return undefined;
}

function changesFor(entry: AuditEntry): readonly FieldChange[] | null {
  const before = snapshotForDiff(entry.before);
  const after = snapshotForDiff(entry.after);
  if (before === undefined || after === undefined) return null;
  try {
    return diffStates(before, after).changes;
  } catch {
    return null;
  }
}

function changeLabel(change: FieldChange): string {
  if (change.kind === "added") return "Added";
  if (change.kind === "removed") return "Removed";
  return "Changed";
}

function actionIcon(action: string): IconName {
  if (action.startsWith("roles.") || action.startsWith("staff.")) return "users";
  if (action.startsWith("media.")) return "media";
  if (action.includes("archive") || action.includes("unpublish")) return "remove";
  if (action.includes("publish")) return "activity";
  if (action.includes("preview")) return "eye";
  return "file";
}

interface ActivityDay {
  key: string;
  label: string;
  entries: AuditEntry[];
}

function activityDay(at: string | null): { key: string; label: string } {
  if (!at) return { key: "unavailable", label: "Time unavailable" };
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return { key: "unavailable", label: "Time unavailable" };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/New_York",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return {
    key: `${value("year")}-${value("month")}-${value("day")}`,
    label: ACTIVITY_DAY_FORMATTER.format(date),
  };
}

function groupActivityByDay(entries: readonly AuditEntry[]): ActivityDay[] {
  const groups: ActivityDay[] = [];
  const byDay = new Map<string, ActivityDay>();
  for (const entry of entries) {
    const day = activityDay(entry.at);
    const existing = byDay.get(day.key);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    const group = { ...day, entries: [entry] };
    groups.push(group);
    byDay.set(day.key, group);
  }
  return groups;
}

function mergeActivityPages(
  current: readonly AuditEntry[],
  incoming: readonly AuditEntry[],
): AuditEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((left, right) => {
    const leftAt = left.at ? Date.parse(left.at) : Number.NaN;
    const rightAt = right.at ? Date.parse(right.at) : Number.NaN;
    if (Number.isNaN(leftAt)) return Number.isNaN(rightAt) ? 0 : 1;
    if (Number.isNaN(rightAt)) return -1;
    return rightAt - leftAt;
  });
}

function ActivityEvent({
  entry,
  expanded,
  onExpandedChange,
}: {
  entry: AuditEntry;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const badge = actorBadge(entry.resolved);
  const changes = changesFor(entry);
  const target = entry.resolved?.target;
  const targetUid = target?.type === "Staff account"
    ? target.id?.replace(/^(users|cmsStaffRecords)\//, "")
    : null;
  const targetIsActor = Boolean(targetUid && targetUid === entry.resolved?.actor.uid);

  return (
    <li className="activity-card" data-testid="activity-event">
      <span className="activity-event-icon" aria-hidden="true">
        <Icon name={actionIcon(entry.action)} />
      </span>
      <div className="activity-event-copy">
        <div className="activity-card-heading">
          <h4>{entryActionLabel(entry)}</h4>
          {entry.resolved?.action.known === false ? (
            <StatusBadge tone="unknown">Unrecognized action</StatusBadge>
          ) : !entry.resolved ? (
            <StatusBadge tone="unknown">{entry.action}</StatusBadge>
          ) : null}
        </div>
        <p className="activity-event-context">
          <span className="activity-context-item">
            <strong>{actorLabel(entry)}</strong>
            {badge ? (
              <StatusBadge tone="cancelled">{badge}</StatusBadge>
            ) : null}
          </span>
          {target ? (
            <span className="activity-context-item">
              <span className="activity-context-separator" aria-hidden="true">
                ·
              </span>
              {(target.label !== actorLabel(entry) || !targetIsActor) ? (
                <span className="activity-target-name">{target.label}</span>
              ) : null}
              <span className="activity-target-type">{target.type}</span>
              {target.status === "deactivated" || target.status === "deleted" ? (
                <StatusBadge tone="cancelled">
                  {target.status === "deleted" ? "Deleted" : "Deactivated"}
                </StatusBadge>
              ) : null}
            </span>
          ) : (
            <span className="activity-context-item">
              <span className="activity-context-separator" aria-hidden="true">
                ·
              </span>
              {textValue(entry.target, "No target recorded")}
            </span>
          )}
          <span className="activity-context-item">
            <span className="activity-context-separator" aria-hidden="true">
              ·
            </span>
            <span className="activity-source">
              {entry.resolved
                ? entry.resolved.source.label
                : textValue(entry.source, "Not recorded")}
            </span>
          </span>
        </p>
        <details
          className="activity-event-details"
          open={expanded}
          onToggle={(event) => onExpandedChange(event.currentTarget.open)}
        >
          <summary>View event details</summary>
          <div className="activity-event-detail-content">
            <dl className="activity-support-list">
              {supportDetails(entry).map((row) => (
                <div key={row.term}>
                  <dt>{row.term}</dt>
                  <dd>
                    <code>{row.value}</code>
                  </dd>
                </div>
              ))}
            </dl>
            {entry.before !== null || entry.after !== null ? (
              <div className="activity-evidence-content">
                {changes ? (
                  <section aria-labelledby={`changes-${entry.id}`}>
                    <h5 id={`changes-${entry.id}`}>Changed fields</h5>
                    {changes.length > 0 ? (
                      <ol className="activity-change-list">
                        {changes.map((change) => (
                          <li key={change.path}>
                            <div className="activity-change-heading">
                              <code>{change.path}</code>
                              <StatusBadge tone="neutral">
                                {changeLabel(change)}
                              </StatusBadge>
                            </div>
                            <dl className="activity-change-values">
                              {change.kind !== "added" ? (
                                <div>
                                  <dt>Before</dt>
                                  <dd>
                                    <code>{evidenceText(change.before)}</code>
                                  </dd>
                                </div>
                              ) : null}
                              {change.kind !== "removed" ? (
                                <div>
                                  <dt>After</dt>
                                  <dd>
                                    <code>{evidenceText(change.after)}</code>
                                  </dd>
                                </div>
                              ) : null}
                            </dl>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>No field differences were recorded.</p>
                    )}
                  </section>
                ) : null}
                <section aria-labelledby={`raw-evidence-${entry.id}`}>
                  <h5 id={`raw-evidence-${entry.id}`}>Raw evidence</h5>
                  <div className="activity-evidence-grid">
                    <section aria-labelledby={`before-${entry.id}`}>
                      <h6 id={`before-${entry.id}`}>Before</h6>
                      <pre>{evidenceText(entry.before)}</pre>
                    </section>
                    <section aria-labelledby={`after-${entry.id}`}>
                      <h6 id={`after-${entry.id}`}>After</h6>
                      <pre>{evidenceText(entry.after)}</pre>
                    </section>
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </details>
      </div>
      <time
        className="activity-event-time"
        dateTime={entry.at ?? undefined}
        title={entry.at ?? "Time unavailable"}
      >
        {formattedTime(entry.at)}
      </time>
    </li>
  );
}

export type ActivityLoader = (cursor?: string) => Promise<ListAuditResponse>;

export interface ActivitySurfaceProps {
  loadActivity: ActivityLoader;
  initialAction?: string;
  initialExpandedEntryIds?: readonly string[];
}

export function ActivitySurface({
  loadActivity,
  initialAction = "",
  initialExpandedEntryIds = [],
}: ActivitySurfaceProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState(initialAction);
  const [expandedEntryIds, setExpandedEntryIds] = useState(
    () => new Set(initialExpandedEntryIds),
  );
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    let current = true;
    const refresh = hasLoadedRef.current;
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    void loadActivity()
      .then((response) => {
        if (!current) return;
        setEntries(response.entries);
        setNextCursor(response.nextCursor);
        hasLoadedRef.current = true;
        setLoading(false);
        setRefreshing(false);
      })
      .catch((loadError: unknown) => {
        if (!current) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Activity could not be loaded",
        );
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      current = false;
    };
  }, [attempt, loadActivity]);

  const actions = useMemo(() => {
    const labels = new Map<string, string>();
    for (const entry of entries) {
      if (!labels.has(entry.action)) {
        labels.set(entry.action, entryActionLabel(entry));
      }
    }
    return [...labels.entries()]
      .map(([code, label]) => ({ code, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [entries]);
  const filteredEntries = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return entries.filter(
      (entry) =>
        (!action || entry.action === action) &&
        (!normalizedSearch || searchText(entry).includes(normalizedSearch)),
    );
  }, [action, entries, search]);
  const groupedEntries = useMemo(
    () => groupActivityByDay(filteredEntries),
    [filteredEntries],
  );

  async function loadMore() {
    if (!nextCursor || loadingMore || refreshing) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await loadActivity(nextCursor);
      setEntries((current) => mergeActivityPages(current, response.entries));
      setNextCursor(response.nextCursor);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Older activity could not be loaded",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="activity-surface" aria-labelledby="activity-heading">
      <div className="surface-intro">
        <div>
          <h2 id="activity-heading">Administrative activity</h2>
          <p>
            A readable record of server-recorded changes, with original details
            one step away.
          </p>
        </div>
        <AsyncActionButton
          aria-label="Refresh activity"
          disabled={loading || loadingMore}
          label="Refresh"
          pending={refreshing}
          pendingAnnouncement="Refreshing administrative activity."
          pendingLabel="Refreshing…"
          onClick={() => setAttempt((value) => value + 1)}
        />
      </div>

      {loading ? (
        <Panel className="loading-panel">
          <LoadingIndicator
            label="Loading administrative activity"
            stages={[
              "Asking the CMS for the audit log",
              "Reading before-and-after evidence for each entry",
              "Applying your filters",
            ]}
          />
        </Panel>
      ) : null}

      {error ? (
        <InlineMessage
          tone="error"
          title="Administrative activity could not be loaded"
        >
          <span>{error}</span>
          {entries.length === 0 ? (
            <Button onClick={() => setAttempt((value) => value + 1)}>
              Try loading activity again
            </Button>
          ) : null}
        </InlineMessage>
      ) : null}

      {!loading && entries.length > 0 ? (
        <>
          <div
            className="activity-filters"
            role="search"
            aria-label="Filter activity"
          >
            <div className="compact-field activity-search-field">
              <label htmlFor="activity-search">Search activity</label>
              <TextInput
                id="activity-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find an action, person, or page"
              />
            </div>
            <div className="compact-field">
              <label htmlFor="activity-action">Action</label>
              <Select
                id="activity-action"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              >
                <option value="">All actions</option>
                {actions.map((value) => (
                  <option key={value.code} value={value.code}>
                    {value.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="activity-results-meta" aria-live="polite">
            <span>
              {filteredEntries.length === entries.length
                ? `${entries.length} ${entries.length === 1 ? "loaded event" : "loaded events"}`
                : `${filteredEntries.length} of ${entries.length} loaded events match`}
            </span>
            <span>Only loaded activity is grouped and filtered.</span>
          </div>

          {filteredEntries.length === 0 ? (
            <Panel className="activity-empty-panel">
              <p>No activity matches these filters.</p>
            </Panel>
          ) : (
            <Panel className="activity-history" aria-label="Loaded activity">
              <ol className="activity-day-list">
                {groupedEntries.map((group, dayIndex) => {
                  const headingId = `activity-day-${group.key}-${dayIndex}`;
                  return (
                    <li key={`${group.key}-${dayIndex}`}>
                      <section aria-labelledby={headingId}>
                        <h3 id={headingId} className="activity-day-heading">
                          {group.label}
                        </h3>
                        <ol className="activity-event-list">
                          {group.entries.map((entry) => (
                            <ActivityEvent
                              entry={entry}
                              expanded={expandedEntryIds.has(entry.id)}
                              key={entry.id}
                              onExpandedChange={(isOpen) => {
                                setExpandedEntryIds((current) => {
                                  if (current.has(entry.id) === isOpen) {
                                    return current;
                                  }
                                  const next = new Set(current);
                                  if (isOpen) next.add(entry.id);
                                  else next.delete(entry.id);
                                  return next;
                                });
                              }}
                            />
                          ))}
                        </ol>
                      </section>
                    </li>
                  );
                })}
              </ol>
            </Panel>
          )}

          <div className="activity-pagination">
            <span>
              {entries.length} {entries.length === 1 ? "event" : "events"} loaded
              from the server
            </span>
            <AsyncActionButton
              disabled={!nextCursor || refreshing}
              label={nextCursor ? "Load older activity" : "No older activity available"}
              pending={loadingMore}
              pendingAnnouncement="Loading older administrative activity."
              pendingLabel="Loading older activity…"
              reserveLabel="No older activity available"
              onClick={() => void loadMore()}
            />
          </div>
        </>
      ) : null}

      {!loading && !error && entries.length === 0 ? (
        <Panel className="activity-empty-panel">
          <p>No administrative activity has been recorded.</p>
        </Panel>
      ) : null}
    </section>
  );
}

export function ActivityRoute() {
  const { getIdToken } = useAuth();
  const loadActivity = useCallback<ActivityLoader>(
    async (cursor) => {
      const token = await getIdToken();
      return cursor === undefined
        ? cmsListAudit(token)
        : cmsListAudit(token, cursor);
    },
    [getIdToken],
  );

  return (
    <RequireCapability
      allowed={canViewAudit}
      notice="Administrative activity isn't available for your account."
    >
      <ActivitySurface loadActivity={loadActivity} />
    </RequireCapability>
  );
}
