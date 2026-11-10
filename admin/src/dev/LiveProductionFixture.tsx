import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LiveProductionProvider } from "../context/LiveProductionContext";
import { ExitGuardProvider } from "../routes/ExitGuard";
import { LiveProductionWorkspace, StudioFrame } from "../routes/LiveProductionRoute";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider } from "../routes/ShellContext";
import { fakeClient } from "../../tests/live-production-fixtures";
import { fakeRundownClient } from "../../tests/rundown-fixtures";
import "../styles.css";
import "../cms-workspace.css";

// Local synthetic client only; both hosts use their real layout owners.
const client = fakeClient({ onAir: new URLSearchParams(location.search).has("updateLive") });
const rundownClient = new URLSearchParams(location.search).has("rundown") ? fakeRundownClient() : undefined;
const principal = { id: "fixture-producer", grants: [{ role: "editor" as const }] };
const studio = new URLSearchParams(location.search).get("host") === "studio";
const router = createMemoryRouter(studio ? [{ path: "/studio", element:
  <ExitGuardProvider><StudioFrame><LiveProductionWorkspace client={client} variant="studio" rundownClient={rundownClient} /></StudioFrame></ExitGuardProvider>,
}] : [{ path: "/", element: <ShellLayout />, children: [{ path: "live-production",
  element: <LiveProductionWorkspace client={client} rundownClient={rundownClient} />,
  handle: { title: "Live production", description: "Prepare banners and deliberately control Overlay 1." },
}] }], { initialEntries: [studio ? "/studio" : "/live-production"] });

createRoot(document.getElementById("root")!).render(<ShellProvider value={{ principal,
  user: { uid: principal.id, email: "producer@example.test", displayName: "Studio producer" },
  userDoc: { role: null, grants: principal.grants, displayName: "Studio producer" },
  signOut: () => {}, navigationShares: [],
}}><LiveProductionProvider><RouterProvider router={router} /></LiveProductionProvider></ShellProvider>);
