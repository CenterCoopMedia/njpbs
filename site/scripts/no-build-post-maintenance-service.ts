import type { Firestore } from "firebase-admin/firestore";

// Events are hints. The transaction claim and exact runtime release decide who
// can work. A single drain coalesces duplicates and waits for work on shutdown.
export function startNoBuildPostMaintenanceService({ firestore, maintain, onWake }: {
  firestore: Firestore;
  maintain: () => Promise<void>;
  onWake?: () => void;
}) {
  let stopped = false;
  let running = false;
  let requested = false;
  let failure: unknown;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const closed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const watchers: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const finish = () => { if (stopped && !running) { if (failure) reject(failure); else resolve(); } };
  const stop = (error?: unknown) => {
    stopped = true;
    failure ??= error;
    clearInterval(timer);
    for (const detach of watchers.splice(0)) detach();
    finish();
  };
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while (requested && !stopped) { requested = false; await maintain(); }
    } catch (error) { stop(error); }
    finally { running = false; finish(); }
  };
  const wake = () => { if (stopped) return; onWake?.(); requested = true; void drain(); };
  // Both detail changes and unrelated public-context changes need a pass.
  try {
    const sources = [firestore.collection("system/publicDeployment/noBuildPostOwners"),
      ...["system/publicDeployment/noBuildPosts/current", "system/publicDeployment/noBuildPosts/capability",
        "system/publicDeployment/contexts/public", "system/publicDeployment/aggregateContexts/current", "system/publicDeployment/externalRefresh/current"].map(document => firestore.doc(document))];
    for (const source of sources) {
      if (stopped) break;
      const detach = source.onSnapshot(wake, stop);
      if (stopped) detach();
      else watchers.push(detach);
    }
  } catch (error) { stop(error); }
  if (stopped) return { closed, stop: () => stop(), wake, isRunning: () => running };
  timer = setInterval(wake, 60_000);
  timer.unref();
  wake();
  return { closed, stop: () => stop(), wake, isRunning: () => running };
}
