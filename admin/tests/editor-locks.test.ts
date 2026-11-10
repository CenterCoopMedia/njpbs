import { describe, expect, it } from "vitest";
import {
  EDITOR_LOCK_LEASE_MS,
  isEditorLockAbandoned,
  editorLockContentAddress,
  editorLockDocumentId,
  isEditorLockStale,
  normalizeEditorLockName,
  type EditorLock,
} from "../src/lib/editor-locks";

function lock(observedAtMs: number): EditorLock {
  return {
    surfaceKey: "cmsPages:home",
    ownerId: "editor-1",
    ownerName: "Jordan Editor",
    sessionId: "session-1",
    acquiredAtMs: 0,
    heartbeatAtMs: 0,
    observedAtMs,
  };
}

describe("editor lock policy", () => {
  it("uses one Firestore-safe document id for a content path", () => {
    expect(editorLockDocumentId("cmsPages:home")).toBe("cmsPages:home");
  });

  it("derives a rules-verifiable content address from a canonical surface key", () => {
    expect(editorLockContentAddress("cmsPages:home")).toEqual({
      contentCollection: "cmsPages",
      contentId: "home",
    });
    expect(editorLockContentAddress("cmsPosts:story_1")).toEqual({
      contentCollection: "cmsPosts",
      contentId: "story_1",
    });
    expect(editorLockContentAddress("cmsPages:")).toBeNull();
    expect(editorLockContentAddress("cmsPages:home:other")).toBeNull();
    expect(editorLockContentAddress("cmsPages:home/other")).toBeNull();
    expect(editorLockContentAddress("cmsSettings:site")).toBeNull();
  });

  it("treats a lease as live until the full two-minute window elapses", () => {
    const now = 500_000;
    expect(isEditorLockStale(lock(now - EDITOR_LOCK_LEASE_MS + 1), now)).toBe(false);
    expect(isEditorLockStale(lock(now - EDITOR_LOCK_LEASE_MS), now)).toBe(true);
  });

  it("normalizes a human label and keeps a non-empty fallback", () => {
    expect(normalizeEditorLockName("  Jordan   Editor  ")).toBe("Jordan Editor");
    expect(normalizeEditorLockName("   ")).toBe("Another editor");
    expect(normalizeEditorLockName("x".repeat(120))).toHaveLength(100);
  });

  it("treats a lease whose stored heartbeat has aged out as abandoned", () => {
    // A tab that opens a record ten minutes after the last heartbeat has no observation window
    // to wait out, so without this it would show a dead session as an active editor (#1047).
    const abandoned: EditorLock = {
      ...lock(0),
      heartbeatAtMs: 1_000_000 - EDITOR_LOCK_LEASE_MS - 1,
    };
    expect(isEditorLockAbandoned(abandoned, 1_000_000)).toBe(true);
    expect(
      isEditorLockAbandoned({ ...abandoned, heartbeatAtMs: 1_000_000 - 1_000 }, 1_000_000),
    ).toBe(false);
    expect(
      isEditorLockAbandoned(
        { ...abandoned, heartbeatAtMs: 1_000_000 - EDITOR_LOCK_LEASE_MS },
        1_000_000,
      ),
    ).toBe(true);
  });
});
