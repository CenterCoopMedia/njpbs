import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ShellProvider } from "../src/routes/ShellContext";
import { PoliticsResourceRoute } from "../src/routes/PoliticsResourceRoute";
import { electionFixture } from "./fixtures/election-directory";
import data from "./fixtures/resources/nj-politics.json";
function mount(path = "/resources/nj-politics", token = vi.fn(async () => "staff-token")) {
  const view = render(<ShellProvider value={{ principal: { id: "staff", grants: [{ role: "staff" }] }, user: { uid: "staff", email: "staff@example.org", displayName: "Staff" }, userDoc: null, signOut: () => undefined, getIdToken: token }}><MemoryRouter initialEntries={[path]}><PoliticsResourceRoute /></MemoryRouter></ShellProvider>);
  return { ...view, token };
}
function mockData() {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("nj-election-2026.json") ? electionFixture() : data), { status: 200 }));
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("PoliticsResourceRoute", () => {
  it("loads private data on entry with staff token and no-store, then filters without another request", async () => {
    const fetch = mockData(); mount();
    await screen.findByRole("heading", { name: "Resources" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/guide-content/resources/nj-politics.json", expect.objectContaining({ cache: "no-store", headers: { authorization: "Bearer staff-token" }, signal: expect.any(AbortSignal) }));
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "Example" } });
    expect(screen.getByRole("link", { name: "View profile: Alex Example" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 3 })[0]).toHaveTextContent("Alex Example");
    fireEvent.change(screen.getByLabelText("Party"), { target: { value: "R" } });
    expect(screen.getByRole("heading", { name: "No matches found" })).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("opens linked profiles with acting/former status and safe source links", async () => {
    mockData(); mount("/resources/nj-politics?person=person-example-official");
    expect(await screen.findByRole("heading", { name: "Alex Example" })).toBeVisible();
    expect(screen.getByText("Acting", { selector: ".politics-acting" })).toBeVisible();
    const source = screen.getAllByRole("link").find(a => a.getAttribute("href")?.startsWith("https://"));
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByLabelText("Selected reference")).toHaveFocus();
  });
  it("preserves search when opening and leaving a profile", async () => {
    mockData(); mount("/resources/nj-politics?q=Example");
    fireEvent.click(await screen.findByRole("link", { name: "View profile: Alex Example" }));
    fireEvent.click(screen.getByRole("link", { name: "← Back to results" }));
    expect(screen.getByRole("searchbox")).toHaveValue("Example");
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });
  it("browses districts with labeled demographic bars and no finance aggregate", async () => {
    mockData(); mount("/resources/nj-politics?tab=places&section=congressional-districts&record=nj-cd-01");
    await screen.findByRole("heading", { name: "Congressional district 1" });
    const estimates = screen.getByLabelText("Selected demographic estimates");
    expect(within(estimates).getByText(/Each bar runs from 0% to 100%/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Census source (opens in a new tab)" })).toBeVisible();
    const towns = screen.getByRole("link", { name: "Open town list" });
    expect(towns.getAttribute("href")).toContain("section=district-towns");
    expect(towns.getAttribute("href")).toContain("record=nj-cd-01");
  });
  it("handles a bad saved link and a recoverable denied request", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("Forbidden", { status: 403 })).mockImplementation(async () => new Response(JSON.stringify(data)));
    vi.stubGlobal("fetch", fetch); mount("/resources/nj-politics?person=missing");
    await screen.findByRole("heading", { name: "Politics resource unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Reference not found" })).toBeVisible();
  });
  it("does not fetch after a token request resolves on an unmounted route", async () => {
    const fetch = mockData(); let resolve!: (value: string) => void;
    const token = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const view = mount("/resources/nj-politics", token); view.unmount();
    await act(async () => resolve("late-token"));
    await waitFor(() => expect(fetch).not.toHaveBeenCalled());
  });
  it("starts with party charts collapsed and makes each filter removable", async () => {
    const fetch = mockData(); mount("/resources/nj-politics?q=Example&office=governor-and-cabinet&party=other");
    await screen.findByRole("heading", { name: "Resources" });
    expect(screen.getByText("Party balance", { selector: "summary" }).closest("details")).not.toHaveAttribute("open");
    const filters = screen.getByLabelText("Active filters");
    fireEvent.click(within(filters).getByRole("button", { name: "Remove filter: Other / not recorded" }));
    expect(screen.getByLabelText("Party")).toHaveValue("");
    expect(screen.getByLabelText("Office or role")).toHaveValue("governor-and-cabinet");
    expect(screen.getByRole("searchbox")).toHaveValue("Example");
    expect(screen.getByRole("searchbox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByLabelText("Office or role")).toHaveValue("");
    expect(screen.queryByLabelText("Active filters")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("presents a profile overview and retains grouped research, sources and unfilled fields", async () => {
    mockData(); mount("/resources/nj-politics?person=person-example-official");
    const glance = await screen.findByRole("region", { name: "Profile at a glance" });
    expect(glance).toHaveTextContent("Example Department");
    expect(glance).toHaveTextContent("Not publicly confirmed");
    const primary = screen.getAllByRole("region", { name: "Alex Example" })[0];
    expect(within(primary).getByRole("region", { name: "Role & responsibilities" })).toHaveTextContent("This fictional appointment has limited authority.");
    expect(within(primary).getByRole("region", { name: "Background & context" })).toHaveTextContent("Example Law School");
    expect(within(primary).getByRole("region", { name: "Sources & verification" })).toHaveTextContent("Official source");
    const unfilled = within(primary).getByText("Unfilled research fields", { selector: "summary" }).closest("details")!;
    expect(unfilled).not.toHaveAttribute("open");
    fireEvent.click(unfilled.querySelector("summary")!);
    expect(within(unfilled).getByText("Age source")).toBeInTheDocument();
    expect(within(unfilled).getByText("Not recorded")).toBeInTheDocument();
  });
  it("keeps collection and search when returning from a district record", async () => {
    mockData(); mount("/resources/nj-politics?tab=places&section=congressional-districts&q=Example County");
    fireEvent.click(await screen.findByRole("link", { name: "View record: Congressional district 1" }));
    fireEvent.click(screen.getByRole("link", { name: "← Back to results" }));
    expect(screen.getByRole("searchbox")).toHaveValue("Example County");
    expect(screen.getByLabelText("Collection")).toHaveValue("congressional-districts");
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });
  it("loads a direct election link without requesting officeholder data", async () => {
    const fetch = mockData();
    mount("/resources/nj-politics?tab=elections&eq=Example");
    expect(await screen.findByText("Example Candidate")).toBeVisible();
    expect(screen.getByRole("searchbox")).toHaveValue("Example");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/guide-content/resources/nj-election-2026.json", expect.objectContaining({ cache: "no-store", headers: { authorization: "Bearer staff-token" } }));
  });
  it.each(["pending", "denied", "invalid"])("opens elections independently when officeholder data is %s", async (state) => {
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("nj-election-2026.json")) return Response.json(electionFixture());
      if (state === "pending") return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return state === "denied" ? new Response("Forbidden", { status: 403 }) : Response.json({});
    });
    vi.stubGlobal("fetch", fetch);
    mount();
    if (state === "pending") await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    else await screen.findByRole("heading", { name: "Politics resource unavailable" });
    fireEvent.click(screen.getByRole("link", { name: "2026 election" }));
    expect(await screen.findByText("Example Candidate")).toBeVisible();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("heading", { name: "Politics resource unavailable" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Politics reference sections" })).getByRole("link", { name: "People & roles" }));
    if (state === "pending") expect(screen.getByRole("status")).toHaveTextContent("Loading the politics resource");
    else expect(await screen.findByRole("heading", { name: "Politics resource unavailable" })).toBeVisible();
  });
  it("mounts the election panel only when its named navigation section opens", async () => {
    const fetch = mockData(); mount();
    await screen.findByRole("searchbox");
    expect(screen.queryByRole("heading", { name: "Who’s on the ballot?" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "2026 election" }));
    expect(await screen.findByRole("heading", { name: "Who’s on the ballot?" })).toBeVisible();
    expect(screen.queryByLabelText("Search people, places or roles")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2026 election" })).toHaveAttribute("aria-current", "page");
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("nj-election-2026.json"))).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Politics reference sections" })).getByRole("link", { name: "People & roles" }));
    expect(await screen.findByLabelText("Search people, places or roles")).toBeVisible();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("nj-politics.json"))).toHaveLength(1);
  });
  it("fails closed without a staff session when no preview transport is supplied", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<MemoryRouter><PoliticsResourceRoute /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Politics resource unavailable" })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the explicit preview transports without a shell and loads elections only on demand", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const previewSource = { politics: vi.fn(async (_signal: AbortSignal) => data), elections: vi.fn(async (_signal: AbortSignal) => electionFixture()) };
    render(<MemoryRouter><PoliticsResourceRoute previewSource={previewSource} /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Resources" });
    expect(previewSource.politics).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(previewSource.elections).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "2026 election" }));
    expect(await screen.findByText("Example Candidate")).toBeVisible();
    expect(previewSource.elections).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid preview research through the normal parser", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const previewSource = { politics: async () => ({ people: [{ name: "Unchecked preview" }] }), elections: async () => electionFixture() };
    render(<MemoryRouter><PoliticsResourceRoute previewSource={previewSource} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Politics resource unavailable" })).toBeVisible();
    expect(screen.queryByText("Unchecked preview")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts a replaced preview transport and ignores its late response", async () => {
    let resolve!: (value: unknown) => void;
    const politics = vi.fn((_signal: AbortSignal) => new Promise<unknown>(done => { resolve = done; }));
    const previewSource = { politics, elections: async () => electionFixture() };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const view = render(<MemoryRouter><PoliticsResourceRoute previewSource={previewSource} /></MemoryRouter>);
    const signal = politics.mock.calls[0][0];
    view.rerender(<MemoryRouter><PoliticsResourceRoute /></MemoryRouter>);
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(data));
    expect(screen.getByRole("heading", { name: "Politics resource unavailable" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Resources" })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});
