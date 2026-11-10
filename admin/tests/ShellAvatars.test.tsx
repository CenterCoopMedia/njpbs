import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellLayout } from "../src/routes/ShellLayout";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { AuthorPhoto, SelfAuthorProfile } from "../src/lib/functions";
import { OWN_AVATAR_MAX_AGE_MS } from "../src/lib/own-author-photo-cache";
import { useOwnAuthorPhoto } from "../src/routes/OwnAuthorPhotoContext";

// The navigation avatar is drawn by the shell, which knows the account but not
// the author profile a photograph lives on. The shell resolves the profile so
// that this global account control updates with the saved photograph.

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  cmsGetAuthorProfile: vi.fn(),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsGetAuthorProfile: mocks.cmsGetAuthorProfile,
}));

const PHOTO_URL = "https://media.njpbs.org/cms-media/staff-profile/asset-1/a.jpg";

function selfProfile(): SelfAuthorProfile {
  return {
    authorId: "au_1",
    displayName: "Sam Morgan",
    jobTitle: "Director",
    bio: null,
    pinnedPostId: null,
    hiddenPostIds: [],
    photo: {
      assetId: "asset-1",
      url: PHOTO_URL,
      mimeType: "image/jpeg",
      width: 800,
      height: 800,
      sizeBytes: 120_000,
      focalX: 0.5,
      focalY: 0.2,
      credit: null,
      rightsBasis: "own-photo",
      attestedAt: "2026-08-21T18:00:00.000Z",
    },
    links: {},
    visibility: "private",
    slug: null,
    previousSlugs: [],
    publishedAt: null,
    withdrawnAt: null,
    withdrawnReason: null,
    version: 3,
    updatedAt: "2026-08-21T18:00:00.000Z",
    staffStatus: "active",
    publicPath: null,
  };
}

function shell(uid = "person-1"): ShellData {
  return {
    principal: { id: uid, grants: [{ role: "admin" }] },
    user: {
      uid,
      email: "account-27@example.org",
      displayName: "Sam Morgan",
    },
    userDoc: { role: "admin", displayName: "Sam Morgan" },
    signOut: vi.fn(),
    getIdToken: mocks.getIdToken,
  } as unknown as ShellData;
}

function renderShell(uid = "person-1") {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <ShellLayout />,
        children: [
          { index: true, element: <p>Newsroom home</p>, handle: { title: "Home" } },
          { path: "pages", element: <PublishPhoto />, handle: { title: "Pages" } },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  const view = render(
    <ShellProvider value={shell(uid)}>
      <RouterProvider router={router} />
    </ShellProvider>,
  );
  return { ...view, router };
}

function PublishPhoto() {
  const { setPhoto } = useOwnAuthorPhoto();
  return (
    <button type="button" onClick={() => setPhoto(replacementPhoto())}>
      Publish photo
    </button>
  );
}

function replacementPhoto(): AuthorPhoto {
  return {
    ...selfProfile().photo!,
    assetId: "asset-2",
    url: "https://media.njpbs.org/cms-media/staff-profile/asset-2/b.jpg",
    focalX: 0.1,
    focalY: 0.8,
  };
}

function avatarImages(): HTMLImageElement[] {
  return screen
    .queryAllByRole("presentation", { hidden: true })
    .filter((node) => node.tagName === "IMG" && node.classList.contains("account-avatar-photo")) as HTMLImageElement[];
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.getIdToken.mockResolvedValue("id-token");
});

