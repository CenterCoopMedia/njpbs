import { useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { recordDestination } from "../lib/content-nav";
import { isRecordKind } from "../lib/content-vocab";
import { heldNewRecordKinds, subscribeToHeldNewRecords } from "../lib/new-record-recovery";
import { createRecordPath, parseContentPath } from "../lib/routes";
import { InlineMessage } from "./ui/Primitives";

export function NewRecordRecoveryNotice({ actorId }: { actorId: string }) {
  const { pathname } = useLocation();
  const route = parseContentPath(pathname);
  const held = useSyncExternalStore(subscribeToHeldNewRecords, () => heldNewRecordKinds(actorId));
  const kinds = held.split(" ").filter(isRecordKind).filter(kind => route.kind !== "create-record" || route.type !== kind);
  if (kinds.length === 0) return null;

  return <InlineMessage tone="info" title="Unsaved work from your last session">
    <ul>
      {kinds.map(kind => <li key={kind}>
        <Link to={createRecordPath(kind)}>Review new {recordDestination(kind).label.toLowerCase()}</Link>
      </li>)}
    </ul>
  </InlineMessage>;
}
