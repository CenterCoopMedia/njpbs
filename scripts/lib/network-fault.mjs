// The one repeat rule of the CMS deploy. A call that ends on a lost connection, a timeout,
// a rate limit or a provider's 5xx is sent again until it is answered; each repeat is printed.
// A refused credential and a fault of the source end it at once.
import { setTimeout as pause } from "node:timers/promises";

const refused = /unauthori[sz]ed|authentication (?:error|failed|required)|permission[ _]denied|access (?:to the resource is )?denied|forbidden|invalid (?:api )?token|\bHTTP(?: Error:)? ?40[0134]\b/i;
const lost = /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)\b|connection (?:reset|refused|timed out|closed)|broken pipe|(?:^|[:\s])(?:unexpected )?EOF\s*$|socket hang up|i\/o timeout|TLS handshake timeout|temporary failure in name resolution|fetch failed|(?:request|operation|network) (?:was )?(?:aborted due to )?time(?:d )?-?out|TimeoutError|\bHTTP(?: Error:| status:?| code:?)? ?(?:429|5\d\d)\b|\b(?:500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/i;

/** The line that names the lost connection, from the end of a failure's output, or null. */
export function networkFault(text) {
  const lines = String(text).split("\n").map(line => line.trim()).filter(Boolean).slice(-12);
  return lines.some(line => refused.test(line)) ? null : lines.find(line => lost.test(line))?.slice(0, 300) ?? null;
}

/** What an error says: its message, its causes, and the end of a command's output. */
export function faultText(error) {
  const parts = [];
  for (let at = error; at; at = at.cause) parts.push(at.message, at.code, at.name === "TimeoutError" ? at.name : "");
  return [error?.output, error?.stderr, ...parts].filter(Boolean).join("\n");
}

export async function repeatNetworkFault(label, work, { text = faultText, wait = () => pause(10_000), log = console.log } = {}) {
  for (let repeat = 1; ; repeat++) {
    try { return await work(); }
    catch (error) {
      const fault = networkFault(text(error));
      if (!fault) throw error;
      log(`${label}: ${fault}\nRepeat ${repeat} in 10 s`);
      await wait();
    }
  }
}
