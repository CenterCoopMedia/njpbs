import { useState } from "react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { LiveProductionDevices, type DeviceTransport } from "../src/components/LiveProductionDevices";
import { RequireCapability } from "../src/routes/RequireCapability";
import { ShellProvider } from "../src/routes/ShellContext";
import { canUseLiveProduction } from "../src/lib/live-production-access";
import { canManageSettings } from "../src/lib/access";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { LiveProductionWorkspace } from "../src/routes/LiveProductionRoute";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const studioFixture = vi.hoisted(() => {
  const preset = { schemaVersion: 1, vmixHost: "127.0.0.1", vmixPort: 12345,
    apiAccessMode: "loopback-without-login", backgroundInput: 500,
    inputs: { headline: 501, name_title: 502 }, overlayInputs: { headline: 503, name_title: 504 },
    titleFiles: { headline: "Example headline.gtzip", name_title: "Example name-title.gtzip" } };
  vi.stubEnv("VITE_CMS_STUDIO_CONFIGURATION", JSON.stringify(preset));
  vi.stubEnv("VITE_FUNCTIONS_BASE_URL", "https://studio.example.test");
  return preset;
});
import { createRequire } from "node:module";
const requests = createRequire(import.meta.url)("../../functions/lib/live-production-requests.js") as { parseRequest(body: unknown): unknown };
import { LiveProductionStudioSetup } from "../src/routes/LiveProductionStudioSetup";
import { connectorSetup, parseStudioInputs, STUDIO_INPUT_FILE_LIMIT } from "../src/lib/live-production-setup";
import { createLiveProductionClient, type LiveRequest, type SessionView } from "../src/lib/live-production-workspace";
import { fakeClient, sessionView } from "./live-production-fixtures";

// Synthetic native identities exercise text and overlay input matching.
const details = { inputs: { headline: { key: "gt-headline", number: 501, title: "Synthetic headline title" },
  name_title: { key: "gt-name-title", number: 502, title: "Synthetic name-title title" } },
  overlayInputs: { headline: { key: "banner-headline", number: 503, title: "Synthetic headline overlay" },
    name_title: { key: "banner-name-title", number: 504, title: "Synthetic name-title overlay" } } };
const devices = [{ id: "second-pc", name: "Second PC", active: true, state: "enrolled", sessionId: null }, { id: "studio-pc", name: "Studio PC", active: true, state: "enrolled", sessionId: null },
  { id: "revoked-pc", name: "Revoked PC", active: false, state: "revoked", sessionId: null },
  { id: "busy-pc", name: "Busy PC", active: true, state: "enrolled", sessionId: "other-session" }];
