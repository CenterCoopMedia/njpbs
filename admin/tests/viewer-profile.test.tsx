import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthorProfileRoute } from "../src/routes/AuthorProfileRoute";

const boundary = vi.hoisted(() => ({ getIdToken: vi.fn(), cmsGetAuthorProfile: vi.fn() }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => ({ getIdToken: boundary.getIdToken, state: {
  status: "signed-in", user: { uid: "viewer", email: "reader@example.test", displayName: "Staff reader" },
  principal: { id: "viewer", grants: [{ role: "staff", tier: "viewer" }] },
} }) }));
vi.mock("../src/lib/functions", async (original) => ({ ...(await original<typeof import("../src/lib/functions")>()), cmsGetAuthorProfile: boundary.cmsGetAuthorProfile }));
it("shows the Viewer account without creating an author identity or offering profile writes", () => {
  render(<AuthorProfileRoute />);
  expect(screen.getByRole("heading", { name: "My profile" })).toBeInTheDocument();
  expect(screen.getByText("Staff reader")).toBeInTheDocument();
  expect(screen.getByText("reader@example.test")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(boundary.getIdToken).not.toHaveBeenCalled();
  expect(boundary.cmsGetAuthorProfile).not.toHaveBeenCalled();
});
