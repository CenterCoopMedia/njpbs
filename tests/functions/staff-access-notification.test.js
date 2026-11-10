import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import notification from "../../functions/lib/staff-access-notification.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const NOW = new Date("2026-09-14T20:00:00.000Z");
let db;

function request(overrides = {}) {
  return {
    eventType: "request_pending",
    uid: "requester-1",
    requestVersion: 3,
    email: "requester@example.org",
    displayName: "New staff member",
    reason: "I need to prepare station video and page updates.",
    reference: "NJPBS-REQUESTE-3",
    requestedAt: NOW,
    ...overrides,
  };
}

async function seedNotification(id, overrides = {}) {
  await db.collection(notification.STAFF_ACCESS_NOTIFICATION_COLLECTION).doc(id).set({
    ...request(),
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseUntil: null,
    telegramChatId: null,
    telegramMessageId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("staff-access-notification.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("staff access request notifications", () => {
  it("queues one deterministic pending-request alert with the request transaction", async () => {
    let id;
    await db.runTransaction(async (transaction) => {
      id = notification.queueStaffAccessNotification(
        transaction,
        db,
        request(),
        NOW,
      );
    });

    expect(id).toBe("requester-1--3--pending");
    const stored = (
      await db.collection(notification.STAFF_ACCESS_NOTIFICATION_COLLECTION).doc(id).get()
    ).data();
    expect(stored).toMatchObject({
      eventType: "request_pending",
      uid: "requester-1",
      requestVersion: 3,
      state: "pending",
      attemptCount: 0,
      reference: "NJPBS-REQUESTE-3",
    });
  });

  it("renders escaped request facts and only a Boardwalk review link", () => {
    const rendered = notification.renderStaffAccessTelegram(request({
      displayName: "Applicant <script>",
      reason: "Manage video & page updates.",
    }), "https://admin.njpbs.org/");

    expect(rendered.text).toContain("New Boardwalk account request");
    expect(rendered.text).toContain("Applicant &lt;script&gt;");
    expect(rendered.text).toContain("video &amp; page");
    expect(rendered.text).not.toContain("<script>");
    expect(rendered.keyboard).toEqual({
      inline_keyboard: [[{
        text: "Review request",
        url: "https://admin.njpbs.org/staff-access#staff-request-heading",
      }]],
    });
    expect(JSON.stringify(rendered.keyboard)).not.toContain("callback_data");
  });

  it("keeps escaped hostile request text within Telegram's message limit", () => {
    const rendered = notification.renderStaffAccessTelegram(request({
      email: `${"&".repeat(240)}@example.org`,
      displayName: "<".repeat(120),
      reason: "&".repeat(500),
      reference: "<".repeat(100),
    }), "https://admin.njpbs.org");

    expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(4_096);
    expect(rendered.text).not.toContain("&".repeat(100));
  });

  it("delivers once and skips a repeated event", async () => {
    await seedNotification("requester-1--3--pending");
    const telegramClient = {
      sendMessage: vi.fn(async () => ({
        chat: { id: "12345" },
        message_id: 88,
      })),
    };
    const deps = {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "12345",
      adminOrigin: "https://admin.njpbs.org",
    };

    await expect(
      notification.deliverStaffAccessNotification("requester-1--3--pending", deps),
    ).resolves.toEqual({ state: "delivered" });
    await expect(
      notification.deliverStaffAccessNotification("requester-1--3--pending", deps),
    ).resolves.toEqual({ state: "skipped" });

    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
    expect((
      await db.collection(notification.STAFF_ACCESS_NOTIFICATION_COLLECTION)
        .doc("requester-1--3--pending").get()
    ).data()).toMatchObject({
      state: "delivered",
      attemptCount: 1,
      telegramChatId: "12345",
      telegramMessageId: "88",
    });
  });

  it("retries a known refusal and delivers through the scheduled processor", async () => {
    await seedNotification("retryable");
    const retryable = new Error("try later");
    retryable.kind = "retryable";
    retryable.status = 503;
    const firstClient = {
      sendMessage: vi.fn(async () => {
        throw retryable;
      }),
    };

    await expect(notification.deliverStaffAccessNotification("retryable", {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient: firstClient,
      chatId: "12345",
    })).resolves.toEqual({ state: "pending" });

    const later = new Date(NOW.getTime() + 61_000);
    const secondClient = {
      sendMessage: vi.fn(async () => ({ chat: { id: "12345" }, message_id: 89 })),
    };
    await expect(notification.processPendingStaffAccessNotifications({
      firestore: db,
      now: () => later,
      telegramClient: secondClient,
      chatId: "12345",
    })).resolves.toEqual([{ state: "delivered" }]);
    expect(secondClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses a group destination without sending applicant data", async () => {
    await seedNotification("group-destination");
    const telegramClient = { sendMessage: vi.fn() };

    await expect(notification.deliverStaffAccessNotification(
      "group-destination",
      {
        firestore: db,
        now: () => new Date(NOW),
        telegramClient,
        chatId: "-10012345",
      },
    )).resolves.toEqual({ state: "pending" });
    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous send result", async () => {
    await seedNotification("ambiguous");
    const ambiguous = new Error("result unknown");
    ambiguous.kind = "ambiguous";
    const telegramClient = {
      sendMessage: vi.fn(async () => {
        throw ambiguous;
      }),
    };
    const deps = {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "12345",
    };

    await expect(
      notification.deliverStaffAccessNotification("ambiguous", deps),
    ).resolves.toEqual({ state: "unknown" });
    await expect(
      notification.deliverStaffAccessNotification("ambiguous", deps),
    ).resolves.toEqual({ state: "skipped" });
    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("marks an expired sending lease unknown without sending again", async () => {
    await seedNotification("expired", {
      state: "sending",
      attemptCount: 1,
      leaseUntil: new Date(NOW.getTime() - 1_000),
    });

    await expect(notification.recoverExpiredStaffAccessNotifications({
      firestore: db,
      now: () => new Date(NOW),
    })).resolves.toEqual([{ state: "unknown" }]);
    expect((
      await db.collection(notification.STAFF_ACCESS_NOTIFICATION_COLLECTION)
        .doc("expired").get()
    ).data()).toMatchObject({
      state: "unknown",
      nextAttemptAt: null,
      lastError: "ambiguous_expired_lease",
    });
  });

  it("fails closed on a corrupt outbox row", async () => {
    await seedNotification("corrupt", { uid: "bad/path" });
    const telegramClient = { sendMessage: vi.fn() };

    await expect(notification.deliverStaffAccessNotification("corrupt", {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "12345",
    })).resolves.toEqual({ state: "terminal_failed" });
    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
    expect((
      await db.collection(notification.STAFF_ACCESS_NOTIFICATION_COLLECTION)
        .doc("corrupt").get()
    ).data()).toMatchObject({
      state: "terminal_failed",
      lastError: "invalid_request",
    });
  });
});