function initial(): SessionView {
  const view = sessionView();
  return { ...view, session: { ...view.session, state: "draft", deviceId: null },
    mapping: { ...view.mapping, deviceId: null, state: "uncommissioned", inputs: { headline: null, name_title: null }, verifiedAtMs: null },
    fences: { ...view.fences, active: false }, observed: { ...view.observed, state: "unknown", report: null } };
}
function harness(start = initial()) {
  let saved = structuredClone(start);
  const calls: LiveRequest[] = [];
  const mutations = vi.fn(async (body: LiveRequest): Promise<Record<string, unknown>> => {
    // Exercise the real staff request parser and shared response parsers at this HTTP seam.
    requests.parseRequest(JSON.parse(JSON.stringify(body)));
    calls.push(body);
    if (body.action === "get_session") return { success: true, ...saved };
    if (body.action === "set_mapping") {
      saved = { ...saved, session: { ...saved.session, deviceId: "studio-pc", mappingVersion: 2, generation: 2, state: "draft" },
        mapping: { schemaVersion: 1, sessionId: "rehearsal", deviceId: "studio-pc", version: 2, overlay: 1,
          state: "uncommissioned", ...details, verifiedAtMs: null }, commissioning: null,
        fences: { ...saved.fences, sessionGeneration: 2, mappingVersion: 2, active: false } };
      return { success: true, session: saved.session, mapping: saved.mapping };
    }
    if (body.action === "set_session_state") {
      saved = { ...saved, session: { ...saved.session, state: body.state }, fences: { ...saved.fences, active: body.state === "active" } };
      return { success: true, session: saved.session };
    }
    throw new Error("Unexpected network request");
  });
  const readDevices = vi.fn(async () => ({ success: true, devices, nextCursor: null }));
  const client = createLiveProductionClient(mutations, undefined, readDevices);
  function Harness() {
    const [view, setView] = useState(start);
    const refresh = () => { void client.session("rehearsal").then(setView); };
    return <LiveProductionStudioSetup client={client} view={{ ...view, requestStartedAt: 0 }} connected disabled={false}
      observedLabel="Unknown" onDirtyChange={dirty} onBusyChange={busy} onUpdated={refresh} onRefresh={refresh} />;
  }
  const dirty = vi.fn(), busy = vi.fn();
  render(<Harness />);
  return { calls, mutations, readDevices, client, dirty, verify() {
    saved = { ...saved, mapping: { ...saved.mapping, state: "commissioned", verifiedAtMs: 1792684800000 } };
  } };
}
async function loadFile(value: unknown = details) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const file = new File([text], "studio-inputs.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => text });
  fireEvent.change(screen.getByLabelText("Load studio input details"), { target: { files: [file] } });
  await waitFor(() => expect(screen.queryByText("Reading studio input details…")).not.toBeInTheDocument());
}
async function prepare() {
  await screen.findByRole("option", { name: "Studio PC · studio-pc" });
  fireEvent.change(screen.getByLabelText("Paired studio PC"), { target: { value: "studio-pc" } });
  await loadFile();
  fireEvent.click(screen.getByLabelText("I confirmed both GT title files with the studio operator"));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("studio setup handoff contract", () => {
  it.each([null, 0, 1000, Date.UTC(2025, 11, 31, 23, 59, 59, 999)])("does not display a missing or pre-2026 verification time as a date (%s)", async verifiedAtMs => {
    const view = initial();
    harness({ ...view, mapping: { ...view.mapping, verifiedAtMs } });
    await screen.findByRole("option", { name: "Studio PC · studio-pc" });
    expect(screen.getByText(/Saved mapping version:/)).toHaveTextContent("Last verification: Not verified yet.");
  });
  it.each([null, 0, 1000, Date.UTC(2025, 11, 31, 23, 59, 59, 999)])("preserves commissioned status when the verification time is unavailable (%s)", async verifiedAtMs => {
    const view = sessionView();
    harness({ ...view, mapping: { ...view.mapping, verifiedAtMs } });
    await screen.findByRole("option", { name: "Studio PC · studio-pc" });
    expect(screen.getByText(/Saved mapping version:/)).toHaveTextContent("Last verification: Verification time unavailable.");
  });
  it("shows a valid verification date in studio time", async () => {
    const view = initial();
    harness({ ...view, mapping: { ...view.mapping, verifiedAtMs: Date.UTC(2026, 9, 25, 12) } });
    await screen.findByRole("option", { name: "Studio PC · studio-pc" });
    expect(screen.getByText(/Saved mapping version:/)).toHaveTextContent("Last verification: 10/25/2026, 8:00:00 AM EDT.");
  });
  it("accepts only the four exact input identities, with a byte budget", () => {
    expect(parseStudioInputs(JSON.stringify(details))).toEqual(details);
    for (const value of [{ ...details, token: "unexpected" }, { ...details, inputs: { ...details.inputs, headline: { ...details.inputs.headline, secret: "unexpected" } } },
      { ...details, overlayInputs: { ...details.overlayInputs, headline: { ...details.overlayInputs.headline, number: 505 } } },
      { ...details, inputs: { ...details.inputs, headline: { ...details.inputs.headline, key: "" } } }]) {
      expect(() => parseStudioInputs(JSON.stringify(value))).toThrow(/only the four distinct input identities/);
    }
    expect(() => parseStudioInputs("x".repeat(STUDIO_INPUT_FILE_LIMIT + 1))).toThrow(/16 KiB/);
  });
  it("exports only nonsecret connector fields with the exact saved mapping version", () => {
    const view = initial();
    expect(() => connectorSetup(view)).toThrow(/Save the four/);
    const mapping = { ...view.mapping, ...details, deviceId: "studio-pc", version: 4 };
    const result = JSON.parse(connectorSetup({ ...view, session: { ...view.session, deviceId: "studio-pc", mappingVersion: 4 }, mapping }));
    expect(result).toEqual({ endpoint: "https://studio.example.test/cmsLiveProductionAgent", deviceId: "studio-pc", sessionId: "rehearsal", vmixPort: 12345,
      exclusiveOverlay1: true, titleFilesConfirmed: true, mapping });
  });
  it("refuses missing or malformed startup configuration before producing a handoff", async () => {
    const view = initial();
    const saved = { ...view, session: { ...view.session, deviceId: "studio-pc" },
      mapping: { ...view.mapping, ...details, deviceId: "studio-pc" } };
    for (const supplied of [undefined, "", "{", JSON.stringify({ ...studioFixture, inputs: { headline: 501, name_title: 501 } })]) {
      vi.stubEnv("VITE_CMS_STUDIO_CONFIGURATION", supplied);
      vi.resetModules();
      const module = await import("../src/lib/live-production-setup");
      expect(() => module.parseStudioInputs(JSON.stringify(details))).toThrow(/configuration is unavailable/);
      expect(() => module.connectorSetup(saved)).toThrow(/configuration is unavailable/);
    }
    vi.stubEnv("VITE_CMS_STUDIO_CONFIGURATION", JSON.stringify(studioFixture));
    for (const origin of [undefined, "", "http://studio.example.test", "https://studio.example.test/path", "https://user:password@studio.example.test"]) {
      vi.stubEnv("VITE_FUNCTIONS_BASE_URL", origin);
      vi.resetModules();
      const module = await import("../src/lib/live-production-setup");
      expect(() => module.connectorSetup(saved)).toThrow(/API configuration is unavailable/);
    }
  });
  it("rejects a saved mapping response whose input identity changed", async () => {
    const view = initial();
    const client = createLiveProductionClient(async () => ({ success: true, session: { ...view.session, deviceId: "studio-pc", mappingVersion: 2, generation: 2 },
      mapping: { ...view.mapping, ...details, deviceId: "studio-pc", version: 2, inputs: { ...details.inputs, headline: { ...details.inputs.headline, key: "other" } } } }));
    await expect(client.setMapping({ action: "set_mapping", sessionId: "rehearsal", requestId: "mapping-save", baseMappingVersion: 1, deviceId: "studio-pc", titleFilesConfirmed: true, ...details })).rejects.toThrow(/reconciliation/);
  });
});

describe("studio connection controls", () => {
  it("previews native identities and saves a version-fenced request only after confirmation", async () => {
    const api = harness();
    expect(screen.getByLabelText("Headline text input")).toHaveValue(501);
    expect(screen.getByRole("button", { name: "Save studio connection" })).toBeDisabled();
    await prepare();
    expect(screen.queryByRole("option", { name: /Revoked PC|Busy PC/ })).not.toBeInTheDocument();
    expect(screen.getByText("Synthetic headline overlay")).toBeVisible();
    expect(screen.getByText("gt-headline")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save studio connection" }));
    await screen.findByText(/Studio connection saved/);
    expect(api.calls.find(body => body.action === "set_mapping")).toMatchObject({ action: "set_mapping", sessionId: "rehearsal", baseMappingVersion: 1,
      deviceId: "studio-pc", titleFilesConfirmed: true, ...details });
    expect(screen.getByRole("button", { name: "Mark ready" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Make active" })).toBeDisabled();
    expect(api.calls.some(body => body.action === "command")).toBe(false);
    await waitFor(() => expect(screen.getByText(/Studio connection saved/).closest('[tabindex="-1"]')).toHaveFocus());
  });
  it("retains details on a real version conflict and holds the stale draft", async () => {
    const api = harness(); await prepare();
    const real = api.mutations.getMockImplementation()!;
    api.mutations.mockImplementation(async body => {
      if (body.action === "set_mapping") throw Object.assign(new Error("Saved version changed."), { status: 409 });
      const result = await real(body) as SessionView & { success: true };
      return { ...result, session: { ...result.session, mappingVersion: 2, generation: 2 }, mapping: { ...result.mapping, version: 2 },
        fences: { ...result.fences, mappingVersion: 2, sessionGeneration: 2 } };
    });
    fireEvent.click(screen.getByRole("button", { name: "Save studio connection" }));
    await screen.findByText(/Saved version changed/);
    expect(screen.getByText("gt-headline")).toBeVisible();
    await screen.findByText(/A newer studio connection is saved/);
    expect(screen.getByRole("button", { name: "Save studio connection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use saved studio connection" }));
    expect(screen.getByLabelText("I confirmed both GT title files with the studio operator")).not.toBeChecked();
  });
  it("shows server refusals without changing input details or advancing state", async () => {
    const api = harness(); await prepare();
    const real = api.mutations.getMockImplementation()!;
    api.mutations.mockImplementation(async body => {
      if (body.action === "set_mapping") throw Object.assign(new Error("The device has another active session."), { status: 409 });
      return real(body);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save studio connection" }));
    await screen.findByText(/The device has another active session/);
    expect(screen.getByText("gt-headline")).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark ready" })).toBeDisabled();
  });
  it("keeps unknown outcomes explicit and retries only the exact original request", async () => {
    const api = harness(); await prepare();
    const real = api.mutations.getMockImplementation()!;
    const writes: LiveRequest[] = [];
    api.mutations.mockImplementation(async body => {
      if (body.action === "set_mapping") { writes.push(body); if (writes.length === 1) throw new Error("Response lost"); }
      return real(body);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save studio connection" }));
    await screen.findByText(/The result is unknown/);
    expect(writes).toHaveLength(1);
    expect(screen.getByLabelText("Paired studio PC")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry same studio request" }));
    await screen.findByText(/Studio connection saved/);
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  });
  it("requires device verification, then ready before active, and sends no live command", async () => {
    const api = harness(); await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Save studio connection" }));
    await screen.findByText(/Studio connection saved/);
    api.verify(); fireEvent.click(screen.getByRole("button", { name: "Refresh studio setup" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark ready" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Make active" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Make active" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Mark ready" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Make active" }));
    await screen.findByText(/Session is active/);
    expect(api.calls.filter(body => body.action === "set_session_state")).toMatchObject([
      { baseGeneration: 2, state: "ready" }, { baseGeneration: 2, state: "active" },
    ]);
    expect(screen.getByLabelText("Load studio input details")).toBeDisabled();
    expect(api.calls.some(body => body.action === "command")).toBe(false);
  });
  it("releases the post-write hold when refreshed state has a newer mapping generation", async () => {
    const api = harness(); await prepare();
    const real = api.mutations.getMockImplementation()!;
    api.mutations.mockImplementation(async body => {
      const result = await real(body);
      if (body.action !== "get_session") return result;
      const next = result as SessionView & { success: true };
      return { ...next, session: { ...next.session, generation: 3, mappingVersion: 3 },
        mapping: { ...next.mapping, version: 3 }, fences: { ...next.fences, sessionGeneration: 3, mappingVersion: 3 } };
    });
    fireEvent.click(screen.getByRole("button", { name: "Save studio connection" }));
    await screen.findByText(/Studio connection saved/);
    await waitFor(() => expect(screen.getByLabelText("Load studio input details")).toBeEnabled());
    expect(screen.queryByText("Waiting for refreshed studio status.")).not.toBeInTheDocument();
  });
  it("releases the post-write hold when another operator advances Ready to Active", async () => {
    const start = initial();
    const api = harness({ ...start, session: { ...start.session, deviceId: "studio-pc" },
      mapping: { ...start.mapping, ...details, deviceId: "studio-pc", state: "commissioned", verifiedAtMs: 1000 } });
    const real = api.mutations.getMockImplementation()!;
    api.mutations.mockImplementation(async body => {
      const result = await real(body);
      if (body.action !== "get_session") return result;
      const next = result as SessionView & { success: true };
      return { ...next, session: { ...next.session, state: "active" }, fences: { ...next.fences, active: true } };
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    await waitFor(() => expect(screen.getByLabelText("I checked that Overlay 1 is reserved for Boardwalk")).toBeEnabled());
    expect(screen.queryByText("Waiting for refreshed studio status.")).not.toBeInTheDocument();
  });
  it("requires a human Overlay 1 check before copying setup; ID copy sends no request", async () => {
    const writeText = vi.fn(async (_value: string) => undefined); vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = initial();
    const api = harness({ ...view, session: { ...view.session, deviceId: "studio-pc" }, mapping: { ...view.mapping, ...details, deviceId: "studio-pc" } });
    expect(screen.getByRole("button", { name: "Copy connector setup" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy session ID" }));
    await screen.findByText("Session ID copied."); expect(writeText).toHaveBeenLastCalledWith("rehearsal");
    fireEvent.click(screen.getByLabelText("I checked that Overlay 1 is reserved for Boardwalk"));
    fireEvent.click(screen.getByRole("button", { name: "Copy connector setup" }));
    await screen.findByText("Connector setup copied.");
    expect(JSON.parse(writeText.mock.calls.at(-1)![0])).toMatchObject({ sessionId: "rehearsal", exclusiveOverlay1: true, mapping: { version: 1, ...details } });
    expect(api.calls).toHaveLength(0);
  });
  it("rejects invalid imports before enabling save", async () => {
    harness(); await loadFile({ ...details, password: "unexpected" });
    await screen.findByText(/must contain only the four/);
    expect(screen.getByRole("button", { name: "Save studio connection" })).toBeDisabled();
  });
  it("clears the prior confirmation and file details for an invalid replacement", async () => {
    harness(); await prepare();
    expect(screen.getByRole("button", { name: "Save studio connection" })).toBeEnabled();
    await loadFile("invalid JSON");
    expect(screen.getByRole("button", { name: "Save studio connection" })).toBeDisabled();
    expect(screen.getByLabelText("I confirmed both GT title files with the studio operator")).not.toBeChecked();
    expect(screen.queryByText("gt-headline")).not.toBeInTheDocument();
  });
  it("requires a new file and confirmation when the paired PC changes", async () => {
    harness(); await prepare();
    fireEvent.change(screen.getByLabelText("Paired studio PC"), { target: { value: "second-pc" } });
    expect(screen.getByRole("button", { name: "Save studio connection" })).toBeDisabled();
    expect(screen.getByLabelText("I confirmed both GT title files with the studio operator")).not.toBeChecked();
    expect(screen.queryByText("gt-headline")).not.toBeInTheDocument();
  });
  it("lets a content editor without settings access create a pairing code in Studio setup", async () => {
    vi.stubEnv("VITE_LIVE_PRODUCTION_ENABLED", "true");
    const principal = { id: "producer", grants: [{ role: "editor" as const }] };
    expect(canManageSettings(principal)).toBe(false);
    expect(canUseLiveProduction(principal)).toBe(true);
    const send = vi.fn<DeviceTransport>(async request => "action" in request && request.action === "create_pairing"
      ? { pairingCode: "ABCD-EFGH-JKLM", deviceId: "new-studio-pc", expiresAtMs: 300000, expiresInMs: 300000 }
      : { devices: [], nextCursor: null });
    const client = fakeClient(); client.session = async () => initial();
    const router = createMemoryRouter([{ path: "/", element: <RequireCapability allowed={canUseLiveProduction} notice="Unavailable">
      <LiveProductionWorkspace client={client} deviceSetup={<LiveProductionDevices send={send} />} /></RequireCapability> }]);
    render(<ShellProvider value={{ principal, user: { uid: "producer", email: "producer@example.test" }, userDoc: null, signOut: () => undefined }}>
      <ExitGuardProvider><RouterProvider router={router} /></ExitGuardProvider></ShellProvider>);
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.click(screen.getByText("Studio setup", { exact: true }));
    await screen.findByText("No studio devices are enrolled.");
    fireEvent.change(screen.getByRole("textbox", { name: "Studio PC name" }), { target: { value: "Studio PC" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    await screen.findByRole("group", { name: "Studio PC pairing" });
    expect(send).toHaveBeenCalledWith({ action: "create_pairing", name: "Studio PC" });
    expect(screen.getByRole("button", { name: "Copy code" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Connect the studio PC" })).toBeVisible();
  });
  it("keeps imported setup across Show/Prepare and protects it on route exit", async () => {
    const client = fakeClient();
    client.session = async () => initial();
    client.sessions = async () => ({ sessions: [initial().session], nextCursor: null });
    const router = createMemoryRouter([{ path: "/", element: <><Link to="/away">Leave studio</Link><LiveProductionWorkspace client={client} /></> },
      { path: "/away", element: <p>Away</p> }]);
    render(<ExitGuardProvider><RouterProvider router={router} /></ExitGuardProvider>);
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.click(screen.getByText("Studio setup", { exact: true }));
    await screen.findByLabelText("Load studio input details"); await loadFile();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.queryByLabelText("Load studio input details")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    expect(screen.getByText("gt-headline")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "Leave studio" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("gt-headline")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(screen.queryByText("gt-headline")).not.toBeInTheDocument());
  });

});
