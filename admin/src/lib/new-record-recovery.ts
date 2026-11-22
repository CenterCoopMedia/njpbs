import { can, type Principal } from "../../../packages/content-core/src/rbac";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";
import { RECORD_KINDS } from "./content-vocab";
import {
  browserEditorWorkStorage,
  clearRecoveredWork,
  readRecoveredWork,
  writeRecoveredWork,
} from "./editor-work-recovery";

const RECOVERY_CHANGED_EVENT = "boardwalk-new-record-recovery-changed";

export interface HeldNewRecord {
  record: Record<string, unknown>;
  createNonce?: string;
  savedAtMs: number;
}

export function newRecordDraftKey(kind: RecordKind): string {
  return `record:${kind}:+`;
}

export function readHeldNewRecord(actorId: string, kind: RecordKind): HeldNewRecord | null {
  const storage = browserEditorWorkStorage();
  if (!storage) return null;
  const stored = readRecoveredWork(storage, actorId, newRecordDraftKey(kind));
  const payload = stored?.payload as Partial<HeldNewRecord> | null | undefined;
  const record = payload?.record;
  if (!stored || !record || typeof record !== "object" || Array.isArray(record) || record.id ||
      (record.section != null && typeof record.section !== "string")) return null;
  return {
    record,
    savedAtMs: stored.savedAtMs,
    createNonce: typeof payload?.createNonce === "string" ? payload.createNonce : undefined,
  };
}

export function holdNewRecord(actorId: string, kind: RecordKind, record: Record<string, unknown>, createNonce?: string) {
  const storage = browserEditorWorkStorage();
  if (!storage) return;
  if (!writeRecoveredWork(storage, {
    actorId,
    surfaceKey: newRecordDraftKey(kind),
    label: "",
    savedAtMs: Date.now(),
    payload: { record, createNonce },
  })) return;
  window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT));
}

export function clearHeldNewRecord(actorId: string, kind: RecordKind, savedAtMs: number) {
  const storage = browserEditorWorkStorage();
  if (!storage || readHeldNewRecord(actorId, kind)?.savedAtMs !== savedAtMs) return;
  clearRecoveredWork(storage, actorId, newRecordDraftKey(kind));
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
  return RECORD_KINDS.filter(kind => readHeldNewRecord(actorId, kind)).join(" ");
}

export function canCreateEditableRecord(principal: Principal, section?: string, unassignedPost = false): boolean {
  const resource = section ? { section, ownerId: principal.id }
    : { ownerId: principal.id, unassignedDraft: unassignedPost };
  return can(principal, "content.create", resource) &&
    (can(principal, "content.edit.own", resource) || can(principal, "content.edit.any", resource));
}
