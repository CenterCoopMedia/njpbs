import { can, type Principal } from "../../../packages/content-core/src/rbac";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";
import { RECORD_KINDS } from "./content-vocab";
import {
  browserEditorWorkStorage,
  clearRecoveredWork,
  editorWorkRecoveryKey,
  readRecoveredWork,
  writeRecoveredWork,
} from "./editor-work-recovery";

const RECOVERY_CHANGED_EVENT = "boardwalk-new-record-recovery-changed";

export interface HeldNewRecord {
  id: string;
  record: Record<string, unknown>;
  createNonce?: string;
  savedAtMs: number;
}

export function newRecordDraftKey(kind: RecordKind): string {
  return `record:${kind}:+`;
}

export function heldNewRecords(actorId: string, kind: RecordKind): HeldNewRecord[] {
  const storage = browserEditorWorkStorage();
  if (!storage) return [];
  const actorPrefix = editorWorkRecoveryKey(actorId, "");
  const prefix = `${actorPrefix}${newRecordDraftKey(kind)}:`;
  const drafts: HeldNewRecord[] = [];
  try {
    // A TTL check can remove a row while this scan is in progress.
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const stored = readRecoveredWork(storage, actorId, key.slice(actorPrefix.length));
      const payload = stored?.payload as Partial<HeldNewRecord> | null | undefined;
      const record = payload?.record;
      if (!stored || !record || typeof record !== "object" || Array.isArray(record) || record.id ||
          (record.section != null && typeof record.section !== "string")) continue;
      drafts.push({
        id: key.slice(prefix.length), record, savedAtMs: stored.savedAtMs,
        createNonce: typeof payload?.createNonce === "string" ? payload.createNonce : undefined,
      });
    }
  } catch {
    return [];
  }
  return drafts.sort((left, right) => right.savedAtMs - left.savedAtMs || left.id.localeCompare(right.id));
}

export function holdNewRecord(
  actorId: string,
  kind: RecordKind,
  record: Record<string, unknown>,
  createNonce?: string,
  id = crypto.randomUUID(),
) {
  const storage = browserEditorWorkStorage();
  if (!storage) return;
  if (!writeRecoveredWork(storage, {
    actorId,
    surfaceKey: `${newRecordDraftKey(kind)}:${id}`,
    label: "",
    savedAtMs: Date.now(),
    payload: { record, createNonce: createNonce ?? id },
  })) return;
  window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT));
}

export function clearHeldNewRecord(actorId: string, kind: RecordKind, id: string, savedAtMs: number) {
  const storage = browserEditorWorkStorage();
  const key = `${newRecordDraftKey(kind)}:${id}`;
  if (!storage || readRecoveredWork(storage, actorId, key)?.savedAtMs !== savedAtMs) return;
  clearRecoveredWork(storage, actorId, key);
  window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT));
}

export function subscribeToHeldNewRecords(listener: () => void): () => void {
  window.addEventListener("storage", listener);
  window.addEventListener(RECOVERY_CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(RECOVERY_CHANGED_EVENT, listener);
  };
}

export function heldNewRecordKinds(actorId: string): string {
  return RECORD_KINDS.filter(kind => heldNewRecords(actorId, kind).length > 0).join(" ");
}

export function canCreateEditableRecord(principal: Principal, section?: string, unassignedPost = false): boolean {
  const resource = section ? { section, ownerId: principal.id }
    : { ownerId: principal.id, unassignedDraft: unassignedPost };
  return can(principal, "content.create", resource) &&
    (can(principal, "content.edit.own", resource) || can(principal, "content.edit.any", resource));
}
