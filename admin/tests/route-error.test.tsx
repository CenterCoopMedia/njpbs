import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  type RouteObject,
} from "react-router";
import { buildRoutes, type RouteHandle } from "../src/routes/buildRoutes";
import { RouteErrorBoundary } from "../src/routes/RouteError";

// The boundary logs every error it catches, on purpose, and these tests throw four of them. The
// spy keeps that out of the test output and doubles as the assertion that it was logged at all.
// jsdom reports the uncaught exceptions on its own channel regardless, so the run is still noisy;
// that noise is jsdom's, not something this spy claims to silence.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

function Boom(): React.ReactElement {
  throw new Error("surface exploded");
}

describe("admin route error boundaries", () => {
  // The structural contract. React Router replaces the element of the route the errorElement is
  // declared on, so the placement is the whole fix: one on the shell as a last resort, and one on
  // a pathless route inside it that catches surface crashes without taking the shell down.
  it("declares a boundary on the shell and on a pathless route inside it", () => {
    const [root] = buildRoutes();

    expect(root.path).toBe("/");
    expect(root.errorElement).toBeTruthy();

    const inner = (root.children ?? []).filter(
      (child: RouteObject) => child.path === undefined && child.index !== true,
    );
    expect(inner).toHaveLength(1);
    expect(inner[0].errorElement).toBeTruthy();
    // Every real surface must sit under it, or a crash there still reaches the shell's boundary.
    expect((inner[0].children ?? []).length).toBeGreaterThan(0);
    expect(
      (root.children ?? []).some(
        (child: RouteObject) => child.element !== undefined,
      ),
    ).toBe(false);
  });

  // The boundary is added by nesting every route one level deeper, and a routing regression from
  // that would be invisible: the surfaces still render, so every other test passes and only the
  // URLs break. This walks the real tree and checks each path still lands where it did.
  it("still resolves every real path after the nesting", () => {
    const expected: Array<[string, string]> = [
      ["/", "Home"],
      ["/content", "Content studio"],
      ["/content/pages", "Content studio"],
      ["/publish-queue", "Editorial queue"],
      ["/staff-access", "Staff access"],
      ["/nope", "Page not found"],
    ];
    for (const [path, title] of expected) {
      const { matches } = createMemoryRouter(buildRoutes(), {
        initialEntries: [path],
      }).state;
      const handle = matches.at(-1)?.route.handle as RouteHandle | undefined;
      expect(handle?.title, `${path} resolved to the wrong route`).toBe(title);
    }
  });

  // Why that placement matters: the shell stays on screen and only the crashed surface is
  // replaced. Declaring the boundary on the shell route instead would blank all of this.
  it("keeps the shell mounted when a surface below it throws", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <div>
              <nav data-testid="shell-nav">newsroom nav</nav>
              <Outlet />
            </div>
          ),
          errorElement: <RouteErrorBoundary />,
          children: [
            {
              errorElement: <RouteErrorBoundary />,
              children: [{ index: true, element: <Boom /> }],
            },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByTestId("shell-nav")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /stopped working/i }),
    ).toBeTruthy();
  });

  // The crash that prompted this presented as a missing heading rather than as the error under
  // it, so surfacing the cause is the point of the surface, not a nicety.
  it("shows what actually broke and logs it", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          errorElement: <RouteErrorBoundary />,
          element: <Boom />,
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByText("surface exploded")).toBeTruthy();
    expect(consoleError).toHaveBeenCalledWith(
      "Admin route surface crashed:",
      expect.objectContaining({ message: "surface exploded" }),
    );
  });

  // A recovery route out is the difference between a dead end and a detour.
  it("offers a way back to a known-good page", () => {
    const router = createMemoryRouter(
      [{ path: "/", errorElement: <RouteErrorBoundary />, element: <Boom /> }],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);

    expect(screen.getByRole("button", { name: /newsroom home/i })).toBeTruthy();
  });
});
