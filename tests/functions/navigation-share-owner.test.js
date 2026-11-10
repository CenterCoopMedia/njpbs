import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { aroundAll, beforeEach, describe, expect, it } from "vitest";
import { withFunctionTriggersDisabled } from "@firebase/rules-unit-testing";
import firebase from "../../functions/lib/firebase.js";
import endpoint from "../../functions/navigation-share-owner.js";

const ownerUid = "share-owner";
const owner = () => firebase.db.collection("users").doc(ownerUid);
const shares = () => firebase.db.collection("navigationShares");
const originalTime = new Date("2026-01-01T00:00:00Z");
const shared = (id, extra = {}) => ({
  ownerUid,
  ownerName: "Sample editor",
  status: "active",
  item: {
    id, kind: "link", label: "Newsroom handbook", icon: "link",
    destination: { kind: "url", url: "https://example.test/handbook" },
  },
  updatedAt: originalTime,
  ...extra,
});

async function removalEvent(deleted = false) {
  const before = await owner().get();
  const result = deleted ? await owner().delete() : await owner().update({ active: false });
  const time = result.writeTime.toDate().toISOString().replace(
    /\.\d{3}Z$/, `.${String(result.writeTime.nanoseconds).padStart(9, "0")}Z`,
  );
  return { time, params: { uid: ownerUid }, data: { before, after: await owner().get() } };
}

describe("shared rail owner cleanup on the Firestore emulator", () => {
  aroundAll(async (runSuite) => {
    const hub = process.env.FIREBASE_EMULATOR_HUB;
    if (!/^127\.0\.0\.1:\d+$/.test(hub ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
      throw new Error("These tests require the local demo-njpbs emulator hub");
    }
    const response = await fetch(`http://${hub}/emulators`);
    if (!response.ok) throw new Error("Emulator discovery failed");
    const emulators = await response.json();
    // These cases deliver the handler events explicitly. Automatic triggers
    // otherwise race those events and retain transactions across fixture resets.
    if (emulators.functions) await withFunctionTriggersDisabled(runSuite);
    else await runSuite();
    // Re-enabling triggers reloads every Functions definition (10.926s in #3357).
    // Give this vendor lifecycle the same 20s budget as the Functions tests.
  }, 20_000);

  beforeEach(async () => {
    if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
        process.env.GCLOUD_PROJECT !== "demo-njpbs") {
      throw new Error("These tests require the local demo-njpbs Firestore emulator");
    }
    const result = await clearEmulatorFirestore(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
      { method: "DELETE" },
    );
    if (!result.ok) throw new Error("Emulator cleanup failed");
    await owner().set({ active: true, role: "staff" });
  });

  it.each([false, true])("removes only active shares after owner deletion=%s", async (deleted) => {
    const link = shared("custom:handbook");
    const span = shared("custom:desk", {
      item: { id: "custom:desk", kind: "section", label: "Desk", icon: "folder", links: [link.item] },
    });
    const unshared = shared("custom:old", { status: "removed", removedReason: "unshared" });
    const other = shared("custom:other", { ownerUid: "other-owner" });
    for (const entry of [link, span, unshared, other]) await shares().doc(entry.item.id).set(entry);
    const oldTombstone = (await shares().doc("custom:old").get()).data();
    const otherShare = (await shares().doc("custom:other").get()).data();

    await endpoint.onNavigationShareOwnerWrite.run(await removalEvent(deleted));

    expect((await shares().where("status", "==", "active").get()).docs.map((doc) => doc.id)).toEqual(["custom:other"]);
    for (const entry of [link, span]) {
      const removed = (await shares().doc(entry.item.id).get()).data();
      expect(removed).toMatchObject({
        ownerUid, ownerName: entry.ownerName, item: entry.item,
        status: "removed", removedReason: "owner_removed",
      });
      expect(removed.updatedAt.toMillis()).toBeGreaterThan(originalTime.getTime());
    }
    expect((await shares().doc("custom:old").get()).data()).toEqual(oldTombstone);
    expect((await shares().doc("custom:other").get()).data()).toEqual(otherShare);
  });

  it.each([false, true])("preserves shares created after a delayed deletion=%s event", async (deleted) => {
    const event = await removalEvent(deleted);
    await shares().doc("custom:handbook").set(shared("custom:handbook"));
    const created = (await shares().doc("custom:handbook").get()).data();

    await endpoint.onNavigationShareOwnerWrite.run(event);

    expect((await shares().doc("custom:handbook").get()).data()).toEqual(created);
  });

  it("does not rewrite tombstones when an event is delivered again", async () => {
    await shares().doc("custom:handbook").set(shared("custom:handbook"));
    const event = await removalEvent();
    await endpoint.onNavigationShareOwnerWrite.run(event);
    const first = (await shares().doc("custom:handbook").get()).data();
    await endpoint.onNavigationShareOwnerWrite.run(event);
    expect((await shares().doc("custom:handbook").get()).data()).toEqual(first);
  });

  it.each([false, true])("ignores a stale deletion=%s event after staff access is restored", async (deleted) => {
    const event = await removalEvent(deleted);
    await owner().set({ active: true });
    await shares().doc("custom:handbook").set(shared("custom:handbook"));
    const first = (await shares().doc("custom:handbook").get()).data();
    await endpoint.onNavigationShareOwnerWrite.run(event);
    expect((await shares().doc("custom:handbook").get()).data()).toEqual(first);
  });

  it("preserves legacy active profiles without an active field", async () => {
    const event = await removalEvent();
    await owner().set({ role: "staff" });
    await shares().doc("custom:handbook").set(shared("custom:handbook"));
    await endpoint.onNavigationShareOwnerWrite.run(event);
    expect((await shares().doc("custom:handbook").get()).data().status).toBe("active");
  });

  it("does not reactivate old shares when a profile is restored", async () => {
    await shares().doc("custom:handbook").set(shared("custom:handbook"));
    await endpoint.onNavigationShareOwnerWrite.run(await removalEvent());
    const before = await owner().get();
    await owner().update({ active: true });
    await endpoint.onNavigationShareOwnerWrite.run({
      params: { uid: ownerUid }, data: { before, after: await owner().get() },
    });
    expect((await shares().doc("custom:handbook").get()).data().status).toBe("removed");
  });
});
