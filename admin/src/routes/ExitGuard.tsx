import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import type { ExitSaveOutcome } from "../lib/exit-save";

// The one place an exit that is not a route change asks about unsaved work (#1032).
//
// Route changes are held by the content layout's own blocker, because only a router can stop a
// navigation. Sign-out is not a route change: it ends the session from the shell, above the
// editor, and used to run straight past every guard the editor had. This context is the seam
// between the two. The editor registers what it knows — whether a save is in flight, whether any
// work is still unsaved, and how to commit it — and the shell asks through requestExit before it
// does anything that would lose that work.
//
// One registration, so there is one dirty state rather than a second opinion living in the shell.
// Whichever surface is mounted owns it; a surface with nothing at stake registers nothing and
// every exit runs immediately.

export interface ExitGuardContract {
  // Whether a save is in flight right now. An exit asked for during a save is held, not refused:
  // the person clicked without knowing how the save would settle, so the answer waits for it.
  saving: boolean;
  // The exact answer to "is any of this still unsaved", asked once at the boundary.
  hasUnsavedWork: () => boolean;
  // Commit the work, reporting what actually settled: saved, failed, or saved here while other
  // work from this session is still unsaved. Absent when the surface has no save of its own to
  // offer. Only "saved" lets an exit through.
  save?: () => Promise<ExitSaveOutcome>;
}

interface ExitGuardValue {
  register: (contract: ExitGuardContract | null) => void;
  requestExit: (proceed: () => void) => void;
}

const ExitGuardContext = createContext<ExitGuardValue | null>(null);

interface PendingExit {
  proceed: () => void;
  // "save-hold" is silent and released when the save settles; "confirm" is the prompt.
  mode: "save-hold" | "confirm";
}

export function ExitGuardProvider({ children }: { children: ReactNode }) {
  const [contract, setContract] = useState<ExitGuardContract | null>(null);
  const contractRef = useRef<ExitGuardContract | null>(null);
  contractRef.current = contract;
  const [pending, setPending] = useState<PendingExit | null>(null);

  const register = useCallback((next: ExitGuardContract | null) => {
    setContract(next);
  }, []);

  const requestExit = useCallback((proceed: () => void) => {
    const current = contractRef.current;
    if (!current) {
      proceed();
      return;
    }
    if (current.saving) {
      setPending({ proceed, mode: "save-hold" });
      return;
    }
    if (!current.hasUnsavedWork()) {
      proceed();
      return;
    }
    setPending({ proceed, mode: "confirm" });
  }, []);

  // Release a held exit once the save it was waiting on settles, then ask the question again
  // against what the save actually left behind. A save that landed clean lets the exit through,
  // which is what the person asked for; one that failed or left an in-flight edit raises the
  // prompt, so a failed save is never read as permission to leave.
  useEffect(() => {
    if (!pending || pending.mode !== "save-hold") return;
    if (contract?.saving) return;
    setPending(null);
    requestExit(pending.proceed);
  }, [contract, pending, requestExit]);

  const value = useMemo(() => ({ register, requestExit }), [register, requestExit]);

  return (
    <ExitGuardContext.Provider value={value}>
      {children}
      {pending?.mode === "confirm" ? (
        <LeaveGuardDialog
          onSave={contract?.save}
          onConfirm={() => {
            const { proceed } = pending;
            setPending(null);
            proceed();
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </ExitGuardContext.Provider>
  );
}

// The shell's side: ask before an exit that is not a route change. Outside a provider the exit
// simply happens, so a component rendered in isolation (a test, the design gallery) behaves as
// it did before the guard existed.
export function useExitGuard(): (proceed: () => void) => void {
  const value = useContext(ExitGuardContext);
  return useCallback(
    (proceed: () => void) => {
      if (!value) {
        proceed();
        return;
      }
      value.requestExit(proceed);
    },
    [value],
  );
}

// The editor's side: publish what this surface knows about unsaved work for as long as it is
// mounted. The registration is replaced whenever any part of it changes, and cleared on unmount,
// so a surface that is gone never answers for work nobody is doing.
export function useRegisterExitGuard(contract: ExitGuardContract | null): void {
  const value = useContext(ExitGuardContext);
  const register = value?.register;
  const { saving = false, hasUnsavedWork, save } = contract ?? {};

  useEffect(() => {
    if (!register) return;
    if (!hasUnsavedWork) {
      register(null);
      return;
    }
    register({ saving, hasUnsavedWork, save });
    return () => register(null);
  }, [register, saving, hasUnsavedWork, save]);
}
