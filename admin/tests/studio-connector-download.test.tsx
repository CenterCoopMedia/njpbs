import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedStudioConnectorDownload, StudioConnectorDownload, type ConnectorTransport } from "../src/components/StudioConnectorDownload";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LiveProductionWorkspace } from "../src/routes/LiveProductionRoute";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { fakeClient } from "./live-production-fixtures";

const sourceSha = "7786c6693887b2d9ecb14c57ce78042d34150a4e";
const details = { available: true as const, sourceSha,
  sha256: "792be25d72a7c376b702839c48df32e08bbd42a29310a267818fb56ac68c4444",
  bundleSha256: "9db6897273ae4a8dc6019aa1ef77f4442312488b33109f9eddc710662d75b843",
  filename: "NJPBS-Studio-connector-7786c669.zip", sizeBytes: 37357523, nodeVersion: "22.23.4" };
const download = { ...details, url: "https://fixture.r2.cloudflarestorage.com/fixture/package.zip", expiresAtMs: 300000 };
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("Studio connector download", () => {
  it.each(["boardwalk", "studio"] as const)("loads only after Studio setup opens in %s Prepare", async variant => {
    let metadataRequests = 0;
    const send: ConnectorTransport = async () => { metadataRequests++; return details; };
    const widget = <StudioConnectorDownload sourceSha={sourceSha} send={send} />;
    const router = createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={fakeClient()} variant={variant} connectorDownload={widget} /> }]);
    render(<ExitGuardProvider><RouterProvider router={router} /></ExitGuardProvider>);
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    expect(metadataRequests).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    expect(metadataRequests).toBe(0);
    fireEvent.click(screen.getByText("Studio setup", { selector: "summary" }));
    expect(await screen.findByText(details.sha256)).toBeVisible();
    expect(metadataRequests).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText(details.sha256)).not.toBeVisible();
    expect(metadataRequests).toBe(1);
  });
  it("shows the exact source and checksum before a deliberate download", async () => {
    let release: ((value: typeof details) => void) | undefined;
    const save = vi.fn();
    const send: ConnectorTransport = async action => action === "get_connector_package"
      ? new Promise(resolve => { release = resolve; }) : download;
    render(<StudioConnectorDownload send={send} sourceSha={sourceSha} save={save} />);
    expect(screen.getByRole("button", { name: "Download for Windows" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    await act(async () => { release!(details); });
    expect(await screen.findByText(details.sha256)).toBeVisible();
    expect(screen.getByText(sourceSha)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Download for Windows" }));
    await screen.findByText(/Your download should start/);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].sha256).toBe(details.sha256);
  });
  it("announces an unavailable release and keeps its download disabled", async () => {
    render(<StudioConnectorDownload send={async () => ({ available: false, sourceSha })} sourceSha={sourceSha} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/not available yet/));
    expect(screen.getByRole("button", { name: "Download for Windows" })).toBeDisabled();
  });
  it("does not download a changed checksum and permits explicit recovery", async () => {
    let changed = true;
    const save = vi.fn();
    const send: ConnectorTransport = async action => action === "get_connector_package" ? details
      : { ...download, sha256: changed ? "b".repeat(64) : details.sha256 };
    render(<StudioConnectorDownload send={send} sourceSha={sourceSha} save={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download for Windows" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Download for Windows" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be prepared/);
    expect(save).not.toHaveBeenCalled();
    changed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download for Windows" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Download for Windows" }));
    await screen.findByText(/Your download should start/);
    expect(save).toHaveBeenCalledOnce();
  });
  it("cancels a pending download when its section unmounts", async () => {
    let finish: ((value: typeof download) => void) | undefined;
    const save = vi.fn();
    const send: ConnectorTransport = async action => action === "get_connector_package" ? details
      : new Promise(resolve => { finish = resolve; });
    const view = render(<StudioConnectorDownload send={send} sourceSha={sourceSha} save={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download for Windows" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Download for Windows" }));
    view.unmount();
    await act(async () => { finish!(download); });
    expect(save).not.toHaveBeenCalled();
  });
  it("keeps provider details out of its error message", async () => {
    render(<StudioConnectorDownload send={async () => { throw new Error("synthetic-provider-secret"); }} sourceSha={sourceSha} />);
    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent("synthetic-provider-secret");
  });
  it("hides the connected section from a writer", () => {
    vi.stubEnv("VITE_LIVE_PRODUCTION_ENABLED", "true");
    const shell = { principal: { id: "writer", grants: [{ role: "writer" }] }, user: { uid: "writer" },
      userDoc: null, signOut: () => {} } as unknown as ShellData;
    render(<ShellProvider value={shell}><ConnectedStudioConnectorDownload /></ShellProvider>);
    expect(screen.queryByRole("heading", { name: "Studio connector for Windows" })).not.toBeInTheDocument();
  });
});
