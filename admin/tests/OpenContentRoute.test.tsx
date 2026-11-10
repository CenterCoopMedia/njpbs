import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { OpenContentRoute } from "../src/routes/OpenContentRoute";
import { ShellProvider } from "../src/routes/ShellContext";
import { useDestinationMemory } from "../src/routes/destination-memory";
import { ADMIN_DESTINATION_KEY } from "../src/lib/route-memory";

const principal = { id: "editor", grants: [{ role: "editor" as const }] };
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function DestinationMemory() {
  useDestinationMemory(principal, "editor");
  return <Outlet />;
}
function open(search: string, response: unknown, status = 200, restore = false) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status }));
  vi.stubGlobal("fetch", fetch);
  if (restore) sessionStorage.setItem(ADMIN_DESTINATION_KEY, JSON.stringify({ uid: "editor", path: `/open${search}` }));
  const router = createMemoryRouter([{
    element: <DestinationMemory />,
    children: [
      { path: "/", element: <p>Dashboard</p> },
      { path: "/open", element: <OpenContentRoute /> },
      { path: "/content/*", element: <p>Addressed editor</p> },
    ],
  }], { initialEntries: [restore ? "/" : `/open${search}`] });
  render(<ShellProvider value={{ principal, user: { uid: "editor", email: "editor@example.test", displayName: "Editor" },
    userDoc: null, signOut: async () => {}, getIdToken: async () => "synthetic-test-token" }}><RouterProvider router={router} /></ShellProvider>);
  return { router, fetch };
}

describe("public editor deep link (#3145)", () => {
  it.each([
    ["?type=page&id=contact&path=/wrong-path/", { action: "resolveEditor", type: "page", id: "contact" }],
    ["?path=%2Fcontact%2F", { action: "resolveEditor", path: "/contact/" }],
  ])("restores the remembered target and query when the address is lost: %s", async (search, input) => {
    const { router, fetch } = open(search, { success: true, target: { type: "page", id: "contact" } }, 200, true);
    await screen.findByText("Addressed editor");
    expect(router.state.location.pathname).toBe("/content/pages/contact/edit");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(input);
  });
  it.each([
    ["home", "home", "/content/pages/home/edit"],
    ["page", "contact", "/content/pages/contact/edit"],
    ["post", "0123456789abcdef", "/content/post/0123456789abcdef/edit"],
    ["program", "program-one", "/content/program/program-one/edit"],
    ["event", "event-one", "/content/event/event-one/edit"],
  ])("opens the server-authorized %s identity", async (type, id, destination) => {
    const { router, fetch } = open(`?type=${type}&id=${id}&path=/wrong-path/`, { success: true, target: { type, id } });
    await screen.findByText("Addressed editor");
    expect(router.state.location.pathname).toBe(destination);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ action: "resolveEditor", type, id });
  });
  it("resolves a path through the authorized endpoint", async () => {
    const { fetch } = open("?path=%2Fposts%2Fpublic-post%2F", { success: true, target: { type: "post", id: "known-record" } });
    await screen.findByText("Addressed editor");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ action: "resolveEditor", path: "/posts/public-post/" });
  });
  it.each([400, 401, 403, 404, 503])("shows a plain message on refusal %s without mounting an editor", async status => {
    const { router } = open("?path=/unknown/", { error: "Unavailable" }, status);
    await screen.findByText("This page is unavailable or you do not have permission to edit it.");
    expect(router.state.location.pathname).toBe("/open");
    expect(screen.queryByText("Addressed editor")).toBeNull();
  });
  it("refuses an unsupported target instead of guessing", async () => {
    open("?type=users&id=other", { success: true, target: { type: "users", id: "other" } });
    await screen.findByText("This page is unavailable or you do not have permission to edit it.");
  });
});
