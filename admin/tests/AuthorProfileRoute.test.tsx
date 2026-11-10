import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorProfileRoute } from "../src/routes/AuthorProfileRoute";
import { OwnAuthorPhotoProvider } from "../src/routes/OwnAuthorPhotoContext";
import {
  HttpError,
  type MediaAssetSummary,
  type SelfAuthorProfile,
} from "../src/lib/functions";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  cmsGetAuthorProfile: vi.fn(),
  cmsUpdateAuthorProfile: vi.fn(),
  cmsSetAuthorProfileVisibility: vi.fn(),
  cmsListAuthorPagePosts: vi.fn(),
  uploadAuthorPhoto: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsGetAuthorProfile: mocks.cmsGetAuthorProfile,
  cmsUpdateAuthorProfile: mocks.cmsUpdateAuthorProfile,
  cmsSetAuthorProfileVisibility: mocks.cmsSetAuthorProfileVisibility,
  cmsListAuthorPagePosts: mocks.cmsListAuthorPagePosts,
}));

vi.mock("../src/lib/author-photo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/author-photo")>()),
  uploadAuthorPhoto: mocks.uploadAuthorPhoto,
}));

function profile(overrides: Partial<SelfAuthorProfile> = {}): SelfAuthorProfile {
  return {
    authorId: "au_1",
    displayName: "Sam Morgan",
    jobTitle: "Director",
    bio: "Covers local news collaboration.",
    photo: null,
    links: {},
    pinnedPostId: null,
    hiddenPostIds: [],
    visibility: "private",
    slug: null,
    previousSlugs: [],
    publishedAt: null,
    withdrawnAt: null,
    withdrawnReason: null,
    version: 4,
    updatedAt: "2026-08-20T12:00:00.000Z",
    staffStatus: "active",
    publicPath: null,
    ...overrides,
  };
}

/** A stored photograph on the profile the route opens. */
function storedPhoto(): NonNullable<SelfAuthorProfile["photo"]> {
  return {
    assetId: "asset-1",
    url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/a.jpg",
    mimeType: "image/jpeg",
    width: 800,
    height: 800,
    sizeBytes: 120_000,
    focalX: 0.25,
    focalY: 0.75,
    credit: null,
    rightsBasis: "own-photo",
    attestedAt: "2026-08-21T18:00:00.000Z",
  };
}

function uploadedAsset(
  id: string,
  url: string,
): MediaAssetSummary {
  return {
    id,
    name: "Profile photo: Sam Morgan",
    originalName: "replacement.png",
    category: "staff-profile",
    categories: ["staff-profile"],
    tags: [],
    description: null,
    altText: "Sam Morgan",
    license: "Profile photo: supplied by the staff member, cleared for use",
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 1_000,
    width: 800,
    height: 800,
    url,
    source: "upload",
    lifecycle: "active",
    version: 1,
    etag: `\"media.${id}.1\"`,
    createdAt: "2026-08-25T12:00:00.000Z",
    createdBy: "author-1",
    updatedAt: "2026-08-25T12:00:00.000Z",
    updatedBy: "author-1",
  };
}

/** The profile avatar, which is an image when there is a photo and a span when not. */
function avatarImage(): HTMLElement | undefined {
  return screen
    .queryAllByRole("presentation", { hidden: true })
    .find((node) => node.className.includes("account-avatar"));
}

function renderRoute() {
  return render(
    <MemoryRouter>
      <AuthorProfileRoute />
    </MemoryRouter>,
  );
}

async function renderLoaded(overrides: Partial<SelfAuthorProfile> = {}) {
  mocks.cmsGetAuthorProfile.mockResolvedValue({
    apiVersion: 1,
    success: true,
    profile: profile(overrides),
  });
  renderRoute();
  await screen.findByRole("heading", { name: "Your public profile" });
}

async function chooseAndConfirmPhoto(): Promise<File> {
  const file = new File([new Uint8Array(1_000)], "replacement.png", {
    type: "image/png",
  });
  fireEvent.change(screen.getByLabelText("Choose a photo"), {
    target: { files: [file] },
  });
  await screen.findByRole("group", {
    name: /How may NJ PBS use this photo/,
  });
  fireEvent.click(screen.getByLabelText(/^It is my own photo$/));
  fireEvent.click(screen.getByLabelText(/^I confirm NJ PBS may publish/));
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.cmsListAuthorPagePosts.mockResolvedValue({
    apiVersion: 1,
    success: true,
    posts: [
      { id: "post-1", headline: "Budget hearing", publishDate: "2026-08-20" },
      { id: "post-2", headline: "Transit delays", publishDate: "2026-08-21" },
    ],
    nextCursor: null,
  });
});

