import admin from "../helpers/firebase-admin.js";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { declaredParams } from "firebase-functions/params";
import billing from "../../functions/billing.js";

const {
  onBudgetNotification,
  assertBillingEnabled,
  applyBudgetNotification,
  evaluateBudget,
  parseBudgetNotification,
  sendBillingAlert,
  BILLING_DOC_PATH,
} = billing;

let db;

const basePayload = {
  budgetDisplayName: "NJ PBS CMS budget",
  costAmount: 120,
  costIntervalStart: "2026-07-01T00:00:00Z",
  budgetAmount: 100,
  budgetAmountType: "SPECIFIED_AMOUNT",
  alertThresholdExceeded: 1,
  currencyCode: "USD",
};

function makeMessage(payload) {
  return {
    data: Buffer.from(JSON.stringify(payload)).toString("base64"),
  };
}

beforeAll(() => {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: "demo-njpbs" });
  }
  db = admin.firestore();
});

afterEach(async () => {
  await db.doc(BILLING_DOC_PATH).delete();
});

describe("onBudgetNotification trigger", () => {
  it("binds the budget topic through the deploy-time parameter", () => {
    const topic =
      onBudgetNotification.__endpoint.eventTrigger.eventFilters.topic;

    expect(typeof topic).toBe("object");
    expect(topic).toMatchObject({
      name: "BILLING_BUDGET_TOPIC",
      options: { default: "billing-budget-alerts" },
    });
    expect(JSON.parse(JSON.stringify(topic))).toBe(
      "params.BILLING_BUDGET_TOPIC",
    );
    expect(
      declaredParams.map((param) => param.toSpec?.() ?? param),
    ).toContainEqual({
      name: "BILLING_BUDGET_TOPIC",
      type: "string",
      default: "billing-budget-alerts",
    });
  });
});

describe("parseBudgetNotification", () => {
  it("decodes a base64 data message into budget amounts", () => {
    const parsed = parseBudgetNotification(makeMessage(basePayload));

    expect(parsed.costAmount).toBe(120);
    expect(parsed.budgetAmount).toBe(100);
  });

  it("reads a message-like json property", () => {
    const parsed = parseBudgetNotification({ json: basePayload });

    expect(parsed.costAmount).toBe(120);
    expect(parsed.budgetAmount).toBe(100);
  });

  it("reads an already-decoded payload object", () => {
    const parsed = parseBudgetNotification(basePayload);

    expect(parsed.costAmount).toBe(120);
    expect(parsed.budgetAmount).toBe(100);
  });

  it("throws on a malformed payload missing costAmount", () => {
    const malformed = { ...basePayload };
    delete malformed.costAmount;

    expect(() => parseBudgetNotification(malformed)).toThrow(
      "malformed budget notification",
    );
  });
});

describe("evaluateBudget", () => {
  it("evaluates threshold crossings and non-positive budgets", () => {
    expect(
      evaluateBudget({ costAmount: 100, budgetAmount: 100 }, 1).shouldDisable,
    ).toBe(true);
    expect(
      evaluateBudget({ costAmount: 99.99, budgetAmount: 100 }, 1)
        .shouldDisable,
    ).toBe(false);
    expect(
      evaluateBudget({ costAmount: 101, budgetAmount: 100 }, 1).shouldDisable,
    ).toBe(true);
    expect(
      evaluateBudget({ costAmount: 101, budgetAmount: 0 }, 1).shouldDisable,
    ).toBe(true);
    expect(
      evaluateBudget({ costAmount: 0, budgetAmount: 0 }, 1).shouldDisable,
    ).toBe(false);
    expect(
      evaluateBudget({ costAmount: 1, budgetAmount: -1 }, 1).shouldDisable,
    ).toBe(true);
  });
});

