import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createMemoryRouter,
  Link,
  Outlet,
  RouterProvider,
  useMatches,
  useNavigate,
} from "react-router";
import { useRouteAnnouncer, useRouteFocus } from "../src/routes/route-focus";

// A minimal shell that uses the focus manager the way ShellLayout does: it derives the label from
// the matched route's handle, renders the heading the manager targets, and exposes the announcer's
// live region so a test can read what was announced.
function FocusShell() {
  const matches = useMatches();
  const handle = matches[matches.length - 1]?.handle as { title?: string } | undefined;
  const label = handle?.title ?? "";
  const { message, announce } = useRouteAnnouncer();
  useRouteFocus({ label, announce });
  const navigate = useNavigate();
  return (
    <div>
      <h1 id="page-title">{label}</h1>
      <p data-testid="announced">{message}</p>
      <nav>
        <Link to="/a">to a</Link>
        <Link to="/b">to b</Link>
        <Link to="/guide">to guide section</Link>
        <Link to="/a?q=1">filter a</Link>
        <button type="button" onClick={() => navigate(-1)}>
          back
        </button>
      </nav>
      <Outlet />
    </div>
  );
}

function renderFocus(initialEntries: string[]) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <FocusShell />,
        children: [
          { path: "a", element: <p>body a</p>, handle: { title: "Page A" } },
          { path: "b", element: <p>body b</p>, handle: { title: "Page B" } },
          {
            path: "guide",
            element: <h2 data-route-focus-heading>Guide article</h2>,
            handle: { title: "Boardwalk guide" },
          },
        ],
      },
    ],
    { initialEntries },
  );
  return render(<RouterProvider router={router} />);
}

function heading() {
  return document.getElementById("page-title");
}

describe("route focus manager", () => {
  it("does not move focus or announce on the initial load", () => {
    renderFocus(["/a"]);
    expect(screen.getByRole("heading", { level: 1, name: "Page A" })).toBeInTheDocument();
    expect(heading()).not.toBe(document.activeElement);
    expect(screen.getByTestId("announced")).toHaveTextContent("");
  });

  it("moves focus to the heading and announces the label on a link navigation", async () => {
    renderFocus(["/a"]);
    fireEvent.click(screen.getByRole("link", { name: "to b" }));
    await waitFor(() => expect(heading()).toBe(document.activeElement));
    expect(screen.getByTestId("announced")).toHaveTextContent("Page B");
  });

  it("does not move focus or announce on a query-only change", async () => {
    renderFocus(["/a"]);
    // Put focus somewhere concrete, then re-filter in place (same pathname, new search).
    const filterLink = screen.getByRole("link", { name: "filter a" });
    filterLink.focus();
    fireEvent.click(filterLink);
    // Give the navigation effect a chance to run before asserting it did nothing.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Page A" })).toBeInTheDocument(),
    );
    expect(heading()).not.toBe(document.activeElement);
    expect(screen.getByTestId("announced")).toHaveTextContent("");
  });

  it("uses a route-owned heading when the page supplies one", async () => {
    renderFocus(["/a"]);
    fireEvent.click(screen.getByRole("link", { name: "to guide section" }));
    const article = await screen.findByRole("heading", { name: "Guide article" });
    await waitFor(() => expect(article).toBe(document.activeElement));
    expect(screen.getByTestId("announced")).toHaveTextContent("Guide article");
  });

  it("restores the previously focused control when navigating back", async () => {
    renderFocus(["/a"]);
    // Record a focused control on the /a entry, then push to /b.
    const toB = screen.getByRole("link", { name: "to b" });
    toB.focus();
    expect(toB).toBe(document.activeElement);
    fireEvent.click(toB);
    await waitFor(() => expect(heading()).toBe(document.activeElement));

    // Back is a POP: focus returns to the control that was focused on the /a entry.
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Page A" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "to b" })).toBe(document.activeElement);
  });
});
