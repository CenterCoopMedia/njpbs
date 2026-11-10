import { Navigate } from "react-router";
import { QueueTab } from "../components/QueueTab";
import { canViewEditorialQueue } from "../lib/access";
import { dashboardPath } from "../lib/routes";
import { useShell } from "./ShellContext";

export function QueueRoute() {
  const { principal } = useShell();

  if (!canViewEditorialQueue(principal)) {
    return (
      <Navigate
        replace
        to={dashboardPath()}
        state={{
          notice:
            "The editorial queue is available to staff who can review content.",
        }}
      />
    );
  }

  return <QueueTab />;
}
