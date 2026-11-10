"use strict";

// Scheduler logging otherwise drops AggregateError.errors. Emit bounded error
// categories and local source locations, never messages, content or URLs.
function confirmationErrorCauses(error) {
  const pending = [error], causes = [];
  let scanned = 0;
  while (pending.length && causes.length < 8 && scanned++ < 16) {
    const current = pending.shift();
    if (current instanceof AggregateError && current.errors.length) {
      pending.push(...current.errors.slice(0, 8));
      continue;
    }
    const names = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "FirebaseError", "GoogleError"];
    const codes = ["permission-denied", "failed-precondition", "unavailable", "not-found", "deadline-exceeded",
      "record_publication_unavailable", "record_publication_replaced", "settings_publication_unavailable",
      "storage/unauthorized", "storage/object-not-found", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EACCES"];
    // A multiline message can contain text shaped like a local stack frame.
    const header = `${current?.name}: ${current?.message}`, stack = current?.stack;
    const frames = typeof stack === "string" && stack.startsWith(`${header}\n`) ? stack.slice(header.length + 1) : "";
    const source = frames.match(/\/(lib\/[a-z0-9-]+\.js|no-build-post-confirmation\.js):(\d+):(\d+)/);
    causes.push({ name: names.includes(current?.name) ? current.name : "Error",
      ...(codes.includes(current?.code) || Number.isInteger(current?.code) && current.code >= 1 && current.code <= 599 ? { code: current.code } : {}),
      ...(Number.isInteger(current?.status) && current.status >= 400 && current.status <= 599 ? { status: current.status } : {}),
      ...(source ? { source: `${source[1]}:${source[2]}:${source[3]}` } : {}) });
  }
  return causes;
}

module.exports = { confirmationErrorCauses };
