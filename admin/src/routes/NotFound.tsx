import { useNavigate } from "react-router";
import { Button, Panel } from "../components/ui/Primitives";
import { dashboardPath } from "../lib/routes";

// The in-app not-found surface. A denied or mistyped URL lands here with a clear way back to a
// known-good destination rather than an empty screen or a hard browser error. Reused by the
// top-level catch-all and by the content layout when a `/content/**` sub-path does not resolve
// to a real editor surface.
export function NotFoundBody({
  heading,
  message,
  children,
}: {
  heading: string;
  message: string;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Panel className="not-found-panel" aria-labelledby="not-found-heading">
      <h2 id="not-found-heading">{heading}</h2>
      <p>{message}</p>
      <div className="button-row">
        <Button variant="primary" onClick={() => navigate(dashboardPath())}>
          Go to newsroom home
        </Button>
        {children}
      </div>
    </Panel>
  );
}

// The route element for a top-level unmatched path.
export function NotFoundRoute() {
  return (
    <NotFoundBody
      heading="This page doesn't exist"
      message="The address you followed isn't part of Boardwalk. It may have changed, or the link may be wrong."
    />
  );
}
