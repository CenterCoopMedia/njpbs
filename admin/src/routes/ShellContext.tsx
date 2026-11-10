import { createContext, useContext, type ReactNode } from "react";
import type { AuthUser } from "../context/authReducer";
import type { NavigationShare } from "../lib/navigation-shares";
import type { CmsUserDoc } from "../lib/principal";
import type { Principal } from "../../../packages/content-core/src/rbac";

// The signed-in shell's data, provided above RouterProvider so every route element reads a
// single narrowed value instead of re-deriving it from the auth-state union. App only mounts the
// router once the principal has loaded and admin access is confirmed, so a route element can
// treat these as present. Keeping the router's dependency here (not on AuthContext directly) is
// what lets the route tree be exercised in tests with a plain provider and a memory router.
export interface ShellData {
  principal: Principal;
  user: AuthUser;
  userDoc: CmsUserDoc | null;
  signOut: () => Promise<void> | void;
  /**
   * A fresh ID token for the signed-in session. Optional because the component
   * gallery mounts the layout with no session behind it; a shell surface that
   * uses it treats its absence as "no data", never as an error.
   */
  getIdToken?: () => Promise<string>;
  /** Gallery fixture. A signed-in shell loads the collection itself. */
  navigationShares?: readonly NavigationShare[];
}

const ShellContext = createContext<ShellData | null>(null);

export function ShellProvider({
  value,
  children,
}: {
  value: ShellData;
  children: ReactNode;
}) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellData {
  const value = useContext(ShellContext);
  if (!value) {
    throw new Error("useShell must be used within a ShellProvider");
  }
  return value;
}

export function useOptionalShell(): ShellData | null {
  return useContext(ShellContext);
}
