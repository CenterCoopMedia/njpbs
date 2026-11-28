import { collection, limit, onSnapshot, query } from "firebase/firestore";
import { STAFF_LISTENER_LIMIT } from "../lib/listener-limits";
import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { db } from "../lib/firebase";
import {
  deactivateStaff,
  reactivateStaff,
  type ReactivateStaffRequest,
  setStaffAccessLevel,
  type StaffAccessLevelRequest,
} from "../lib/functions";
import { accessStateFromUserDoc, type CmsUserDoc } from "../lib/principal";
import {
  Button,
  InlineMessage,
  TableFrame,
  StatusBadge,
} from "./ui/Primitives";
import { SkeletonBlock, SkeletonRegion, SkeletonTableRows, SkeletonText, type SkeletonCell } from "./ui/Skeleton";
import { StaffLevelsTable, type AdminUserRecord } from "./StaffLevelsTable";

function userFromDoc(id: string, data: CmsUserDoc): AdminUserRecord {
  return {
    id,
    // Profiles created before revocable sessions shipped have no `active` field. The
    // server treats only explicit false as inactive, so the roster mirrors that contract.
    active: data.active !== false,
    email: typeof data.email === "string" ? data.email : null,
    displayName:
      typeof data.displayName === "string" ? data.displayName : null,
    ...(Object.hasOwn(data, "accessTier") ? { accessTier: data.accessTier } : {}),
    accessState: accessStateFromUserDoc(data),
    offboarding: data.offboarding,
  };
}

export function UsersTab({ canManage }: { canManage: boolean }) {
  const { getIdToken, state } = useAuth();
  const currentUserId =
    state.status === "signed-in" ? state.user.uid : undefined;
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    return onSnapshot(
      query(collection(db, "users"), limit(STAFF_LISTENER_LIMIT + 1)),
      (snapshot) => {
        if (snapshot.docs.length > STAFF_LISTENER_LIMIT) {
          setLoading(false);
          setLoadError("The staff directory exceeds its read limit. Contact a Site owner.");
          return;
        }
        const nextUsers = snapshot.docs
          .map((userDoc) =>
            userFromDoc(userDoc.id, userDoc.data() as CmsUserDoc),
          )
          .sort((a, b) => (a.email || a.id).localeCompare(b.email || b.id));
        setUsers(nextUsers);
        setLoading(false);
        setLoadError(null);
      },
      (snapshotError) => {
        setLoading(false);
        setLoadError(snapshotError.message);
      },
    );
  }, [attempt]);

  async function applyDeactivation(targetUid: string) {
    const token = await getIdToken();
    await deactivateStaff(token, targetUid);
  }

  async function applyReactivation(request: ReactivateStaffRequest) {
    await reactivateStaff(await getIdToken(), request);
  }

  async function applyLevel(request: StaffAccessLevelRequest) {
    await setStaffAccessLevel(await getIdToken(), request);
  }

  return (
    <section className="users-surface" aria-labelledby="users-heading">
      <div className="surface-intro">
        <div>
          <h2 id="users-heading">Staff directory</h2>
          <p>Review each person's whole-site access level.</p>
        </div>
        <StatusBadge tone={canManage ? "brand" : "neutral"}>
          {canManage ? "Access management" : "View only"}
        </StatusBadge>
      </div>
      {!canManage ? (
        <InlineMessage tone="info" title="Staff access is view only">
          You can review account levels. An Owner must change access or deactivate accounts.
        </InlineMessage>
      ) : null}
      {loading ? <UsersTableSkeleton canManage={canManage} /> : null}
      {loadError ? (
        <InlineMessage tone="error" title="Staff directory could not be loaded">
          <span>{loadError} No staff accounts were changed.</span>
          <Button
            onClick={() => {
              setAttempt((value) => value + 1);
            }}
          >
            Try loading staff accounts again
          </Button>
        </InlineMessage>
      ) : null}
      {!loading && !loadError ? (
        <StaffLevelsTable
          canManage={canManage}
          currentUserId={currentUserId}
          onDeactivate={applyDeactivation}
          users={users}
          onSetLevel={applyLevel}
          onReactivate={applyReactivation}
        />
      ) : null}
    </section>
  );
}

// The staff cell keeps the loaded identity markup: the 2.4rem avatar beside the name and email.
const USER_SKELETON_COLUMNS: SkeletonCell[] = [
  {
    kind: "custom",
    content: (
      <div className="user-identity">
        <SkeletonBlock width="2.4rem" height="2.4rem" radius="round" style={{ flex: "0 0 2.4rem" }} />
        <span>
          <strong className="content-title"><SkeletonText width="9rem" /></strong>
          <small><SkeletonText width="12rem" /></small>
        </span>
      </div>
    ),
  },
  { kind: "chip" },
  { kind: "chip", width: 96 },
];

// The staff directory's frame while its snapshot loads: the search row, then the table header
// over skeleton rows.
export function UsersTableSkeleton({ canManage }: { canManage: boolean }) {
  const headings = ["Staff member", "Account state", "Access level", ...(canManage ? ["Actions"] : [])];
  const accessColumns = USER_SKELETON_COLUMNS;
  const columns: SkeletonCell[] = canManage
    ? [
        ...accessColumns,
        {
          kind: "custom",
          content: (
            <SkeletonBlock
              style={{ minWidth: 144 }}
              height="var(--studio-control-height, var(--target-comfortable))"
              radius="control"
            />
          ),
        },
      ]
    : accessColumns;
  return (
    <SkeletonRegion label="Loading staff accounts" className="users-table-surface">
      <div className="users-table-filter">
        <span className="users-table-filter-label">Find a staff member</span>
        <SkeletonBlock height="var(--cms-control-height)" radius="control" />
        <SkeletonBlock className="users-table-filter-count" width={112} height="1lh" />
      </div>
      <TableFrame tabIndex={-1}>
        <table className="data-table users-table staff-levels-table">
          <thead>
            <tr>{headings.map((heading) => <th key={heading}>{heading}</th>)}</tr>
          </thead>
          <tbody>
            <SkeletonTableRows columns={columns} rows={6} headings={headings} />
          </tbody>
        </table>
      </TableFrame>
    </SkeletonRegion>
  );
}