describe("author profile route", () => {
  it("opens the profile after StrictMode replays mount effects", async () => {
    mocks.cmsGetAuthorProfile.mockResolvedValue({ apiVersion: 1, success: true, profile: profile() });
    render(<StrictMode><MemoryRouter><AuthorProfileRoute /></MemoryRouter></StrictMode>);
    expect(await screen.findByRole("heading", { name: "Your public profile" })).toBeVisible();
    expect(screen.queryByText("Opening your profile.")).not.toBeInTheDocument();
  });

  it("publishes the saved photograph to the shell avatars", async () => {
    // The sidebar and header avatars are drawn by the shell, which has no author
    // profile of its own. This route is the only screen that changes the photo,
    // so it hands the shell the value it already holds after each load and save;
    // without that, the avatars a person looks at most stayed on initials until a
    // full reload.
    const setPhoto = vi.fn();
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile(),
    });
    render(
      <MemoryRouter>
        <OwnAuthorPhotoProvider value={{ photo: null, setPhoto }}>
          <AuthorProfileRoute />
        </OwnAuthorPhotoProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Your public profile" });
    expect(setPhoto).toHaveBeenLastCalledWith(null);

    mocks.cmsUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ photo: storedPhoto(), version: 5 }),
    });
    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Interim director" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(setPhoto).toHaveBeenLastCalledWith(storedPhoto()),
    );
  });

  it("loads picker options only for the signed-in author's stable byline", async () => {
    await renderLoaded();

    await waitFor(() =>
      expect(mocks.cmsListAuthorPagePosts).toHaveBeenCalledWith("id-token", {
        authorId: "au_1",
      }),
    );
    expect(screen.getByLabelText("Pinned post")).toHaveTextContent(
      "Budget hearing",
    );
  });

  it("opens the signed-in author's own profile and fills the form", async () => {
    await renderLoaded();

    expect(mocks.cmsGetAuthorProfile).toHaveBeenCalledWith("id-token");
    expect(screen.getByLabelText(/^Public name/)).toHaveValue("Sam Morgan");
    expect(screen.getByLabelText("Job title")).toHaveValue("Director");
    expect(screen.getByLabelText("Short bio")).toHaveValue(
      "Covers local news collaboration.",
    );
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  });

  it("falls back to initials when there is no photo", async () => {
    await renderLoaded();
    expect(screen.getByText("SM")).toBeInTheDocument();
    expect(avatarImage()).toBeUndefined();
  });

  it("draws the avatar from the stored photo and its focal point", async () => {
    await renderLoaded({ photo: storedPhoto() });
    expect(screen.queryByText("SM")).not.toBeInTheDocument();
    expect(avatarImage()?.getAttribute("src")).toContain("asset-1");
    // The stored focal point is what places the square crop; the original is
    // never re-encoded, so the same file serves every avatar size.
    expect(avatarImage()).toHaveStyle({ objectPosition: "25% 75%" });
  });

  it("sends the attached photo and its crop with the save", async () => {
    await renderLoaded({ photo: storedPhoto() });
    mocks.cmsUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ photo: { ...storedPhoto(), focalY: 0.7 }, version: 5 }),
    });

    const image = screen.getByAltText("Original image for crop placement");
    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 800 } });
    fireEvent.load(image);
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      expect(mocks.cmsUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        expect.objectContaining({
          photo: {
            assetId: "asset-1",
            focalX: 0.25,
            focalY: 0.7,
            credit: null,
            rightsBasis: "own-photo",
          },
          expectedVersion: 4,
        }),
      );
    });
  });

  it("attaches a photo that uploads after an earlier profile save", async () => {
    const afterTextSave = profile({ jobTitle: "Interim director", version: 5 });
    const savedPhoto = {
      ...storedPhoto(),
      assetId: "asset-2",
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-2/b.png",
      mimeType: "image/png",
    };
    mocks.cmsGetAuthorProfile
      .mockResolvedValueOnce({ apiVersion: 1, success: true, profile: profile() })
      .mockResolvedValueOnce({ apiVersion: 1, success: true, profile: afterTextSave });
    mocks.cmsUpdateAuthorProfile
      .mockResolvedValueOnce({ apiVersion: 1, success: true, profile: afterTextSave })
      .mockResolvedValueOnce({
        apiVersion: 1,
        success: true,
        profile: profile({ jobTitle: "Interim director", photo: savedPhoto, version: 6 }),
      });
    mocks.uploadAuthorPhoto.mockResolvedValue({
      success: true,
      asset: uploadedAsset("asset-2", savedPhoto.url),
    });

    renderRoute();
    await screen.findByRole("heading", { name: "Your public profile" });
    const file = new File([new Uint8Array(1_000)], "replacement.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("Choose a photo"), {
      target: { files: [file] },
    });
    await screen.findByRole("group", {
      name: /How may NJ PBS use this photo/,
    });
    fireEvent.click(screen.getByLabelText(/^It is my own photo$/));
    fireEvent.click(screen.getByLabelText(/^I confirm NJ PBS may publish/));

    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Interim director" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");

    fireEvent.click(
      screen.getByRole("button", { name: "Upload and save photo" }),
    );

    await waitFor(() => expect(mocks.cmsUpdateAuthorProfile).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Photo saved.")).toBeInTheDocument();
    expect(mocks.cmsUpdateAuthorProfile).toHaveBeenLastCalledWith(
      "id-token",
      expect.objectContaining({
        expectedVersion: 5,
        jobTitle: "Interim director",
        photo: expect.objectContaining({ assetId: "asset-2" }),
      }),
    );
    expect(
      screen
        .getAllByRole("presentation", { hidden: true })
        .every((image) => image.getAttribute("src") === savedPhoto.url),
    ).toBe(true);
  });

  it("does not overwrite a profile photo that changed during attachment", async () => {
    const competingPhoto = {
      ...storedPhoto(),
      assetId: "asset-admin",
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-admin/admin.jpg",
    };
    mocks.cmsGetAuthorProfile
      .mockResolvedValueOnce({ apiVersion: 1, success: true, profile: profile() })
      .mockResolvedValueOnce({ apiVersion: 1, success: true, profile: profile() })
      .mockResolvedValueOnce({
        apiVersion: 1,
        success: true,
        profile: profile({ photo: competingPhoto, version: 5 }),
      });
    mocks.cmsUpdateAuthorProfile.mockRejectedValueOnce(
      new HttpError(409, "Profile was changed by someone else"),
    );
    mocks.uploadAuthorPhoto.mockResolvedValue({
      success: true,
      asset: uploadedAsset(
        "asset-uploaded",
        "https://media.njpbs.org/cms-media/staff-profile/asset-uploaded/new.png",
      ),
    });

    renderRoute();
    await screen.findByRole("heading", { name: "Your public profile" });
    await chooseAndConfirmPhoto();
    fireEvent.click(
      screen.getByRole("button", { name: "Upload and save photo" }),
    );

    expect(
      await screen.findByText(/Someone else changed this profile photo/),
    ).toBeInTheDocument();
    expect(mocks.cmsUpdateAuthorProfile).toHaveBeenCalledTimes(1);
  });

  it("closes the form when the account is deactivated during photo attachment", async () => {
    mocks.cmsGetAuthorProfile
      .mockResolvedValueOnce({ apiVersion: 1, success: true, profile: profile() })
      .mockRejectedValueOnce(
        new HttpError(403, "This CMS account is deactivated", {
          code: "account_inactive",
        }),
      );
    mocks.uploadAuthorPhoto.mockResolvedValue({
      success: true,
      asset: uploadedAsset(
        "asset-uploaded",
        "https://media.njpbs.org/cms-media/staff-profile/asset-uploaded/new.png",
      ),
    });

    renderRoute();
    await screen.findByRole("heading", { name: "Your public profile" });
    await chooseAndConfirmPhoto();
    fireEvent.click(
      screen.getByRole("button", { name: "Upload and save photo" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Your CMS account is deactivated",
      }),
    ).toBeInTheDocument();
    expect(mocks.cmsUpdateAuthorProfile).not.toHaveBeenCalled();
  });

  it("clears the photo explicitly rather than by omission when it is removed", async () => {
    await renderLoaded({ photo: storedPhoto() });
    mocks.cmsUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ version: 5 }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      // Null, not absent: the server preserves a stored photograph for a missing
      // key, so a removal that stayed quiet would not remove anything.
      expect(mocks.cmsUpdateAuthorProfile).toHaveBeenCalledWith(
        "id-token",
        expect.objectContaining({ photo: null }),
      );
    });
  });

  it("refuses an empty public name before spending a request", async () => {
    await renderLoaded();

    fireEvent.change(screen.getByLabelText(/^Public name/), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText(
        "Enter the name that should appear on your published work.",
      ),
    ).toBeInTheDocument();
    expect(mocks.cmsUpdateAuthorProfile).not.toHaveBeenCalled();
  });

  it("marks a social link that is not on the allowlist", async () => {
    await renderLoaded();

    fireEvent.change(screen.getByLabelText("X profile link"), {
      target: { value: "https://twitter.example/smorgan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText(/Check this X profile link/),
    ).toBeInTheDocument();
    expect(mocks.cmsUpdateAuthorProfile).not.toHaveBeenCalled();
  });

  it("saves the whole profile against the version it was opened at", async () => {
    await renderLoaded();
    mocks.cmsUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ jobTitle: "Senior director", version: 5 }),
    });

    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Senior director" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      expect(mocks.cmsUpdateAuthorProfile).toHaveBeenCalledWith("id-token", {
        displayName: "Sam Morgan",
        jobTitle: "Senior director",
        bio: "Covers local news collaboration.",
        photo: null,
        links: {},
        pinnedPostId: null,
        hiddenPostIds: [],
        expectedVersion: 4,
      });
    });
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  });

  it("explains a conflict in plain language and offers both ways out", async () => {
    await renderLoaded();
    mocks.cmsUpdateAuthorProfile.mockRejectedValueOnce(
      new HttpError(409, "Profile was changed by someone else"),
    );

    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Senior director" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText("Someone else changed this profile"),
    ).toBeInTheDocument();

    // Saving over it reads the stored version first, so the overwrite is deliberate
    // and still version-checked rather than a blind retry.
    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ version: 9 }),
    });
    mocks.cmsUpdateAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ jobTitle: "Senior director", version: 10 }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save my version anyway" }));

    await waitFor(() => {
      expect(mocks.cmsUpdateAuthorProfile).toHaveBeenLastCalledWith(
        "id-token",
        expect.objectContaining({ expectedVersion: 9 }),
      );
    });
    expect(
      screen.queryByText("Someone else changed this profile"),
    ).not.toBeInTheDocument();
  });

  it("keeps new publication paused without assuming existing public pages were removed", async () => {
    await renderLoaded();

    const publishing = screen
      .getByRole("heading", { name: "Publishing" })
      .closest("section, div") as HTMLElement;
    expect(publishing).toHaveTextContent(/Self-service profile publication is paused/);
    expect(
      screen.getByText(
        "Your profile is not published. Only staff signed in to the CMS can see it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Publishing is paused")).toBeInTheDocument();
    expect(screen.queryByText(/pages are not deployed|when those pages launch/)).not.toBeInTheDocument();

    const publish = screen.getByRole("button", { name: "Publish profile" });
    expect(publish).toBeDisabled();
    fireEvent.click(publish);
    expect(mocks.cmsSetAuthorProfileVisibility).not.toHaveBeenCalled();
  });

  it("still lets an already published profile be taken down", async () => {
    // Unpublish is never gated on the public build: whatever is public has to stay
    // removable.
    await renderLoaded({
      visibility: "published",
      slug: "sam-morgan",
      publicPath: "/authors/sam-morgan/",
      publishedAt: "2026-08-20T12:00:00.000Z",
    });
    mocks.cmsSetAuthorProfileVisibility.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ slug: "sam-morgan", version: 5 }),
    });

    expect(screen.getByText("Publishing is paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unpublish profile" }));

    await waitFor(() => {
      expect(mocks.cmsSetAuthorProfileVisibility).toHaveBeenCalledWith("id-token", {
        visibility: "private",
        expectedVersion: 4,
      });
    });
    expect(
      await screen.findByText("Your profile is no longer published."),
    ).toBeInTheDocument();
  });

  it("discloses public-data updates while new publication is paused", async () => {
    await renderLoaded({
      visibility: "published",
      slug: "sam-morgan",
      publicPath: "/authors/sam-morgan/",
    });

    expect(
      screen.getByText(
        /Saving updates its public profile data.*Check the public page/s,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Self-service profile publication is paused/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText(/live public|updates the public page|profile is live/i),
    ).not.toBeInTheDocument();
  });

  it("explains the paused route for an unpublished profile", async () => {
    await renderLoaded();
    expect(
      screen.getByText(
        /Your private profile is not public.*Self-service profile publication is paused/,
      ),
    ).toBeInTheDocument();
  });

  it("will not unpublish while there are unsaved edits", async () => {
    // Unpublishing replaces the form with what the server returns, so allowing it
    // with unsaved text on screen would silently discard that text.
    await renderLoaded({
      visibility: "published",
      slug: "sam-morgan",
      publicPath: "/authors/sam-morgan/",
    });

    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Senior director" },
    });

    const unpublish = screen.getByRole("button", { name: "Unpublish profile" });
    expect(unpublish).toBeDisabled();
    expect(
      screen.getByText(/doing either now would discard what you have just typed/),
    ).toBeInTheDocument();
    fireEvent.click(unpublish);
    expect(mocks.cmsSetAuthorProfileVisibility).not.toHaveBeenCalled();
  });

  it("offers a way out of an unpublish conflict that actually unpublishes", async () => {
    // A 409 on a visibility change must not fall into the edit-overwrite flow: that
    // one sends a text update and would leave the profile public.
    await renderLoaded({
      visibility: "published",
      slug: "sam-morgan",
      publicPath: "/authors/sam-morgan/",
    });
    mocks.cmsSetAuthorProfileVisibility.mockRejectedValueOnce(
      new HttpError(409, "Profile was changed by someone else"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Unpublish profile" }));

    expect(
      await screen.findByText(/your profile was not unpublished/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save my version anyway" }),
    ).not.toBeInTheDocument();

    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({
        visibility: "published",
        slug: "sam-morgan",
        publicPath: "/authors/sam-morgan/",
        version: 11,
      }),
    });
    mocks.cmsSetAuthorProfileVisibility.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile({ slug: "sam-morgan", version: 12 }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try unpublishing again" }));

    await waitFor(() => {
      expect(mocks.cmsSetAuthorProfileVisibility).toHaveBeenLastCalledWith(
        "id-token",
        { visibility: "private", expectedVersion: 11 },
      );
    });
    expect(mocks.cmsUpdateAuthorProfile).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Your profile is no longer published."),
    ).toBeInTheDocument();
  });

  it("asks for unsaved work to be saved before publishing", async () => {
    await renderLoaded();

    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Senior director" },
    });

    expect(
      screen.getByText(/Save your changes first/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish profile" })).toBeDisabled();
  });

  it("shows a deactivated account a plain closed state, not a form", async () => {
    // The server refuses every self endpoint for a deactivated account, reads
    // included, so there is no profile to edit and nothing to retry.
    mocks.cmsGetAuthorProfile.mockRejectedValueOnce(
      new HttpError(403, "This CMS account is deactivated", {
        code: "account_inactive",
      }),
    );
    renderRoute();

    expect(
      await screen.findByRole("heading", {
        name: "Your CMS account is deactivated",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Public name/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Publish profile" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("closes the form when the account is deactivated mid-edit", async () => {
    await renderLoaded();
    mocks.cmsUpdateAuthorProfile.mockRejectedValueOnce(
      new HttpError(403, "This CMS account is deactivated", {
        code: "account_inactive",
      }),
    );

    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Senior director" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByRole("heading", {
        name: "Your CMS account is deactivated",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Job title")).not.toBeInTheDocument();
  });

  it("keeps a failed load recoverable instead of showing an empty form", async () => {
    mocks.cmsGetAuthorProfile.mockRejectedValueOnce(
      new HttpError(503, "The profile service is unavailable"),
    );
    renderRoute();

    expect(
      await screen.findByText("The profile service is unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Public name/)).not.toBeInTheDocument();

    mocks.cmsGetAuthorProfile.mockResolvedValue({
      apiVersion: 1,
      success: true,
      profile: profile(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "Your public profile" }),
    ).toBeInTheDocument();
  });

  it("keeps every field reachable by keyboard in tab order", async () => {
    await renderLoaded();

    // Name, job title, bio, and one link for each of the three platforms.
    const fields = screen.getAllByRole("textbox");
    expect(fields).toHaveLength(6);
    for (const field of fields) {
      expect(field).not.toHaveAttribute("tabindex", "-1");
    }
  });
});
