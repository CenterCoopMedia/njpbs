import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { CuezTransferWorkspace } from "../components/cuez-transfer-workspace";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import { ControlPresentationProvider } from "../context/ControlPresentationContext";
import { createCuezFixtureApi } from "./cuez-fixtures";
import "../styles.css";

const params = new URLSearchParams(window.location.search);
const api = createCuezFixtureApi(params.get("mode") ?? "ready");
const principal = { id: "fixture-editor", grants: [{ role: "admin" as const }] };
const shell: ShellData = { principal, user: { uid: "fixture-editor", email: "editor@example.test", displayName: "Sample editor" },
  userDoc: { role: "admin", displayName: "Sample editor" }, signOut: () => {}, navigationShares: [] };
const router = createMemoryRouter([{ path: "/", element: <ShellLayout />, children: [{ path: "cuez-storydesk", element: <CuezTransferWorkspace api={api} />,
  handle: { title: "StoryDesk", description: "Selected transfers between Boardwalk and StoryDesk." } }] }], { initialEntries: ["/cuez-storydesk"] });
createRoot(document.getElementById("root")!).render(<ControlPresentationProvider value={params.get("presentation") === "text" ? "text" : "icons"}>
  <ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>
</ControlPresentationProvider>);
