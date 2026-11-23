import { expect, it, vi } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import notifications from "../../functions/editorial-notification.js";
import notices from "../../functions/lib/editorial-notice.js";
import reviewQueue from "../../functions/lib/review-queue.js";

const { deliverEditorialNotification } = notifications;
const { editorialNotice } = notices;

it("routes committed Page and Post notices to eligible participants once per transition", async () => {
  const firestore = isolatedFirestore("editorial-notification.test.js");
  const profiles = {
    writer: { grants: [{ role: "contributor", sections: ["news"] }] },
    assigned: { grants: [{ role: "editor", sections: ["news"] }] },
    reviewer: { grants: [{ role: "editor", sections: ["news"] }] },
    otherDesk: { grants: [{ role: "editor", sections: ["station"] }] },
    inactive: { grants: [{ role: "editor" }], active: false },
    unverified: { grants: [{ role: "editor" }] },
    disabled: { grants: [{ role: "editor" }] },
    automated: { grants: [{ role: "editor" }] },
  };
  const batch = firestore.batch();
  for (const [uid, profile] of Object.entries(profiles)) batch.set(firestore.doc(`users/${uid}`), profile);
  batch.set(firestore.doc("cmsAutomationAccounts/automated"), {});
  await batch.commit();

  const authClient = { getUser: async uid => ({
    email: `${uid.toLowerCase()}@example.org`,
    emailVerified: uid !== "unverified",
    disabled: uid === "disabled",
  }) };
  const sendEmail = vi.fn(async () => ({ queued: true }));
  const deps = { firestore, authClient, sendEmail, adminOrigin: "https://boardwalk.example.org" };
  const collection = "cmsPosts";
  const id = "sample post";
  const record = { type: "post", section: "news", createdBy: "writer", assignee: "assigned" };
  const inReview = { ...record, reviewRequest: reviewQueue.createReviewRequest({
    collection, id, sourceVersion: 2, requestedBy: "writer", requestedAt: "2026-11-22T12:00:00.000Z",
  }) };
  const audit = (actorUid, action, after = record) => ({
    actorUid, after: editorialNotice(collection, id, action, inReview, after),
  });

  const submitted = audit("writer", "submit");
  await Promise.all([
    deliverEditorialNotification("submitted", submitted, deps),
    deliverEditorialNotification("submitted", submitted, deps),
  ]);
  expect(sendEmail.mock.calls.map(([mail]) => mail.to)).toEqual(["assigned@example.org"]);
  expect(sendEmail.mock.calls[0][0].text).toContain(
    "https://boardwalk.example.org/content/post/sample%20post/edit",
  );

  sendEmail.mockClear();
  await deliverEditorialNotification("fallback", audit("writer", "submit", {
    ...record, assignee: "otherDesk",
  }), deps);
  expect(sendEmail.mock.calls.map(([mail]) => mail.to).sort()).toEqual([
    "assigned@example.org", "reviewer@example.org",
  ]);

  for (const [action, actorUid, expected] of [
    ["sendBack", "assigned", ["writer@example.org"]],
    ["approve", "assigned", ["writer@example.org"]],
    ["schedule", "assigned", ["writer@example.org"]],
    ["publish", "system:scheduler", ["assigned@example.org", "writer@example.org"]],
  ]) {
    sendEmail.mockClear();
    await deliverEditorialNotification(action, audit(actorUid, action), deps);
    await deliverEditorialNotification(action, audit(actorUid, action), deps);
    expect(sendEmail.mock.calls.map(([mail]) => mail.to).sort()).toEqual(expected);
  }

  sendEmail.mockClear();
  await deliverEditorialNotification("page", {
    actorUid: "system:scheduler",
    after: editorialNotice("cmsPages", "watch", "publish", {}, { createdBy: "otherDesk" }),
  }, deps);
  expect(sendEmail).toHaveBeenCalledOnce();
  expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "otherdesk@example.org" });
  expect(sendEmail.mock.calls[0][0].text).toContain("https://boardwalk.example.org/content/pages/watch/edit");
});