describe("shell avatars", () => {
  it("puts the signed-in person's own photo on the navigation avatar", async () => {
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: selfProfile(),
    });

    renderShell();

    await waitFor(() => expect(avatarImages()).toHaveLength(1));
    for (const image of avatarImages()) {
      expect(image.getAttribute("src")).toBe(PHOTO_URL);
      // The stored crop travels with it, so the face is centred the way the
      // person placed it rather than at the middle of the frame.
      expect(image).toHaveStyle({ objectPosition: "50% 20%" });
    }
    // One request for the whole shell, not one per render.
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1);
  });

  it("draws a covering thumbnail on the navigation avatar", async () => {
    const thumbnail = "https://media.njpbs.org/cms-media/staff-profile/asset-1/thumb.webp";
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: {
        ...selfProfile(),
        photo: {
          ...selfProfile().photo!,
          thumbnails: [
            { url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/short.webp", width: 480, height: 40 },
            { url: thumbnail, width: 480, height: 480 },
          ],
        },
      },
    });

    renderShell();

    await waitFor(() => expect(avatarImages()[0]?.getAttribute("src")).toBe(thumbnail));
    const stored = JSON.parse(sessionStorage.getItem("njpbs.admin.ownAvatarPhoto") ?? "{}") as {
      photo: Record<string, unknown>;
    };
    expect(stored.photo).toEqual({ url: thumbnail, focalX: 0.5, focalY: 0.2 });
  });

  it("does not read the profile again on a route change or a later mount in the same tab", async () => {
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: selfProfile(),
    });

    const first = renderShell();
    await waitFor(() => expect(avatarImages()).toHaveLength(1));
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1);

    await act(async () => {
      await first.router.navigate("/pages");
    });
    expect(screen.getAllByText("Pages").length).toBeGreaterThan(0);
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1);
    expect(avatarImages()[0]?.getAttribute("src")).toBe(PHOTO_URL);
    first.unmount();

    renderShell();
    await waitFor(() => expect(avatarImages()).toHaveLength(1));
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1);
    const stored = sessionStorage.getItem("njpbs.admin.ownAvatarPhoto") ?? "";
    const parsed = JSON.parse(stored) as { uid: string; photo: Record<string, unknown> };
    expect(parsed.uid).toBe("person-1");
    expect(Object.keys(parsed.photo).sort()).toEqual(["focalX", "focalY", "url"]);
    expect(parsed.photo).toEqual({ url: PHOTO_URL, focalX: 0.5, focalY: 0.2 });
    expect(stored).not.toContain("id-token");
  });

  it("reads the profile again when the stored avatar is older than one minute", async () => {
    const replacement = "https://media.njpbs.org/cms-media/staff-profile/asset-1/new.jpg";
    sessionStorage.setItem("njpbs.admin.ownAvatarPhoto", JSON.stringify({
      uid: "person-1",
      photo: { url: PHOTO_URL, focalX: 0.5, focalY: 0.2 },
      storedAt: Date.now() - OWN_AVATAR_MAX_AGE_MS,
    }));
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: {
        ...selfProfile(),
        photo: { ...selfProfile().photo!, url: replacement },
      },
    });

    renderShell();
    await waitFor(() => expect(avatarImages()[0]?.getAttribute("src")).toBe(replacement));
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps initials when there is no photo, including after a later mount", async () => {
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: { ...selfProfile(), photo: null },
    });

    const withoutPhoto = renderShell();
    await waitFor(() =>
      expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1),
    );
    expect(avatarImages()).toHaveLength(0);
    expect(screen.getAllByText("SM")).toHaveLength(1);
    withoutPhoto.unmount();

    renderShell();
    await waitFor(() => expect(screen.getAllByText("SM")).toHaveLength(1));
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1);
    expect(avatarImages()).toHaveLength(0);
  });

  it("retries a refused read and does not keep that failure for the next mount", async () => {
    mocks.cmsGetAuthorProfile.mockRejectedValue(new Error("Account approval required"));
    const first = renderShell();
    await waitFor(() =>
      expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1),
    );
    expect(avatarImages()).toHaveLength(0);
    first.unmount();

    renderShell();
    await waitFor(() =>
      expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(2),
    );
    expect(avatarImages()).toHaveLength(0);
    expect(screen.getAllByText("SM")).toHaveLength(1);
  });

  it("does not show another account's cached photograph", async () => {
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: selfProfile(),
    });
    const first = renderShell("person-1");
    await waitFor(() => expect(avatarImages()).toHaveLength(1));
    first.unmount();

    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: {
        ...selfProfile(),
        photo: { ...selfProfile().photo!, url: "https://media.njpbs.org/other.jpg" },
      },
    });
    renderShell("person-2");
    expect(screen.queryAllByRole("presentation", { hidden: true }).some((node) =>
      node.tagName === "IMG" && node.getAttribute("src") === PHOTO_URL,
    )).toBe(false);
    await waitFor(() => expect(avatarImages()).toHaveLength(1));
    expect(avatarImages()[0]?.getAttribute("src")).toBe("https://media.njpbs.org/other.jpg");
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(2);
  });

  it("replaces the cached crop when the profile route publishes a saved photograph", async () => {
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: selfProfile(),
    });
    const view = renderShell();
    await waitFor(() => expect(avatarImages()).toHaveLength(1));
    await act(async () => {
      await view.router.navigate("/pages");
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish photo" }));
    await waitFor(() =>
      expect(avatarImages()[0]?.getAttribute("src")).toBe(replacementPhoto().url),
    );
    view.unmount();

    renderShell();
    await waitFor(() =>
      expect(avatarImages()[0]?.getAttribute("src")).toBe(replacementPhoto().url),
    );
    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem("njpbs.admin.ownAvatarPhoto") ?? "")).toEqual({
      uid: "person-1",
      photo: { url: replacementPhoto().url, focalX: 0.1, focalY: 0.8 },
      storedAt: expect.any(Number),
    });
  });
});
