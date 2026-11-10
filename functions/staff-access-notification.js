"use strict";

// Firestore creation events make the first Boardwalk request-alert attempt.
// The existing Telegram scheduler owns safe retries and expired-lease recovery.

const logger = require("firebase-functions/logger");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const {
  BUG_REPORT_ADMIN_ORIGIN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  createTelegramClient,
} = require("./bug-report-delivery");
const {
  STAFF_ACCESS_NOTIFICATION_COLLECTION,
  deliverStaffAccessNotification,
} = require("./lib/staff-access-notification");

function configuredValue(param, environmentName) {
  // config-input: CMS_BUG_REPORT_ADMIN_ORIGIN, CMS_BUG_REPORT_TELEGRAM_CHAT_ID
  return process.env[environmentName]?.trim() || param.value().trim();
}

async function deliverCreatedStaffAccessNotification(id, deps = {}) {
  return deliverStaffAccessNotification(id, {
    ...deps,
    telegramClient: deps.telegramClient ?? createTelegramClient(deps),
    chatId: deps.chatId ?? configuredValue(
      TELEGRAM_CHAT_ID,
      "CMS_BUG_REPORT_TELEGRAM_CHAT_ID",
    ),
    adminOrigin: deps.adminOrigin ?? configuredValue(
      BUG_REPORT_ADMIN_ORIGIN,
      "CMS_BUG_REPORT_ADMIN_ORIGIN",
    ),
  });
}

const onStaffAccessNotificationCreated = onDocumentCreated(
  {
    document: `${STAFF_ACCESS_NOTIFICATION_COLLECTION}/{notificationId}`,
    secrets: [TELEGRAM_BOT_TOKEN],
    timeoutSeconds: 30,
    memory: "256MiB",
    retry: false,
  },
  async (event) => {
    if (process.env.FUNCTIONS_EMULATOR === "true") {
      logger.info("Staff access notification event skipped in the emulator");
      return;
    }
    const result = await deliverCreatedStaffAccessNotification(
      event.params.notificationId,
    );
    const details = { state: result.state };
    if (["terminal_failed", "unknown"].includes(result.state)) {
      logger.warn("Staff access notification needs operator review", details);
    } else {
      logger.info("Staff access notification event processed", details);
    }
  },
);

module.exports = {
  deliverCreatedStaffAccessNotification,
  onStaffAccessNotificationCreated,
};
