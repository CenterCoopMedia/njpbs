// Checks the staff bug-report relay bot without sending a message. It runs on
// its own schedule so a Telegram outage never blocks a CMS deploy (#537).
import { pathToFileURL } from "node:url";

const ATTEMPTS = 4;

class RelayError extends Error {}

function transient(status) {
  return status === 429 || status >= 500;
}

export async function verifyReportRelay(env, { fetch = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const token = env.CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.CMS_BUG_REPORT_TELEGRAM_CHAT_ID ?? "";
  const expected = { id: env.CMS_BUG_REPORT_TELEGRAM_BOT_ID ?? "", username: env.CMS_BUG_REPORT_TELEGRAM_BOT_USERNAME ?? "" };
  if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new RelayError("CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN is missing or invalid");
  if (!/^[1-9][0-9]{0,19}$/.test(chatId)) throw new RelayError("CMS_BUG_REPORT_TELEGRAM_CHAT_ID must identify the configured private recipient");
  if (!/^[1-9][0-9]{0,19}$/.test(expected.id) || !/^[A-Za-z0-9_]{5,32}$/.test(expected.username)) {
    throw new RelayError("Configure the expected report relay bot identity");
  }

  const telegram = async (method, body = {}) => {
    for (let attempt = 1; ; attempt++) {
      let response;
      let payload = null;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        // A body that is not JSON is an answer; a dropped or timed-out read is not.
        payload = await response.json().catch(error => { if (error instanceof SyntaxError) return null; throw error; });
      } catch (error) {
        // Connection failures carry no answer from Telegram. Never print the
        // error message: it can include the request URL and so the token.
        if (attempt >= ATTEMPTS) throw new RelayError(`Telegram ${method} unreachable after ${ATTEMPTS} attempts (${error?.cause?.code ?? error?.name ?? "error"})`);
        await sleep(2_000 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok && payload?.ok === true) return payload.result;
      if (!transient(response.status) || attempt >= ATTEMPTS) throw new RelayError(`Telegram ${method} check failed (HTTP ${response.status})`);
      const retryAfter = Number(payload?.parameters?.retry_after ?? response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : 2_000 * 2 ** (attempt - 1));
    }
  };

  const identity = await telegram("getMe");
  if (String(identity?.id) !== expected.id || identity?.username !== expected.username) {
    throw new RelayError("CMS reports must use the configured bot");
  }
  const webhook = await telegram("getWebhookInfo");
  if (webhook?.url) throw new RelayError("Report relay must keep long polling; remove its Telegram webhook");
  const chat = await telegram("getChat", { chat_id: chatId });
  if (chat?.type !== "private" || String(chat?.id) !== chatId) {
    throw new RelayError("Boardwalk account alerts require a configured private recipient");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await verifyReportRelay(process.env);
    console.log("Report relay verified");
  } catch (error) {
    console.error(error instanceof RelayError ? error.message : "Report relay check failed");
    process.exitCode = 1;
  }
}
