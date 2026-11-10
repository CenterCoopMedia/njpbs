import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorProfileRoute } from "../src/routes/AuthorProfileRoute";
import { AuthorProfilesRoute } from "../src/routes/AuthorProfilesRoute";
import { type SelfAuthorProfile } from "../src/lib/functions";
import type { RoleGrant } from "../../packages/content-core/src/rbac";

const mocks = vi.hoisted(() => {
  vi.stubEnv("VITE_AUTHOR_PAGES_LIVE", "true");
  return { getIdToken: vi.fn(), get: vi.fn(), update: vi.fn(), visibility: vi.fn(), posts: vi.fn(), listProfiles: vi.fn(), categories: vi.fn(), grants: [] as RoleGrant[] };
});
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => ({
  getIdToken: mocks.getIdToken,
  state: { status: "signed-in", principal: { id: "staff-writer", grants: mocks.grants },
    user: { uid: "staff-writer", displayName: "Staff writer", email: "writer@example.test" } },
}) }));
vi.mock("../src/routes/ShellContext", () => ({ useShell: () => ({
  principal: { id: "admin", grants: [{ role: "admin" }] }, user: { uid: "admin" }, userDoc: { role: "admin" },
}) }));
vi.mock("../src/lib/functions", async (original) => ({
  ...(await original<typeof import("../src/lib/functions")>()),
  cmsGetAuthorProfile: mocks.get,
  cmsUpdateAuthorProfile: mocks.update,
  cmsSetAuthorProfileVisibility: mocks.visibility,
  cmsListAuthorPagePosts: mocks.posts,
  cmsListAuthorProfiles: mocks.listProfiles,
  cmsListMediaCategories: mocks.categories,
}));

const profile: SelfAuthorProfile = {
  authorId: "au_release", displayName: "Staff writer", jobTitle: "Reporter", bio: "Local news.",
  photo: null, links: {}, pinnedPostId: null, hiddenPostIds: [], visibility: "private", slug: null,
  previousSlugs: [], publishedAt: null, withdrawnAt: null, withdrawnReason: null, version: 4,
  updatedAt: "2026-10-17T12:00:00.000Z", staffStatus: "active", publicPath: null,
};
const published: SelfAuthorProfile = {
  ...profile, visibility: "published", version: 5, slug: "staff-writer",
  publicPath: "/authors/staff-writer/", publishedAt: "2026-10-17T12:01:00.000Z",
};

async function open(value = profile) {
  mocks.get.mockResolvedValue({ apiVersion: 1, success: true, profile: value });
  render(<MemoryRouter><AuthorProfileRoute /></MemoryRouter>);
  await screen.findByRole("heading", { name: "Your public profile" });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.grants = [{ role: "editor" }];
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.posts.mockResolvedValue({ apiVersion: 1, success: true, posts: [], nextCursor: null });
  mocks.categories.mockResolvedValue({ categories: [] });
});
afterAll(() => vi.unstubAllEnvs());

describe("enabled author release", () => {
  it("keeps contributor save available while refusing self publication", async () => {
    mocks.grants = [{ role: "contributor" }];
    mocks.update.mockResolvedValueOnce({ apiVersion: 1, success: true, profile: { ...profile, jobTitle: "Writer", version: 5 } });
    await open();
    expect(screen.getByText(/Publishing your own profile requires Editor access or higher/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish profile" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Writer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.visibility).not.toHaveBeenCalled();
  });

  it("allows a contributor to unpublish an existing profile", async () => {
    mocks.grants = [{ role: "contributor" }];
    mocks.visibility.mockResolvedValueOnce({ apiVersion: 1, success: true, profile });
    await open(published);
    expect(screen.getByRole("button", { name: "Unpublish profile" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Unpublish profile" }));
    await waitFor(() => expect(mocks.visibility).toHaveBeenCalledWith("id-token", { visibility: "private", expectedVersion: 5 }));
  });

  it("keeps viewers in the read-only profile view", async () => {
    mocks.grants = [{ role: "staff", tier: "viewer" }];
    render(<MemoryRouter><AuthorProfileRoute /></MemoryRouter>);
    expect(screen.getByText("Profile is view only")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Publish profile" })).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("discloses the other person's public fields beside an enabled administrator Publish control", async () => {
    mocks.listProfiles.mockResolvedValue({ apiVersion: 1, success: true,
      profiles: [{ ...profile, uid: "staff-writer", lifecycle: "active", archivedAt: null }], linkableUsers: [], nextCursor: null });
    render(<MemoryRouter><AuthorProfilesRoute /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Open profile for Staff writer" }));
    const publish = screen.getByRole("button", { name: "Publish profile in CMS" });
    expect(publish).toBeEnabled();
    expect(publish.closest(".author-profile-publish")).toHaveTextContent("the person's name, job title, bio, photo and links on a public page anyone can read");
    expect(publish.closest(".author-profile-publish")).toHaveTextContent("Withdrawing takes that page down.");
    expect(publish.closest(".author-profile-publish")).not.toHaveTextContent(/your name|your published work|Unpublishing/);
  });

  it.each([
    { role: "editor" as const, sections: ["news"] },
    { role: "editor" as const, tier: "publisher" as const },
    { role: "admin" as const },
    { role: "super_admin" as const },
  ])("enables $role self publication and keeps withdrawal available", async (grant) => {
    mocks.grants = [grant];
    await open();
    expect(screen.queryByText("Publishing is paused")).not.toBeInTheDocument();
    const consent = screen.getByText(/a public page anyone can read/);
    expect(consent).toBeVisible();
    expect(consent).toHaveTextContent("your name, job title, bio, photo and links");
    expect(consent).toHaveTextContent("Unpublishing takes that page down.");
    expect(consent).not.toHaveTextContent(/the person's|Withdraw/);
    mocks.visibility.mockResolvedValueOnce({ apiVersion: 1, success: true, profile: published });
    const publish = screen.getByRole("button", { name: "Publish profile" });
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    await waitFor(() => expect(mocks.visibility).toHaveBeenCalledWith("id-token", { visibility: "published", expectedVersion: 4 }));
    expect(await screen.findByText("Your profile is published at /authors/staff-writer/.")).toBeVisible();
    mocks.visibility.mockResolvedValueOnce({ apiVersion: 1, success: true, profile: { ...profile, version: 6 } });
    fireEvent.click(screen.getByRole("button", { name: "Unpublish profile" }));
    await waitFor(() => expect(mocks.visibility).toHaveBeenLastCalledWith("id-token", { visibility: "private", expectedVersion: 5 }));
    expect(await screen.findByText("Your profile is no longer published.")).toBeVisible();
  });

  it("retains the unsaved-edit guard when publication is enabled", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Editor" } });
    expect(screen.getByRole("button", { name: "Publish profile" })).toBeDisabled();
    expect(mocks.visibility).not.toHaveBeenCalled();
  });
});
