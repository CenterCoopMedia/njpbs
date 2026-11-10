import { useCallback, useState } from "react";

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** A changed key loads its own value. Blocked storage keeps state for this visit. */
export function useStoredState<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string) {
  const [state, setState] = useState(() => ({ key, value: parse(readStorage(key)) }));
  const value = state.key === key ? state.value : parse(readStorage(key));
  if (state.key !== key) setState({ key, value });
  const set = useCallback((next: T, persist = true) => {
    setState({ key, value: next });
    if (!persist) return;
    try {
      globalThis.localStorage?.setItem(key, serialize(next));
    } catch {
      // Private windows and blocked storage keep the state for this visit only.
    }
  }, [key, serialize]);
  return [value, set] as const;
}
