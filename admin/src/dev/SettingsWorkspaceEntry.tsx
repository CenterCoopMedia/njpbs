import { ControlPresentationProvider } from "../context/ControlPresentationContext";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { ShellLayout } from "../routes/ShellLayout";
import { ShellProvider, type ShellData } from "../routes/ShellContext";
import { AdminSettingsFrame } from "../routes/AdminSettingsRoute";
import { SettingsWorkspaceSpecimen } from "./SettingsWorkspaceSpecimen";
import "../styles.css";
import "../cms-workspace.css";
import "../design-system/editorial.css";

const principal = { id: "settings-fixture", grants: [{ role: "super_admin" as const }] };
const shell: ShellData = {
  principal, user: { uid: principal.id, email: "editor@example.org", displayName: "Sample editor" },
  userDoc: { role: "super_admin", grants: principal.grants, displayName: "Sample editor", email: "editor@example.org" },
  signOut: () => {}, navigationShares: [],
};
const router = createBrowserRouter([{ path: "/", element: <ShellLayout />, children: [
  { path: "settings-workspace.html", element: <AdminSettingsFrame><SettingsWorkspaceSpecimen /></AdminSettingsFrame>, handle: { title: "Admin settings", description: "Manage public presentation and newsroom defaults." } },
] }]);
createRoot(document.getElementById("root")!).render(<ControlPresentationProvider value={new URLSearchParams(location.search).get("presentation") === "text" ? "text" : "icons"}><ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider></ControlPresentationProvider>);
