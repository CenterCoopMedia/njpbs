import type { BootstrapStage } from "../lib/bootstrap-phases";
import type { StaffAccessMailState } from "../lib/functions";
import type { CmsUserDoc } from "../lib/principal";
import type { Principal } from "../../../packages/content-core/src/rbac";

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName?: string | null;
  emailVerified?: boolean;
}

export interface VerificationHandoff {
  error?: string;
  mailState?: StaffAccessMailState;
}

// `stage` names which admission phase the wait is in (see lib/bootstrap-phases.ts), so the
// bootstrap screen can show real progress rather than one sentence for the whole wait.
export type AuthState =
  | { status: "loading"; stage: BootstrapStage }
  | { status: "signed-out"; sessionEnded?: boolean }
  | {
      status: "email-unverified";
      user: AuthUser;
      verification?: VerificationHandoff;
    }
  | { status: "access-denied"; email: string | null }
  | {
      status: "signed-in";
      user: AuthUser;
      principal: Principal;
      userDoc: CmsUserDoc | null;
    }
  | { status: "error"; error: Error };

export type AuthAction =
  | { type: "loading"; stage: BootstrapStage }
  | { type: "signed-out"; sessionEnded?: boolean }
  | {
      type: "email-unverified";
      user: AuthUser;
      verification?: VerificationHandoff;
    }
  | { type: "access-denied"; email: string | null }
  | {
      type: "signed-in";
      user: AuthUser;
      principal: Principal;
      userDoc: CmsUserDoc | null;
    }
  | { type: "error"; error: Error };

export function authReducer(_state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "loading":
      return { status: "loading", stage: action.stage };
    case "signed-out":
      return action.sessionEnded
        ? { status: "signed-out", sessionEnded: true }
        : { status: "signed-out" };
    case "email-unverified":
      return {
        status: "email-unverified",
        user: action.user,
        ...(action.verification ? { verification: action.verification } : {}),
      };
    case "access-denied":
      return { status: "access-denied", email: action.email };
    case "signed-in":
      return {
        status: "signed-in",
        user: action.user,
        principal: action.principal,
        userDoc: action.userDoc,
      };
    case "error":
      return { status: "error", error: action.error };
  }
}
