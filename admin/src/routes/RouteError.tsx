import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { Button, Panel } from "../components/ui/Primitives";
import { dashboardPath } from "../lib/routes";

// Reads whatever React Router caught into something worth putting on screen. A thrown Response
// (a loader's 404/403) carries its own status text; a thrown Error carries a message. Anything
// else is a value nobody meant to throw, and it still gets a line: the copy below tells the
// reader to send the detail on, and pointing them at a blank space is worse than admitting there
// was nothing to read.
function describe(error: unknown): string {
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText}`.trim();
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "No error message was included.";
}

// The error surface for a crashed route.
//
// This sits on a pathless route *inside* the shell rather than on the shell route itself, which
// is the whole point: React Router replaces the element of the route the errorElement is declared
// on, so declaring it on the shell would unmount the sidebar, header, and heading -- exactly the
// blanked screen this is here to prevent (#626). Nested here, a crashed surface degrades to this
// panel in the shell's outlet and everything around it keeps working.
//
// The detail line and console.error identify the component failure so the person
// diagnosing it can distinguish it from a missing heading or route.
export function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const detail = describe(error);

  // The boundary stops the throw from reaching the console on its own, and a swallowed stack is
  // how the original crash stayed hidden.
  console.error("Admin route surface crashed:", error);

  return (
    <Panel className="route-error-panel" aria-labelledby="route-error-heading">
      <h2 id="route-error-heading">
        This part of the newsroom stopped working
      </h2>
      <p>
        The rest of the CMS is still running, so your other work is unaffected.
        Reloading usually clears it; if it keeps happening, send the detail
        below along with what you were doing.
      </p>
      <p className="route-error-detail">{detail}</p>
      <div className="button-row">
        <Button variant="primary" onClick={() => navigate(dashboardPath())}>
          Go to newsroom home
        </Button>
        <Button onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      </div>
    </Panel>
  );
}
