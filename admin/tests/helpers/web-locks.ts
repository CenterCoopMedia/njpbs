import { vi } from "vitest";

interface PendingLock {
  callback: (lock: Lock) => unknown;
  canceled: boolean;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
  started: boolean;
}

export function installTestLockManager() {
  const active = new Set<string>();
  const waiting = new Map<string, PendingLock[]>();

  function startNext(name: string) {
    if (active.has(name)) return;
    const queue = waiting.get(name) ?? [];
    const next = queue.shift();
    if (queue.length === 0) waiting.delete(name);
    if (!next) return;
    if (next.canceled) {
      startNext(name);
      return;
    }
    active.add(name);
    next.started = true;
    void Promise.resolve()
      .then(() => next.callback({ name, mode: "exclusive" } as Lock))
      .then(next.resolve, next.reject)
      .finally(() => {
        active.delete(name);
        startNext(name);
      });
  }

  const request = vi.fn((name: string, options: LockOptions, callback: (lock: Lock) => unknown) => new Promise<unknown>((resolve, reject) => {
    const entry: PendingLock = { callback, canceled: false, reject, resolve, started: false };
    const cancel = () => {
      if (entry.started || entry.canceled) return;
      entry.canceled = true;
      reject(new DOMException("Lock request canceled", "AbortError"));
      startNext(name);
    };
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    options.signal?.addEventListener("abort", cancel, { once: true });
    const queue = waiting.get(name) ?? [];
    queue.push(entry);
    waiting.set(name, queue);
    startNext(name);
  }));

  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return request;
}
