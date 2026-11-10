import { configuredDestinations, destinationsFor, domainOf, isKnownAddress, localPartOf } from "./fanout";
import { digest, ledgerClient, type LedgerNamespace } from "./delivery-ledger";
export { FanoutDeliveryLedger } from "./delivery-ledger";

// The subset of Cloudflare's ForwardableEmailMessage this worker touches.
interface EmailMessage {
  readonly to: string;
  readonly from?: string;
  readonly headers?: Headers;
  forward(rcptTo: string): Promise<unknown>;
}
interface Env { FANOUT_DELIVERIES?: LedgerNamespace; FANOUT_DESTINATIONS_JSON?: string }

function servedAlias(recipient: string): string {
  // Only known route aliases are loggable; strip sender-controlled +tags.
  return isKnownAddress(recipient) ? `${localPartOf(recipient)}@${domainOf(recipient)}` : "unknown";
}

function failureCategory(error: unknown): "temporary" | "forward-error" {
  // Diagnostic only. Opaque provider strings are not a safe reason to discard
  // a failed delivery, even if they contain something resembling an SMTP 5xx.
  const detail = error instanceof Error ? error.message : "";
  return /\b4\d\d\b|\btemporary\b|\btransient\b/i.test(detail) ? "temporary" : "forward-error";
}

export default {
  async email(message: EmailMessage, env?: Env): Promise<void> {
    const groups = configuredDestinations(env?.FANOUT_DESTINATIONS_JSON);
    const alias = servedAlias(message.to);
    if (!isKnownAddress(message.to)) {
      console.warn("njpbs-fanout: alias=unknown category=unconfigured-route using=station-wide");
    }
    const messageId = message.headers?.get("Message-ID")?.trim();
    // Require Message-ID; include the originating Date header to distinguish
    // common constant-ID mailers. Raw MIME and arrival time change on retry. Keep tags in the identity even though routing strips them.
    const identity = messageId && message.from !== undefined
      ? await digest(JSON.stringify(["fanout-v1", message.from, message.to.trim().toLowerCase(), messageId, message.headers?.get("Date") ?? ""]))
      : undefined;
    const ledger = identity && env?.FANOUT_DELIVERIES
      ? ledgerClient(env.FANOUT_DELIVERIES, identity)
      : undefined;
    const destinations = destinationsFor(message.to, groups);
    const unfinished: { key: string; token: string; receiptPending: boolean }[] = [];
    const failed = (index: number, key: string, token: string, category: string) => {
      unfinished.push({ key, token, receiptPending: category === "state-write" });
      console.error(`njpbs-fanout: alias=${alias} destination=${index + 1}/${destinations.length} category=${category}`);
    };

    for (const [index, destination] of destinations.entries()) {
      const token = crypto.randomUUID();
      const key = await digest(destination);
      // A missing binding must not silently disable deduplication for an ID we
      // could already have delivered. This binding is required for identified mail.
      if (identity && !ledger) { failed(index, key, token, "state-read"); continue; }
      if (ledger) {
        try {
          const claim = await ledger.claim(key, token);
          if (claim === "accepted") continue;
          if (claim === "busy") { failed(index, key, token, "in-flight"); continue; }
        } catch { failed(index, key, token, "state-read"); continue; }
      }

      try {
        await message.forward(destination);
      } catch (error) {
        // A rejected forward remains unfinished. Releasing its claim permits
        // a later platform/sender retry without repeating accepted legs.
        if (ledger) {
          try { await ledger.release(key, token); } catch { /* Claim expires. */ }
        }
        failed(index, key, token, failureCategory(error));
        continue;
      }
      if (ledger) {
        try {
          // Await durability before proceeding. waitUntil would race the throw.
          await ledger.accept(key, token);
        } catch {
          // Forwarding resolved, but the receipt is uncertain. Keep the lease
          // and try the token-guarded receipt write once more after the loop.
          failed(index, key, token, "state-write");
        }
      }
    }

    let pending = 0;
    for (const { key, token, receiptPending } of unfinished) {
      // Another invocation may have finished a busy leg, or an acceptance write
      // may have committed despite a lost response. Throw only if still pending.
      if (ledger) {
        if (receiptPending) {
          // A transient write outage need not turn a known acceptance into a
          // duplicate later. The token prevents overwriting a newer claim.
          try { await ledger.accept(key, token); continue; } catch { /* Check status. */ }
        }
        try { if (await ledger.status(key, token) === "accepted") continue; } catch { /* Retry. */ }
      }
      pending += 1;
    }
    if (pending > 0) {
      // A throw preserves the existing retry signal only while work is pending.
      // Cloudflare does not promise an exactly-once handler replay schedule.
      throw new Error(`njpbs-fanout: forwarding failed for ${pending} destination(s).`);
    }
  },
};
