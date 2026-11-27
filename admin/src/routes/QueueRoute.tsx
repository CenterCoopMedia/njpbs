import { Navigate } from "react-router";
import { QueueTab } from "../components/QueueTab";
import { canViewPublishActivity } from "../lib/access";
import { dashboardPath } from "../lib/routes";
import { useShell } from "./ShellContext";

export function QueueRoute() {
  const { principal } = useShell();

  if (!canViewPublishActivity(principal)) {
    return (
      <Navigate
        replace
        to={dashboardPath()}
        state={{
          notice: "Publish activity is available to site administrators.",
        }}
      />
    );
  }

  return <QueueTab />;
}
