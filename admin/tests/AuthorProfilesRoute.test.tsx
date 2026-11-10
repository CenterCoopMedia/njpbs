import { fireEvent, render, screen, waitFor, within, } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_CAPABILITIES } from "../../packages/content-core/src/rbac";
import { AuthorProfilesRoute } from "../src/routes/AuthorProfilesRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { resetMediaCategoryRegistry } from "../src/lib/use-media-categories";
import {
  HttpError,
  type AdminAuthorProfile,
  type MediaAssetSummary,
} from "../src/lib/functions";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  cmsListAuthorProfiles: vi.fn(),
  cmsCreateAuthorProfile: vi.fn(),
  cmsAdminUpdateAuthorProfile: vi.fn(),
  cmsListAuthorPagePosts: vi.fn(),
  cmsListMedia: vi.fn(),
  cmsListMediaCategories: vi.fn(),
  uploadAuthorPhoto: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    getIdToken: mocks.getIdToken,
    state: {
      status: "signed-in",
      user: { uid: "person-1" },
      principal: { id: "person-1", grants: [{ role: "admin" }] },
    },
  }),
}));

vi.mock("../src/lib/author-photo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/author-photo")>()),
  uploadAuthorPhoto: mocks.uploadAuthorPhoto,
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsListAuthorProfiles: mocks.cmsListAuthorProfiles,
  cmsCreateAuthorProfile: mocks.cmsCreateAuthorProfile,
  cmsAdminUpdateAuthorProfile: mocks.cmsAdminUpdateAuthorProfile,
  cmsListAuthorPagePosts: mocks.cmsListAuthorPagePosts,
  cmsListMedia: mocks.cmsListMedia,
  cmsListMediaCategories: mocks.cmsListMediaCategories,
}));

function shellFor(role: "admin" | "contributor"): ShellData {
  return {
    principal: { id: "person-1", grants: [{ role }] },
    user: {
      uid: "person-1",
      email: "account-16@example.org",
      displayName: "Person One",
    },
    userDoc: { role: role === "admin" ? "admin" : null },
    signOut: vi.fn(),
  } as unknown as ShellData;
}

function adminProfile(
  overrides: Partial<AdminAuthorProfile> = {},
): AdminAuthorProfile {
  return {
    uid: "editor-9",
    lifecycle: "active",
    archivedAt: null,
    authorId: "au_9",
    displayName: "Sam Morgan",
    jobTitle: "Director",
    bio: "Covers local news collaboration.",
    photo: null,
    links: {},
    pinnedPostId: null,
    hiddenPostIds: [],
    visibility: "published",
    slug: "sam-morgan",
    previousSlugs: [],
    publishedAt: "2026-08-18T12:00:00.000Z",
    withdrawnAt: null,
    withdrawnReason: null,
    version: 7,
    updatedAt: "2026-08-19T12:00:00.000Z",
    staffStatus: "active",
    publicPath: "/authors/sam-morgan/",
    ...overrides,
  };
}

function renderRoute(role: "admin" | "contributor" = "admin", path = "/staff-profiles") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ShellProvider value={shellFor(role)}>
        <Routes>
          <Route path="/staff-profiles" element={<AuthorProfilesRoute />} />
          <Route path="/" element={<p>Newsroom home</p>} />
        </Routes>
      </ShellProvider>
    </MemoryRouter>,
  );
}

async function renderWithProfiles(profiles = [adminProfile()]) {
  mocks.cmsListAuthorProfiles.mockResolvedValue({
    apiVersion: 1,
    success: true,
    profiles,
    linkableUsers: [],
    nextCursor: null,
  });
  renderRoute("admin");
  await screen.findByRole("heading", { name: "Staff profiles" });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMediaCategoryRegistry();
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.cmsListMediaCategories.mockResolvedValue({ categories: [] });
  mocks.cmsListMedia.mockResolvedValue({
    success: true,
    records: [],
    total: 0,
    allCount: 0,
    page: 1,
    pageCount: 1,
    categoryCounts: {},
    kindCounts: { image: 0, document: 0 },
  });
  mocks.cmsListAuthorPagePosts.mockResolvedValue({
    apiVersion: 1,
    success: true,
    posts: [
      { id: "post-1", headline: "Budget hearing", publishDate: "2026-08-20" },
    ],
    nextCursor: null,
  });
  // jsdom cannot decode images, so the field's dimension pre-check is skipped and
  // the file goes straight to the upload -- the same path a browser without
  // createImageBitmap takes.
  Reflect.deleteProperty(globalThis, "createImageBitmap");
});

