import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useShell } from "./ShellContext";
import { dashboardPath } from "../lib/routes";
import type { Principal } from "../../../packages/content-core/src/rbac";

// Gate a capability-scoped route. A principal without the capability is sent to newsroom home
// (the first destination every admitted account can reach) with a short notice, rather than
// shown a surface their role cannot use. The route tree itself stays static; this controls only
// what renders, so a capability change takes effect on the next navigation without rebuilding
// the router.
export function RequireCapability({
  allowed,
  notice,
  children,
}: {
  allowed: (principal: Principal) => boolean;
  notice: string;
  children: ReactNode;
}) {
  const { principal } = useShell();
  if (!allowed(principal)) {
    return <Navigate to={dashboardPath()} replace state={{ notice }} />;
  }
  return <>{children}</>;
}
