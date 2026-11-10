import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ShellProvider } from "../src/routes/ShellContext";
import { ElectionsPanel } from "../src/routes/ElectionsPanel";
import { electionFixture } from "./fixtures/election-directory";
const token = vi.fn(async () => "staff-token");
function mount(path = "/resources/nj-politics?tab=elections") { return render(<ShellProvider value={{ principal: { id: "staff", grants: [{ role: "staff" }] }, user: { uid: "staff", email: "staff@example.org", displayName: "Staff" }, userDoc: null, signOut: () => {}, getIdToken: token }}><MemoryRouter initialEntries={[path]}><ElectionsPanel /></MemoryRouter></ShellProvider>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("staff election directory", () => {
  it("loads with staff authorization, filters locally and makes incomplete coverage visible", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(electionFixture()))); vi.stubGlobal("fetch", fetch); mount();
    expect(await screen.findByText("Example Candidate")).toBeVisible();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/guide-content/resources/nj-election-2026.json", expect.objectContaining({ cache: "no-store", headers: { authorization: "Bearer staff-token" }, signal: expect.any(AbortSignal) }));
    fireEvent.change(screen.getByLabelText("County"), { target: { value: "Bergen" } });
    expect(screen.getByText(/Bergen has incomplete local coverage/)).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing person" } });
    expect(screen.getByText("No matching entries")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear election filters" })[0]);
    expect(screen.getByText("Example Candidate")).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Review coverage & sources" }));
    expect(screen.getByText("Reviewed test roster")).toBeVisible(); expect(screen.getAllByText("Partial coverage")).toHaveLength(22);
  });
  it("supports direct filtered links and recovers from an unavailable file", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("Forbidden", { status: 403 })).mockImplementation(async () => new Response(JSON.stringify(electionFixture()))); vi.stubGlobal("fetch", fetch); mount("/resources/nj-politics?tab=elections&eq=Example&county=Bergen");
    await screen.findByText("Election directory unavailable"); fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Example Candidate")).toBeVisible(); expect(screen.getByRole("searchbox")).toHaveValue("Example");
  });
  it("does not fetch after an unmounted token request completes", async () => {
    let resolve!: (token: string) => void; token.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const view = mount(); view.unmount(); resolve("late-token"); await waitFor(() => expect(fetch).not.toHaveBeenCalled());
  });
  it("fails closed without a staff session and no preview source", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<MemoryRouter><ElectionsPanel /></MemoryRouter>);
    expect(await screen.findByText("Election directory unavailable")).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("loads an explicit preview source without CMS credentials", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const previewSource = vi.fn(async (_signal: AbortSignal) => electionFixture());
    render(<MemoryRouter><ElectionsPanel previewSource={previewSource} /></MemoryRouter>);
    expect(await screen.findByText("Example Candidate")).toBeVisible();
    expect(previewSource).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Example" } });
    expect(previewSource).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("validates preview provenance with the normal election parser", async () => {
    const value = electionFixture(); value.candidates[0].sourceId = "missing-source";
    render(<MemoryRouter><ElectionsPanel previewSource={async () => value} /></MemoryRouter>);
    expect(await screen.findByText("Election directory unavailable")).toBeVisible();
    expect(screen.queryByText("Example Candidate")).not.toBeInTheDocument();
  });
  it("aborts a replaced preview source and ignores its late result", async () => {
    let resolve!: (value: unknown) => void;
    const previewSource = vi.fn((_signal: AbortSignal) => new Promise<unknown>(done => { resolve = done; }));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const view = render(<MemoryRouter><ElectionsPanel previewSource={previewSource} /></MemoryRouter>);
    const signal = previewSource.mock.calls[0][0];
    view.rerender(<MemoryRouter><ElectionsPanel /></MemoryRouter>);
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(electionFixture()));
    expect(screen.getByText("Election directory unavailable")).toBeVisible();
    expect(screen.queryByText("Example Candidate")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