describe("staff profiles admin route", () => {
  it("opens the exact profile linked from a live-blog warning and closes back to the roster", async () => {
    const profile = adminProfile({ authorId: `au_${"b".repeat(32)}` });
    mocks.cmsListAuthorProfiles.mockResolvedValue({ apiVersion: 1, success: true, profiles: [profile], linkableUsers: [], nextCursor: null });
    renderRoute("admin", `/staff-profiles?authorId=${profile.authorId}`);
    expect(await screen.findByRole("button", { name: "Close this profile" })).toBeInTheDocument();
    expect(mocks.cmsListAuthorProfiles).toHaveBeenCalledWith("id-token", { authorId: profile.authorId });
    expect(screen.queryByRole("heading", { name: "Staff profiles" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create staff profile" })).toBeNull();
    expect(screen.getByRole("textbox", { name: /Public name/ })).toHaveValue(profile.displayName);
    fireEvent.click(screen.getByRole("button", { name: "Close this profile" }));
    await waitFor(() => expect(mocks.cmsListAuthorProfiles).toHaveBeenLastCalledWith("id-token"));
    expect(screen.queryByRole("button", { name: "Close this profile" })).toBeNull();
  });

  it("keeps administrator publishing explicit about public exposure while self-service is paused", async () => {
    await renderWithProfiles([adminProfile({ visibility: "private", slug: null, publicPath: null })]);
    fireEvent.click(screen.getByRole("button", { name: "Open profile for Sam Morgan" }));
    const publish = screen.getByRole("button", { name: "Publish profile in CMS" });
    expect(publish).toBeEnabled();
    expect(publish.closest(".author-profile-publish")).toHaveTextContent("Self-service profile publication is paused. Administrators can still publish profiles.");
    expect(publish.closest(".author-profile-publish")).toHaveTextContent("name, job title, bio, photo and links on a public page anyone can read");
  });

  it("refuses an account without the staff-account capability", async () => {
    renderRoute("contributor");

    expect(await screen.findByText("Newsroom home")).toBeInTheDocument();
    // The refusal is decided before any request: a contributor never reaches the
    // admin listing, and the server would refuse it as well.
    expect(mocks.cmsListAuthorProfiles).not.toHaveBeenCalled();
  });

  it("lists staff profiles with their public state", async () => {
    await renderWithProfiles([
      adminProfile(),
      adminProfile({
        authorId: "au_10",
        uid: "editor-10",
        displayName: "Jordan Avery",
        jobTitle: null,
        visibility: "private",
        slug: null,
        publicPath: null,
      }),
    ]);

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Published in CMS")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Not published")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Staff author profiles" }),).toHaveClass(
      "data-table",
      "author-profiles-table"
    );
  });

  it("creates an account-independent staff profile from the manager workspace", async () => {
    const created = adminProfile({
      authorId: "au_new",
      uid: null,
      displayName: "Raven Santana",
      visibility: "private",
      slug: null,
      publicPath: null,
      version: 1,
    });
    mocks.cmsListAuthorProfiles
      .mockResolvedValueOnce({
        apiVersion: 1,
        success: true,
        profiles: [],
        linkableUsers: [],
        nextCursor: "old-cursor",
      })
      .mockResolvedValueOnce({
        apiVersion: 1,
        success: true,
        profiles: [created],
        linkableUsers: [],
        nextCursor: null,
      });
    renderRoute("admin");
    await screen.findByRole("heading", { name: "Staff profiles" });
    mocks.cmsCreateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: created,
    });

    fireEvent.change(
      screen.getByLabelText("New staff profile name"), {
      target: { value: "Raven Santana" },
    }
    );
    fireEvent.click( screen
      .getByRole("button", { name: "Create staff profile" }),);

    await waitFor( () => {
      expect(mocks.cmsCreateAuthorProfile).toHaveBeenCalledWith("id-token", {
        displayName: "Raven Santana", });
      expect(mocks.cmsListAuthorProfiles).toHaveBeenCalledTimes(2);
    }
    );

    expect(
      await
      screen.findByRole("heading", { name: "Editing the profile for Raven Santana", }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not linked to a CMS account yet/i),
    ).toBeInTheDocument();
  });

  it("links an unlinked profile to an approved user without reminting it", async() =>
    {
    const
      profile = adminProfile({
      uid: null,
        visibility: "private",
        slug: null,
        publicPath: null,
      });
    mocks.cmsListAuthorProfiles.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profiles: [profile
  ],
      linkableUsers: [
        {
          uid: "uid-raven",
          displayName: "Raven Santana",
          email: "account-19@example.org",
        },
        {
          uid: "uid-other",
          displayName: "Raven Santana",
          email: "account-15@example.org",
        },
      ],
      nextCursor: null,
    });
    renderRoute("admin");
    await screen.findByRole("heading", { name: "Staff profiles" });
    mocks.cmsAdminUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: adminProfile({
        uid: "uid-raven",
        visibility: "private",
        slug: null,
        publicPath: null,
        version: 8,
      }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    expect(
      screen.getByRole("option", {
        name: "Raven Santana (account-19@example.org)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", {
        name: "Raven Santana (account-15@example.org)",
      }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Approved CMS user"), {
      target: { value: "uid-raven" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link CMS account" }));
    expect(mocks.cmsAdminUpdateAuthorProfile).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /permanently link this profile to Raven Santana \(account-19@example\.org\)/i,
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, link CMS account" }),
    );

    await waitFor(() =>
      expect(mocks.cmsAdminUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        {
          action: "link",
          authorId: "au_9",
          uid: "uid-raven",
          expectedVersion: 7,
        },
      ),
    );
    expect(
      await screen.findByText(
        /author id, bylines, slug history and public address did not change/i,
      ),
    ).toBeInTheDocument();
  });

  it("archives with an explicit confirmation and preserves identity copy", async () => {
    await renderWithProfiles();
    mocks.cmsAdminUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: adminProfile({
        lifecycle: "archived",
        archivedAt: "2026-08-21T12:00:00.000Z",
        visibility: "private",
        version: 8,
      }),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive profile" }));
    expect(mocks.cmsAdminUpdateAuthorProfile).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, archive profile" }),
    );
    await waitFor(() =>
      expect(mocks.cmsAdminUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        {
          action: "archive",
          authorId: "au_9",
          expectedVersion: 7,
        },
      ),
    );
    expect(
      await screen.findByText(
        /identity, bylines and reserved slugs were preserved/i,
      ),
    ).toBeInTheDocument();
  });

  it("says in the interface that an edit is audited and leaves access alone", async () => {
    await renderWithProfiles();

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );

    const editor = screen
      .getByRole("heading", { name: "Editing the profile for Sam Morgan" })
      .closest("section") as HTMLElement;
    expect(editor).toHaveTextContent(/recorded against your account/);
    expect(editor).toHaveTextContent(/does not change their role/);
  });

  it("loads picker options for the author the admin opens", async () => {
    await renderWithProfiles();
    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );

    await waitFor(() =>
      expect(mocks.cmsListAuthorPagePosts).toHaveBeenCalledWith("id-token", {
        authorId: "au_9",
      }),
    );
  });

  it("reads media categories only when the photo picker opens and reuses the account cache", async () => {
    await renderWithProfiles();
    expect(mocks.cmsListMediaCategories).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.change(screen.getByLabelText(/^Public name/), {
      target: { value: "Sam Morgan Updated" },
    });
    fireEvent.change(screen.getByLabelText("Short bio"), {
      target: { value: "Updated biography." },
    });
    await screen.findAllByRole("option", { name: /Budget hearing/ });
    expect(mocks.cmsListMediaCategories).not.toHaveBeenCalled();
    expect(mocks.cmsListMedia).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Choose from media library" }));
    await waitFor(() => {
      expect(mocks.cmsListMediaCategories).toHaveBeenCalledTimes(1);
      expect(mocks.cmsListMediaCategories).toHaveBeenCalledWith("id-token");
      expect(mocks.cmsListMedia).toHaveBeenCalledWith(
        "id-token",
        expect.objectContaining({ kinds: ["image"] }),
      );
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose from media library" }));
    await waitFor(() => expect(mocks.cmsListMedia).toHaveBeenCalledTimes(2));
    expect(mocks.cmsListMediaCategories).toHaveBeenCalledTimes(1);
  });

  it("offers the same photo controls for someone else's profile", async () => {
    await renderWithProfiles();

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );

    expect(
      screen.getByRole("heading", { name: "Profile photo" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Profile photo" }),
    ).toBeInTheDocument();
    // The copy names whose photograph it is, so an admin is never confused about
    // which face they are attaching.
    expect(
      screen.getByText(/square crop of Sam Morgan's photo/i),
    ).toBeInTheDocument();
  });

  it("confines the profiles-only manager's picker to their own profile images and keeps upload", async () => {
    const previous = ROLE_CAPABILITIES.admin;
    ROLE_CAPABILITIES.admin = ["profiles.manage"];
    try {
      mocks.cmsListMedia.mockResolvedValue({
        records: [], total: 0, allCount: 0, page: 1, pageSize: 30, pageCount: 0,
        facets: { categories: [], tags: [], kinds: [] },
      });
      await renderWithProfiles();
      fireEvent.click(screen.getByRole("button", { name: "Open profile for Sam Morgan" }));
      expect(screen.getByRole("button", { name: "Upload a photo" })).toBeEnabled();
      expect(mocks.cmsListMedia).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Choose from media library" }));
      await waitFor(() => expect(mocks.cmsListMedia).toHaveBeenCalledWith("id-token", {
        q: "", categories: ["staff-profile"], kinds: ["image"],
        profilePhotoScope: "self", sort: "updatedAt", direction: "desc", page: 1,
      }));
      expect(mocks.cmsListMedia).toHaveBeenCalledOnce();
    } finally {
      ROLE_CAPABILITIES.admin = previous;
    }
  });

  it.each([
    {
      profile: adminProfile(),
      stateCopy:
        "This profile is marked published in the CMS. Saved photo changes update its public profile data. Check the public page to confirm changes.",
    },
    {
      profile: adminProfile({
        visibility: "private",
        slug: null,
        publicPath: null,
      }),
      stateCopy:
        "This profile is private. An administrator can publish it, making this photo public.",
    },
  ])(
    "explains an admin's two-step upload for the $profile.visibility CMS state",
    async ({ profile: listedProfile, stateCopy }) => {
      await renderWithProfiles([listedProfile]);
      fireEvent.click(
        screen.getByRole("button", { name: "Open profile for Sam Morgan", }),
      );
      fireEvent.change(screen.getByLabelText("Choose a photo"), {
        target: {
          files: [
            new File([new Uint8Array(400_000)], "headshot.jpg", {
              type: "image/jpeg",
            }),
          ],
        },
      });

      expect(
        await screen.findByText(
          (_, node) =>
            node?.textContent ===
            `Uploading adds the photo to the media library. Save this profile to attach it. ${stateCopy}`,
        ),
      ).toBeInTheDocument();
    },
  );

  it("edits another staff member's profile through the admin callable", async () => {
    await renderWithProfiles();
    mocks.cmsAdminUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: adminProfile({ jobTitle: "Interim director", version: 8 }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Interim director" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      expect(mocks.cmsAdminUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        {
          action: "edit",
          authorId: "au_9",
          displayName: "Sam Morgan",
        jobTitle: "Interim director",
        bio: "Covers local news collaboration.",
        photo: null,
        links: {},
          pinnedPostId: null,
          hiddenPostIds: [],
          expectedVersion: 7,
        },
      );
    });
    expect(
      await screen.findByText(
        "Profile saved. The change is recorded in the activity log.",
      ),
    ).toBeInTheDocument();
  });

  it("saves one social profile link and derives its internal handle", async () => {
    await renderWithProfiles();
    mocks.cmsAdminUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: adminProfile({
        links: { x: { handle: "njpbs", url: "https://x.com/njpbs" } },
        version: 8,
      }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    expect(screen.queryByLabelText(/handle/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("X profile link"), {
      target: { value: "https://www.x.com/njpbs/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(mocks.cmsAdminUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        expect.objectContaining({
          action: "edit",
          authorId: "au_9",
          links: { x: { handle: "njpbs", url: "https://x.com/njpbs" } },
          expectedVersion: 7,
        }),
      ),
    );
    expect(
      await screen.findByText(
        "Profile saved. The change is recorded in the activity log.",
      ),
    ).toBeInTheDocument();
  });

  it("asks for confirmation before withdrawing a public profile", async () => {
    await renderWithProfiles();
    mocks.cmsAdminUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: adminProfile({
        visibility: "private",
        withdrawnAt: "2026-08-21T12:00:00.000Z",
        withdrawnReason: "admin",
        version: 8,
      }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Withdraw published profile" }),
    );

    // Nothing is sent on the first press: the second press is the decision.
    expect(mocks.cmsAdminUpdateAuthorProfile).not.toHaveBeenCalled();
    expect(
      screen.getByText("Withdraw the published profile for Sam Morgan?"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Yes, withdraw it" }));

    await waitFor(() => {
      expect(mocks.cmsAdminUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        {
          action: "withdraw",
          authorId: "au_9",
          expectedVersion: 7,
        },
      );
    });
    expect(
      await screen.findByText(
        "The published profile was withdrawn in the CMS. The author's role and access are unchanged.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Withdraw published profile" }),
    ).not.toBeInTheDocument();
  });

  it("lets the admin back out of a withdrawal", async () => {
    await renderWithProfiles();

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Withdraw published profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it published" }));

    expect(mocks.cmsAdminUpdateAuthorProfile).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Withdraw published profile" }),
    ).toBeInTheDocument();
  });

  it("applies the same field rules an author gets", async () => {
    await renderWithProfiles();

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.change(screen.getByLabelText(/^Public name/), {
      target: { value: "  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText(
        "Enter the name that should appear on your published work.",
      ),
    ).toBeInTheDocument();
    expect(mocks.cmsAdminUpdateAuthorProfile).not.toHaveBeenCalled();
  });

  it("names a conflict instead of overwriting someone else's change", async () => {
    await renderWithProfiles();
    mocks.cmsAdminUpdateAuthorProfile.mockRejectedValueOnce(
      new HttpError(409, "Profile was changed by someone else"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Interim director" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText("Someone else changed this profile"),
    ).toBeInTheDocument();
  });

  it("shows a staff member's photo in the roster and initials without one", async () => {
    await renderWithProfiles([
      adminProfile({
        photo: {
          assetId: "asset-1",
          url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/a.jpg",
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
      }),
      adminProfile({
        authorId: "au_10",
        uid: "editor-10",
        displayName: "Jordan Avery",
      }),
    ]);

    expect(screen.getByText("JA")).toBeInTheDocument();
    const avatar = screen
      .getAllByRole("presentation", { hidden: true })
      .find((node) => node.className.includes("account-avatar"));
    expect(avatar?.getAttribute("src")).toContain("asset-1");
    expect(avatar).toHaveStyle({ objectPosition: "50% 20%" });
  });

  it("shows initials for every staff member with no photo", async () => {
    await renderWithProfiles([
      adminProfile(),
      adminProfile({
        authorId: "au_10",
        uid: "editor-10",
        displayName: "Jordan Avery",
      }),
    ]);

    expect(screen.getByText("SM")).toBeInTheDocument();
    expect(screen.getByText("JA")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("never lands one person's upload in another person's editor", async () => {
    // One admin screen serves the whole roster, and an upload outlives the editor
    // it was started in. Switching profiles mid-upload used to write the first
    // person's photograph, rights basis and credit into the second person's form,
    // one Save away from the wrong public page.
    await renderWithProfiles([
      adminProfile(),
      adminProfile({
        authorId: "au_10",
        uid: "editor-10",
        displayName: "Jordan Avery",
      }),
    ]);

    let settleUpload: (asset: MediaAssetSummary) => void = () => undefined;
    mocks.uploadAuthorPhoto.mockReturnValue(
      new Promise((resolve) => {
        settleUpload = (asset) => resolve({ asset });
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.change(screen.getByLabelText("Choose a photo"), {
      target: {
        files: [
          new File([new Uint8Array(400_000)], "headshot.jpg", {
            type: "image/jpeg",
          }),
        ],
      },
    });
    fireEvent.click(await screen.findByLabelText(/^It is my own photo$/));
    fireEvent.click(screen.getByLabelText(/^I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Upload photo" }));
    await waitFor(() =>
      expect(mocks.uploadAuthorPhoto).toHaveBeenCalledTimes(1),
    );

    // The admin moves on before the bytes land.
    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Jordan Avery" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Editing the profile for Jordan Avery",
      }),
    ).toBeInTheDocument();
    // The staged file and its attestation belong to the editor that is gone.
    expect(
      screen.queryByLabelText(/^I confirm NJ PBS may publish/),
    ).not.toBeInTheDocument();

    settleUpload({
      id: "asset-sam",
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-sam/a.jpg",
      width: 900,
      height: 900,
    } as MediaAssetSummary);

    // The other editor is untouched: no photograph, nothing staged, and a save still
    // sends the profile he actually has.
    await waitFor(() =>
      expect(
        screen.queryByText(/This preview shows the square crop/),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/^Rights:/)).not.toBeInTheDocument();

    mocks.cmsAdminUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: adminProfile({
        authorId: "au_10",
        uid: "editor-10",
        displayName: "Jordan Avery",
        jobTitle: "Reporter",
        version: 8,
      }),
    });
    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Reporter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(mocks.cmsAdminUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        expect.objectContaining({ authorId: "au_10", photo: null }),
      ),
    );
  });

  it("reaches the rest of a roster that does not fit on one page", async () => {
    // The listing is paged server-side. Stopping at page one would leave every
    // author past the first page unreachable -- not correctable, not withdrawable.
    mocks.cmsListAuthorProfiles.mockResolvedValueOnce({
      apiVersion: 1,
      success: true,
      profiles: [adminProfile()],
      nextCursor: "au_9",
    });
    renderRoute("admin");
    await screen.findByRole("heading", { name: "Staff profiles" });
    expect(screen.getByText("Sam Morgan")).toBeInTheDocument();

    mocks.cmsListAuthorProfiles.mockResolvedValueOnce({
      apiVersion: 1,
      success: true,
      profiles: [
        adminProfile({
          uid: "editor-10",
          authorId: "au_10",
          displayName: "Jordan Avery",
          slug: "jordan-avery",
          publicPath: "/authors/jordan-avery/",
        }),
      ],
      nextCursor: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Load more staff profiles" }),
    );

    expect(await screen.findByText("Jordan Avery")).toBeInTheDocument();
    // Appended, not replaced.
    expect(screen.getByText("Sam Morgan")).toBeInTheDocument();
    expect(mocks.cmsListAuthorProfiles).toHaveBeenLastCalledWith("id-token", {
      startAfter: "au_9",
    });
    // The last page ends the paging rather than offering a button that does nothing.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Load more staff profiles" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the loaded rows when the next page fails", async () => {
    mocks.cmsListAuthorProfiles.mockResolvedValueOnce({
      apiVersion: 1,
      success: true,
      profiles: [adminProfile()],
      nextCursor: "au_9",
    });
    renderRoute("admin");
    await screen.findByRole("heading", { name: "Staff profiles" });

    mocks.cmsListAuthorProfiles.mockRejectedValueOnce(
      new HttpError(500, "Staff profiles could not be read"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Load more staff profiles" }),
    );

    expect(
      await screen.findByText("Staff profiles could not be read"),
    ).toBeInTheDocument();
    expect(screen.getByText("Sam Morgan")).toBeInTheDocument();
  });

  it("will not withdraw a profile while the open form has unsaved edits", async () => {
    // Withdrawal replaces the form with the server's copy, so allowing it here
    // would discard the admin's typing without a word.
    await renderWithProfiles();

    fireEvent.click(
      screen.getByRole("button", { name: "Open profile for Sam Morgan" }),
    );
    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Senior director" },
    });

    const withdraw = screen.getByRole("button", {
      name: "Withdraw published profile",
    });
    expect(withdraw).toBeDisabled();
    expect(
      screen.getByText(/Withdrawing acts on the saved profile/),
    ).toBeInTheDocument();
    fireEvent.click(withdraw);
    expect(mocks.cmsAdminUpdateAuthorProfile).not.toHaveBeenCalled();
  });

  it("keeps a failed listing recoverable", async () => {
    mocks.cmsListAuthorProfiles.mockRejectedValueOnce(
      new HttpError(500, "Staff profiles could not be read"),
    );
    renderRoute("admin");

    expect(
      await screen.findByText("Staff profiles could not be read"),
    ).toBeInTheDocument();

    mocks.cmsListAuthorProfiles.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profiles: [],
      nextCursor: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByText("No staff profiles yet"),
    ).toBeInTheDocument();
  });
});
