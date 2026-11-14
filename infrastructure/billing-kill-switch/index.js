import { CloudBillingClient } from "@google-cloud/billing";

const DEFAULT_THRESHOLD = 1;
const DEFAULT_MODE = "simulate";

export function decodeBudgetNotification(event) {
  const parsed =
    event?.data?.message?.json ??
    event?.message?.json ??
    (event?.data?.budgetDisplayName ? event.data : null);
  if (parsed) {
    return parsed;
  }

  if (typeof event?.data === "string") {
    return parseJsonOrBase64Json(event.data);
  }

  const encoded = event?.data?.message?.data ?? event?.message?.data ?? event?.data?.data;
  if (encoded instanceof Uint8Array) {
    return JSON.parse(Buffer.from(encoded).toString("utf8"));
  }

  if (!encoded || typeof encoded !== "string") {
    throw new Error(
      `Budget notification is missing Pub/Sub data: ${JSON.stringify(describeEventShape(event, encoded))}`,
    );
  }

  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function parseJsonOrBase64Json(value) {
  try {
    return JSON.parse(value);
  } catch {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  }
}

function describeEventShape(event, encoded) {
  const data = event?.data;
  const message = data?.message ?? event?.message;

  return {
    topLevelKeys: event && typeof event === "object" ? Object.keys(event) : [],
    dataType: data?.constructor?.name ?? typeof data,
    dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
    messageKeys: message && typeof message === "object" ? Object.keys(message) : [],
    encodedType: encoded?.constructor?.name ?? typeof encoded,
  };
}

export function buildProjectBillingName(projectId) {
  if (!projectId) {
    throw new Error("Project ID is required");
  }

  return `projects/${projectId}/billingInfo`;
}

export function shouldDisableBilling(message, config = {}) {
  if (config.mode !== "enforce") {
    return false;
  }

  return isHardThresholdCrossed(message, config);
}

function isHardThresholdCrossed(message, config = {}) {

  const threshold = Number(config.threshold ?? DEFAULT_THRESHOLD);
  const alertThreshold = Number(message.alertThresholdExceeded ?? 0);
  const costAmount = Number(message.costAmount ?? 0);
  const budgetAmount = Number(message.budgetAmount ?? 0);

  return alertThreshold >= threshold || (budgetAmount > 0 && costAmount >= budgetAmount);
}

export async function disableBilling(projectName, client = new CloudBillingClient()) {
  const [response] = await client.updateProjectBillingInfo({
    name: projectName,
    resource: { billingAccountName: "" },
  });

  return response;
}

export async function handleBudgetNotification(event, config = {}) {
  const message = decodeBudgetNotification(event);
  const projectName = buildProjectBillingName(config.projectId ?? process.env.GOOGLE_CLOUD_PROJECT);
  const mode = config.mode ?? process.env.BILLING_KILL_SWITCH_MODE ?? DEFAULT_MODE;
  const threshold = Number(
    config.threshold ?? process.env.BILLING_KILL_SWITCH_THRESHOLD ?? DEFAULT_THRESHOLD,
  );
  const disable = config.disableBilling ?? disableBilling;

  if (!isHardThresholdCrossed(message, { threshold })) {
    return { action: "ignored", projectName, message };
  }

  if (mode !== "enforce") {
    return { action: "simulate", projectName, message };
  }

  const response = await disable(projectName);
  return { action: "disabled", projectName, message, response };
}

export async function stopBillingOnBudgetAlert(event) {
  const result = await handleBudgetNotification(event);
  console.log(
    JSON.stringify({
      action: result.action,
      projectName: result.projectName,
      budgetDisplayName: result.message.budgetDisplayName,
      costAmount: result.message.costAmount,
      budgetAmount: result.message.budgetAmount,
      alertThresholdExceeded: result.message.alertThresholdExceeded,
    }),
  );
}
