import { describe, expect, it } from "vitest";
import {
  EDITOR_WORK_RECOVERY_TTL_MS,
  clearRecoveredWork,
  editorWorkRecoveryKey,
  readRecoveredWork,
  writeRecoveredWork,
  type RecoveredEditorWork,
} from "../src/lib/editor-work-recovery";

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    store: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
    values,
  };
}

function work(overrides: Partial<RecoveredEditorWork> = {}): RecoveredEditorWork {
  return {
    actorId: "ana",
    surfaceKey: "cmsPages:watch",
    label: "Watch NJ PBS",
    displacedBy: "Bo Editor",
    savedAtMs: 1_000,
    payload: { kind: "page", blocks: [{ id: "b1" }] },
    ...overrides,
  };
}

describe("displaced editor work recovery", () => {
  it("keys a snapshot to one person and one record", () => {
    expect(editorWorkRecoveryKey("ana", "cmsPages:watch")).toBe(
      "njpbs-admin:displaced-work:ana:cmsPages:watch",
    );
    expect(editorWorkRecoveryKey("ana", "cmsPages:watch")).not.toBe(
      editorWorkRecoveryKey("bo", "cmsPages:watch"),
    );
  });

  it("round-trips a displaced draft for the same person and record", () => {
    const { store } = memoryStorage();
    expect(writeRecoveredWork(store, work())).toBe(true);
    expect(readRecoveredWork(store, "ana", "cmsPages:watch", 2_000)).toEqual(work());
  });

  it("never hands one person's displaced draft to another", () => {
    const { store } = memoryStorage();
    writeRecoveredWork(store, work());
    expect(readRecoveredWork(store, "bo", "cmsPages:watch", 2_000)).toBeNull();
    expect(readRecoveredWork(store, "ana", "cmsPosts:story", 2_000)).toBeNull();
  });

  it("drops a snapshot older than the recovery window instead of offering stale work", () => {
    const { store } = memoryStorage();
    writeRecoveredWork(store, work({ savedAtMs: 1_000 }));
    const expired = 1_000 + EDITOR_WORK_RECOVERY_TTL_MS + 1;
    expect(readRecoveredWork(store, "ana", "cmsPages:watch", expired)).toBeNull();
    // The expired entry is cleared rather than left to accumulate.
    expect(store.getItem(editorWorkRecoveryKey("ana", "cmsPages:watch"))).toBeNull();
  });

  it("clears a snapshot once the person has recovered or discarded it", () => {
    const { store } = memoryStorage();
    writeRecoveredWork(store, work());
    clearRecoveredWork(store, "ana", "cmsPages:watch");
    expect(readRecoveredWork(store, "ana", "cmsPages:watch", 2_000)).toBeNull();
  });

  it("treats unreadable or foreign storage values as absent rather than throwing", () => {
    const { store } = memoryStorage({
      [editorWorkRecoveryKey("ana", "cmsPages:watch")]: "not json",
      [editorWorkRecoveryKey("bo", "cmsPages:watch")]: JSON.stringify({ nope: true }),
    });
    expect(readRecoveredWork(store, "ana", "cmsPages:watch", 2_000)).toBeNull();
    expect(readRecoveredWork(store, "bo", "cmsPages:watch", 2_000)).toBeNull();
  });

  it("reports a failed write instead of losing the editor's session to an exception", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(writeRecoveredWork(throwing, work())).toBe(false);
    expect(readRecoveredWork(throwing, "ana", "cmsPages:watch", 2_000)).toBeNull();
    expect(() => clearRecoveredWork(throwing, "ana", "cmsPages:watch")).not.toThrow();
  });

  it("refuses to store a snapshot with no addressable owner or payload", () => {
    const { store } = memoryStorage();
    expect(writeRecoveredWork(store, work({ actorId: "" }))).toBe(false);
    expect(writeRecoveredWork(store, work({ surfaceKey: "" }))).toBe(false);
    expect(writeRecoveredWork(store, work({ payload: undefined }))).toBe(false);
  });
});
