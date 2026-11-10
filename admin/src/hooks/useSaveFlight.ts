import { useRef } from "react";

type SaveRunner<T> = (start: () => T | PromiseLike<T>) => Promise<T>;

function createSaveRunner<T>(): SaveRunner<T> {
  let active: Promise<T> | null = null;
  return start => {
    if (active) return active;
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    // Own the operation before validation or any callback can yield/reenter.
    active = pending;
    const clear = () => { if (active === pending) active = null; };
    void pending.then(clear, clear);
    try {
      const result = start();
      // Synchronous validation and in-memory hosts are already finished. Do not
      // turn their next edit/save in this turn into a join of completed work.
      if (result == null || typeof (result as PromiseLike<T>).then !== "function") clear();
      resolve(result);
    } catch (error) {
      clear();
      reject(error);
    }
    return pending;
  };
}

/** Share one mounted editor's pending save; this neither queues nor retries writes. */
export function useSaveFlight<T>(identity = ""): SaveRunner<T> {
  const state = useRef<{ identity: string; run: SaveRunner<T> }>();
  if (!state.current || state.current.identity !== identity) {
    state.current = { identity, run: createSaveRunner<T>() };
  }
  return state.current.run;
}