describe("applyBudgetNotification", () => {
  it("flips disabled on an over-threshold payload and persists the reason", async () => {
    const result = await applyBudgetNotification(db, basePayload, {
      threshold: 1,
    });
    const snap = await db.doc(BILLING_DOC_PATH).get();
    const doc = snap.data();

    expect(result.action).toBe("disabled");
    expect(doc.disabled).toBe(true);
    expect(doc.reason).toContain("spend $120 USD crossed budget $100");
    expect(doc.costAmount).toBe(120);
    expect(doc.budgetAmount).toBe(100);
  });

  it("flips disabled on a zero-budget spend payload", async () => {
    const payload = { ...basePayload, costAmount: 5, budgetAmount: 0 };

    const result = await applyBudgetNotification(db, payload, { threshold: 1 });
    const snap = await db.doc(BILLING_DOC_PATH).get();
    const doc = snap.data();

    expect(result.action).toBe("disabled");
    expect(doc.disabled).toBe(true);
    expect(doc.reason).toContain("spend $5 USD crossed budget $0 USD");
    expect(doc.costAmount).toBe(5);
    expect(doc.budgetAmount).toBe(0);
  });

  it("writes telemetry without disabling from a clean state below threshold", async () => {
    const payload = { ...basePayload, costAmount: 50 };

    const result = await applyBudgetNotification(db, payload, { threshold: 1 });
    const snap = await db.doc(BILLING_DOC_PATH).get();
    const doc = snap.data();

    expect(result.action).toBe("telemetry");
    expect(doc.disabled).toBeUndefined();
    expect(doc.costAmount).toBe(50);
    expect(doc.lastNotificationAt).toBeDefined();
  });

  it("does not thrash updatedAt on repeated over-threshold calls", async () => {
    await applyBudgetNotification(db, basePayload, { threshold: 1 });
    const firstSnap = await db.doc(BILLING_DOC_PATH).get();
    const firstUpdatedAt = firstSnap.data().updatedAt.toMillis();

    const result = await applyBudgetNotification(db, basePayload, {
      threshold: 1,
    });
    const secondSnap = await db.doc(BILLING_DOC_PATH).get();
    const secondUpdatedAt = secondSnap.data().updatedAt.toMillis();

    expect(result.action).toBe("already-disabled");
    expect(secondSnap.data().disabled).toBe(true);
    expect(secondUpdatedAt).toBe(firstUpdatedAt);
  });

  it("leaves disabled true after a later below-threshold notification", async () => {
    await applyBudgetNotification(db, basePayload, { threshold: 1 });
    const payload = { ...basePayload, costAmount: 50 };

    const result = await applyBudgetNotification(db, payload, { threshold: 1 });
    const snap = await db.doc(BILLING_DOC_PATH).get();
    const doc = snap.data();

    expect(result.action).toBe("telemetry");
    expect(doc.disabled).toBe(true);
    expect(doc.costAmount).toBe(50);
  });
});

describe("assertBillingEnabled", () => {
  it("throws a failed-precondition error when disabled is true", async () => {
    await db.doc(BILLING_DOC_PATH).set({
      disabled: true,
      reason: "spend limit reached",
    });

    await expect(assertBillingEnabled(db)).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("resolves true when disabled is false", async () => {
    await db.doc(BILLING_DOC_PATH).set({ disabled: false });

    await expect(assertBillingEnabled(db)).resolves.toBe(true);
  });

  it("resolves true when the billing doc is absent", async () => {
    await db.doc(BILLING_DOC_PATH).delete();

    await expect(assertBillingEnabled(db)).resolves.toBe(true);
  });
});

describe("sendBillingAlert", () => {
  it("returns skipped when token is falsy without calling fetch", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    try {
      const result = await sendBillingAlert({
        url: "https://notify.example.test/alert",
        token: "",
        message: "billing disabled",
      });

      expect(result).toMatchObject({ skipped: true });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts with a bearer header when token is set", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;

    try {
      const result = await sendBillingAlert({
        url: "https://notify.example.test/alert",
        token: "test-token",
        message: "billing disabled",
      });

      expect(result).toMatchObject({ sent: true });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://notify.example.test/alert",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: expect.stringContaining("billing disabled"),
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts and swallows a hung notify endpoint instead of holding the invocation open", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    // A notify endpoint that never answers on its own; it settles only when the
    // abort signal fires, which is what the timeout must trigger.
    const fetchMock = vi.fn((url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }));
    globalThis.fetch = fetchMock;

    try {
      const pending = sendBillingAlert({
        url: "https://notify.example.test/alert",
        token: "test-token",
        message: "billing disabled",
        timeoutMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result).toMatchObject({ sent: false });
      // The swallowed error must be the abort, so the test proves what its name
      // claims and a future refactor cannot pass by failing some other way.
      expect(result.error).toMatch(/abort/i);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});
