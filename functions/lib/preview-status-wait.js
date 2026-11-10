"use strict";

// One request owns one listener. inspect returns a server-derived deadline only
// while the latest snapshot still warrants waiting; it never exposes the document.
function waitForPreviewStatus({ queueRef, req, res, waitMs, inspect, now = Date.now }) {
  return new Promise((resolve, reject) => {
    const deadline = Number(now()) + waitMs;
    let latest;
    let delayed = false;
    let settled = false;
    let unsubscribe;
    let timer;
    const cancelled = () => settle(Object.assign(new Error("Preview status request cancelled"), { code: "ABORT_ERR" }));
    function cleanup() {
      clearTimeout(timer);
      unsubscribe?.();
      req.off?.("aborted", cancelled);
      res.off?.("close", cancelled);
      res.off?.("finish", cancelled);
    }
    function settle(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ snapshot: latest, delayed });
    }
    function timeout() {
      settle(latest ? undefined : new Error("Preview status wait unavailable"));
    }
    req.once?.("aborted", cancelled);
    res.once?.("close", cancelled);
    res.once?.("finish", cancelled);
    if (req.aborted || res.destroyed) { cancelled(); return; }
    timer = setTimeout(timeout, waitMs);
    try {
      unsubscribe = queueRef.onSnapshot(snapshot => {
        if (settled) return;
        latest = snapshot;
        try {
          const documentDeadline = inspect(snapshot);
          if (documentDeadline === null) { settle(); return; }
          const remaining = Math.min(deadline, documentDeadline) - Number(now());
          if (remaining <= 0) { settle(); return; }
          delayed = true;
          clearTimeout(timer);
          timer = setTimeout(timeout, remaining);
        } catch { settle(new Error("Preview status wait unavailable")); }
      }, () => settle(new Error("Preview status wait unavailable")));
      // A synchronous snapshot/error callback may settle before registration returns.
      if (settled) unsubscribe();
    } catch { settle(new Error("Preview status wait unavailable")); }
  });
}

module.exports = { waitForPreviewStatus };
