import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildProjectBillingName,
  decodeBudgetNotification,
  handleBudgetNotification,
  shouldDisableBilling,
} from "../index.js";

function budgetEvent(payload) {
  return {
    data: {
      message: {
        data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      },
    },
  };
}

test("decodes budget notifications from Pub/Sub CloudEvents", () => {
  const message = decodeBudgetNotification(
    budgetEvent({
      budgetDisplayName: "Firebase Project njpbs-site",
      costAmount: 51,
      budgetAmount: 50,
      alertThresholdExceeded: 1,
      currencyCode: "USD",
    }),
  );

  assert.equal(message.budgetDisplayName, "Firebase Project njpbs-site");
  assert.equal(message.costAmount, 51);
  assert.equal(message.budgetAmount, 50);
  assert.equal(message.alertThresholdExceeded, 1);
});

test("decodes budget notifications from Cloud Run functions Pub/Sub data", () => {
  const payload = {
    budgetDisplayName: "Firebase Project njpbs-site",
    costAmount: 51,
    budgetAmount: 50,
    alertThresholdExceeded: 1,
    currencyCode: "USD",
  };
  const message = decodeBudgetNotification({
    data: {
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    },
  });

  assert.equal(message.budgetDisplayName, "Firebase Project njpbs-site");
  assert.equal(message.costAmount, 51);
});

test("decodes budget notifications when the runtime passes JSON as event data", () => {
  const message = decodeBudgetNotification({
    data: JSON.stringify({
      budgetDisplayName: "Firebase Project njpbs-site",
      costAmount: 51,
      budgetAmount: 50,
      alertThresholdExceeded: 1,
      currencyCode: "USD",
    }),
    message_id: "test-message",
    publish_time: "2026-06-30T17:54:20Z",
  });

  assert.equal(message.budgetDisplayName, "Firebase Project njpbs-site");
  assert.equal(message.costAmount, 51);
});

test("decodes budget notifications when the runtime passes base64 as event data", () => {
  const payload = {
    budgetDisplayName: "Firebase Project njpbs-site",
    costAmount: 51,
    budgetAmount: 50,
    alertThresholdExceeded: 1,
    currencyCode: "USD",
  };
  const message = decodeBudgetNotification({
    data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    message_id: "test-message",
    publish_time: "2026-06-30T17:57:01Z",
  });

  assert.equal(message.budgetDisplayName, "Firebase Project njpbs-site");
  assert.equal(message.costAmount, 51);
});

test("does not disable billing while mode is simulate", () => {
  assert.equal(
    shouldDisableBilling(
      {
        costAmount: 51,
        budgetAmount: 50,
        alertThresholdExceeded: 1,
      },
      { mode: "simulate", threshold: 1 },
    ),
    false,
  );
});

test("disables billing only when the hard threshold is crossed in enforce mode", () => {
  assert.equal(
    shouldDisableBilling(
      {
        costAmount: 49,
        budgetAmount: 50,
        alertThresholdExceeded: 0.9,
      },
      { mode: "enforce", threshold: 1 },
    ),
    false,
  );

  assert.equal(
    shouldDisableBilling(
      {
        costAmount: 51,
        budgetAmount: 50,
        alertThresholdExceeded: 1,
      },
      { mode: "enforce", threshold: 1 },
    ),
    true,
  );
});

test("builds the Cloud Billing project billing resource name", () => {
  assert.equal(buildProjectBillingName("njpbs-site"), "projects/njpbs-site/billingInfo");
});

test("returns simulated action without calling the billing client", async () => {
  let calls = 0;
  const result = await handleBudgetNotification(
    budgetEvent({
      budgetDisplayName: "Firebase Project njpbs-site",
      costAmount: 51,
      budgetAmount: 50,
      alertThresholdExceeded: 1,
    }),
    {
      projectId: "njpbs-site",
      mode: "simulate",
      threshold: 1,
      disableBilling: async () => {
        calls += 1;
      },
    },
  );

  assert.equal(calls, 0);
  assert.equal(result.action, "simulate");
  assert.equal(result.projectName, "projects/njpbs-site/billingInfo");
});

test("calls the billing client once in enforce mode", async () => {
  const calls = [];
  const result = await handleBudgetNotification(
    budgetEvent({
      budgetDisplayName: "Firebase Project njpbs-site",
      costAmount: 51,
      budgetAmount: 50,
      alertThresholdExceeded: 1,
    }),
    {
      projectId: "njpbs-site",
      mode: "enforce",
      threshold: 1,
      disableBilling: async (projectName) => {
        calls.push(projectName);
        return { billingAccountName: "" };
      },
    },
  );

  assert.deepEqual(calls, ["projects/njpbs-site/billingInfo"]);
  assert.equal(result.action, "disabled");
});
