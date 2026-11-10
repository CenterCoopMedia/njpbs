import { useState } from "react";
import { UsersTab } from "../components/UsersTab";
import { StaffAccessRequestsPanel } from "../components/StaffAccessRequestsPanel";
import { RequireCapability } from "./RequireCapability";
import { canViewUsers, canManageRoles } from "../lib/access";
import { useShell } from "./ShellContext";
import "./StaffRoute.css";

// The staff-access route. Viewing the roster needs users.view; managing roles is the higher
// roles.grant capability, passed to UsersTab so a viewer sees the roster read-only and a role
// manager gets the controls. The manage capability is read here rather than folded into the
// view gate so the two powers stay independent (a viewer is admitted, but without the controls).
export function StaffRoute() {
  const { principal } = useShell();
  const canManage = canManageRoles(principal);
  const [tiersActive, setTiersActive] = useState(false);
  return (
    <RequireCapability
      allowed={canViewUsers}
      notice="Staff access isn't available for your account."
    >
      <div className="staff-access-route">
        <header className="staff-access-overview">
          <div>
            <h2>Staff access</h2>
            <p>
              Review staff access and sign-in. Change one account at a time.
            </p>
          </div>
          <dl className="staff-access-model" aria-label="Access model">
            <div>
              <dt>Access</dt>
              <dd>Review what each person can do</dd>
            </div>
            <div>
              <dt>Account state</dt>
              <dd>Active or deactivated</dd>
            </div>
            <div>
              <dt>{tiersActive ? "Owner controls" : "Site owner controls"}</dt>
              <dd>Access changes and offboarding</dd>
            </div>
          </dl>
        </header>
        <div className="staff-access-workspace">
          {canManage ? <StaffAccessRequestsPanel tiersActive={tiersActive} /> : null}
          <UsersTab canManage={canManage} onActivationChange={setTiersActive} />
        </div>
      </div>
    </RequireCapability>
  );
}
