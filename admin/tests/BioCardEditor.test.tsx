import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { BioCatalogProvider, useBioCatalog } from "../src/components/BioCatalogContext";
import { BioCardEditor } from "../src/components/BioCardEditor";
import { ShellProvider } from "../src/routes/ShellContext";
import type { AdminBlock } from "../src/lib/block-factory";

const profile = { profileId: "example-official", kind: "person" as const, name: "Example Official",
  role: "State senator", party: "Democratic", area: "Legislative District 1", summary: "A sourced short biography.",
  sourceUrl: "https://example.org/official", sourceLabel: "Official biography", asOf: "2026-10-03", reviewStatus: "reviewed" as const,
  internalSourceIds: ["internal-source"] };
const catalog = { schemaVersion: 1 as const, profiles: [profile,
  { ...profile, profileId: "example-agency", kind: "organization" as const, name: "Example Agency", role: "Public agency", party: undefined }] };
function Draft({ change = vi.fn() }: { change?: (data: Record<string, unknown>) => void }) {
  const [block, setBlock] = useState<AdminBlock>({ id: "b1", type: "bio_card", order: 0, visible: true, data: {} });
  return <BioCardEditor block={block} onChange={data => { change(data); setBlock({ ...block, data }); }} />;
}
function session(uid: string, getIdToken = vi.fn(async () => "staff-token")) {
  return { principal: { id: uid, grants: [{ role: "staff" as const }] }, user: { uid, email: "staff@example.org", displayName: "Staff" },
    userDoc: null, signOut: () => undefined, getIdToken };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("bio selection in an article", () => {
  it("loads only on request, searches, previews and inserts a public snapshot", async () => {
    const loader = vi.fn(async () => catalog); const change = vi.fn();
    render(<BioCatalogProvider loader={loader} sessionKey="writer"><Draft change={change} /></BioCatalogProvider>);
    expect(loader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose a bio" }));
    expect(await screen.findByText("2 bios found")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search name, role or area"), { target: { value: "Official" } });
    expect(screen.getByText("1 bio found")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Example Official, State senator/ }));
    expect(screen.getByRole("region", { name: "Selected bio preview" })).toHaveTextContent(profile.summary);
    fireEvent.click(screen.getByRole("button", { name: "Use this bio" }));
    expect(change.mock.lastCall?.[0]).toMatchObject({ name: profile.name, summary: profile.summary });
    expect(change.mock.lastCall?.[0]).not.toHaveProperty("reviewStatus");
    expect(change.mock.lastCall?.[0]).not.toHaveProperty("internalSourceIds");
    expect(screen.getByRole("textbox", { name: /Name/ })).toHaveValue(profile.name);
    expect(loader).toHaveBeenCalledOnce();
  });
  it("removes a selected bio from the active choice when filters hide it", async () => {
    render(<BioCatalogProvider loader={async () => catalog} sessionKey="writer"><Draft /></BioCatalogProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bio" }));
    fireEvent.click(await screen.findByRole("button", { name: /Example Official, State senator/ }));
    expect(screen.getByRole("region", { name: "Selected bio preview" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Profile type"), { target: { value: "organization" } });
    expect(screen.getByText("1 bio found")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Selected bio preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this bio" })).not.toBeInTheDocument();
  });
  it("requires an authenticated, no-store request and offers retry after denial", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("Denied", { status: 403 }))
      .mockImplementation(async () => new Response(JSON.stringify(catalog)));
    vi.stubGlobal("fetch", fetch);
    render(<ShellProvider value={session("staff")}><BioCatalogProvider><Draft /></BioCatalogProvider></ShellProvider>);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose a bio" }));
    await screen.findByText("Bios could not be loaded. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("2 bios found");
    expect(fetch).toHaveBeenCalledWith("/guide-content/resources/public-bios.json", expect.objectContaining({
      cache: "no-store", headers: { authorization: "Bearer staff-token" }, signal: expect.any(AbortSignal),
    }));
  });
  it("does not fetch when a late token resolves after unmount", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); let resolve!: (token: string) => void;
    const token = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const view = render(<ShellProvider value={session("staff", token)}><BioCatalogProvider><Draft /></BioCatalogProvider></ShellProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Choose a bio" })); view.unmount();
    await act(async () => resolve("late-token")); expect(fetch).not.toHaveBeenCalled();
  });
  it("drops the previous account's loaded catalog immediately on a user change", async () => {
    function Probe() { const state = useBioCatalog()!; return <><button onClick={state.load}>Load</button><p>{state.catalog?.profiles[0].name ?? "No catalog"}</p></>; }
    const loader = vi.fn(async () => catalog);
    const view = render(<BioCatalogProvider loader={loader} sessionKey="first"><Probe /></BioCatalogProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Load" })); await screen.findByText(profile.name);
    view.rerender(<BioCatalogProvider loader={loader} sessionKey="second"><Probe /></BioCatalogProvider>);
    await waitFor(() => expect(screen.getByText("No catalog")).toBeVisible());
    expect(screen.queryByText(profile.name)).not.toBeInTheDocument();
  });
});
