import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { AuthorPhotoField } from "../src/components/AuthorPhotoField";
import type { AuthorPhotoFormValue } from "../src/lib/author-profile-form";
import {
  AUTHOR_PAGES_LIVE,
  authorPhotoActionCopy,
  buildAuthorProfileReleaseCopy,
  type AuthorPhotoAssetSource,
  type AuthorPhotoSaveMode,
  type AuthorPhotoSubject,
} from "../src/lib/author-profile-release";
import type { MediaAssetSummary } from "../src/lib/functions";
import { resetMediaCategoryRegistry } from "../src/lib/use-media-categories";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  cmsListMediaCategories: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    getIdToken: mocks.getIdToken,
    state: {
      status: "signed-in",
      user: { uid: "user-1" },
      principal: { id: "user-1", grants: [{ role: "editor" }] },
    },
  }),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsListMediaCategories: mocks.cmsListMediaCategories,
}));

// What a person can and cannot do with a profile photograph.
//
// The load-bearing case here is the attestation gate: nothing may reach the media
// library until someone has said which rights basis applies and confirmed it,
// before automated validation permits its use on a public page.

function photoValue(
  overrides: Partial<AuthorPhotoFormValue> = {},
): AuthorPhotoFormValue {
  return {
    assetId: "asset-1",
    url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/a.jpg",
    width: 800,
    height: 800,
    focalX: 0.5,
    focalY: 0.5,
    credit: "",
    rightsBasis: "own-photo",
    ...overrides,
  };
}

function asset(overrides: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return {
    id: "asset-2",
    name: "Profile photo: Jordan Avery",
    originalName: "joe.jpg",
    category: "staff-profile",
    categories: ["staff-profile"],
    tags: [],
    description: null,
    altText: "Jordan Avery",
    license: "Profile photo: supplied by the staff member, cleared for use",
    credit: null,
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 400_000,
    url: "https://media.njpbs.org/cms-media/staff-profile/asset-2/b.jpg",
    width: 900,
    height: 900,
    source: "upload",
    lifecycle: "active",
    version: 1,
    etag: '"media.YXNzZXQtMg.1"',
    createdAt: "2026-08-25T12:00:00.000Z",
    createdBy: "user-1",
    updatedAt: "2026-08-25T12:00:00.000Z",
    updatedBy: "user-1",
    ...overrides,
  };
}

/** A file the browser reports as a real image of the given type and size. */
function imageFile(
  { type = "image/jpeg", bytes = 400_000, name = "headshot.jpg" } = {},
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function setup({
  value = null,
  onUpload = vi.fn(async () => asset()),
  onUploaded,
  profileIsPublished = false,
  subject = "self" as const,
  loadMedia,
  mediaCategories,
}: {
  value?: AuthorPhotoFormValue | null;
  onUpload?: (
    file: File,
    options: { rightsBasis: never; credit: string },
  ) => Promise<MediaAssetSummary>;
  onUploaded?: (value: AuthorPhotoFormValue) => Promise<void>;
  profileIsPublished?: boolean;
  subject?: "self" | "other";
  loadMedia?: ComponentProps<typeof AuthorPhotoField>["loadMedia"];
  mediaCategories?: ComponentProps<typeof AuthorPhotoField>["mediaCategories"];
} = {}) {
  const onChange = vi.fn();
  const view = render(
    <AuthorPhotoField
      idPrefix="test"
      loadMedia={loadMedia}
      mediaCategories={mediaCategories}
      onChange={onChange}
      onUpload={onUpload as never}
      onUploaded={onUploaded}
      profileIsPublished={profileIsPublished}
      subject={subject}
      value={value}
    />,
  );
  return { onChange, onUpload, view };
}

async function chooseFile(file: File): Promise<void> {
  const input = screen.getByLabelText(/Choose a photo|Replace with a different photo/);
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(
      screen.queryByRole("group", { name: /How may NJ PBS use this photo/ }) ??
        screen.queryByText(/Choose a/),
    ).toBeTruthy(),
  );
}

beforeEach(() => {
  resetMediaCategoryRegistry();
  mocks.getIdToken.mockReset().mockResolvedValue("id-token");
  mocks.cmsListMediaCategories.mockReset().mockResolvedValue({ categories: [] });
  // jsdom cannot decode images, so the dimension pre-check is unavailable and the
  // field falls through to the server -- the same path a browser without
  // createImageBitmap takes.
  Reflect.deleteProperty(globalThis, "createImageBitmap");
});

const photoCopyCases = (["self", "other"] as const).flatMap((subject) =>
  ([false, true] as const).flatMap((profileIsPublished) =>
    (["upload", "library"] as const).flatMap((assetSource) =>
      (["immediate", "profile-save"] as const).map((saveMode) => ({
        assetSource,
        profileIsPublished,
        saveMode,
        subject,
      })),
    ),
  ),
);

function expectedActionCopy({
  assetSource,
  saveMode,
  subject,
}: {
  assetSource: AuthorPhotoAssetSource;
  saveMode: AuthorPhotoSaveMode;
  subject: AuthorPhotoSubject;
}): string {
  const profile = subject === "self" ? "your profile" : "this profile";
  if (assetSource === "library") {
    return saveMode === "immediate"
      ? `This uses the existing media asset and saves it to ${profile}. It does not upload another copy.`
      : `This uses the existing media asset. It does not upload another copy. Save ${profile} to attach it.`;
  }
  return saveMode === "immediate"
    ? `This action uploads the photo and saves it to ${profile}.`
    : `Uploading adds the photo to the media library. Save ${profile} to attach it.`;
}

describe("profile photo field", () => {
  it("selects every route-state sentence from the release gate", () => {
    const paused = buildAuthorProfileReleaseCopy(false);
    const live = buildAuthorProfileReleaseCopy(true);
    const pairs = [
      [paused.photoDescription("your"), live.photoDescription("your")],
      [
        paused.selfProfileDescription(true),
        live.selfProfileDescription(true),
      ],
      [
        paused.selfProfileDescription(false),
        live.selfProfileDescription(false),
      ],
      [paused.publishingDescription, live.publishingDescription],
      [paused.publishedStatus("/authors/name/"), live.publishedStatus("/authors/name/")],
      [paused.addressHint, live.addressHint],
      [paused.adminOverview, live.adminOverview],
      [paused.adminStateColumn, live.adminStateColumn],
      [paused.adminPublishedBadge, live.adminPublishedBadge],
      [
        paused.adminPublishedDescription("/authors/name/"),
        live.adminPublishedDescription("/authors/name/"),
      ],
    ];

    for (const [pausedCopy, liveCopy] of pairs) {
      expect(pausedCopy).not.toBe(liveCopy);
    }
    expect(pairs.map(([pausedCopy]) => pausedCopy).join(" ")).toMatch(
      /Self-service profile publication is paused/,
    );
    expect(pairs.map(([, liveCopy]) => liveCopy).join(" ")).not.toMatch(
      /paused|not deployed|does not change njpbs\.org|not available on njpbs\.org/i,
    );
  });

  it.each(photoCopyCases)(
    "explains the $subject $profileIsPublished $assetSource $saveMode state without a live-site claim",
    ({ assetSource, profileIsPublished, saveMode, subject }) => {
      const copy = authorPhotoActionCopy({
        assetSource,
        profileIsPublished,
        saveMode,
        subject,
      });

      expect(AUTHOR_PAGES_LIVE).toBe(false);
      expect(copy).toContain(
        expectedActionCopy({ assetSource, saveMode, subject }),
      );
      expect(copy).toContain(
        profileIsPublished
          ? "This profile is marked published in the CMS. Saved photo changes update its public profile data. Check the public page to confirm changes."
          : subject === "other"
            ? "This profile is private. An administrator can publish it, making this photo public."
            : "This profile is private. The photo can appear publicly after the profile is published; self-service profile publication is paused.",
      );
      expect(copy).not.toMatch(/live public|immediately|changes? njpbs\.org/i);
    },
  );

  it("does not upload until a rights basis and the confirmation are given", async () => {
    const { onUpload } = setup();
    await chooseFile(imageFile());

    const upload = screen.getByRole("button", { name: "Upload photo" });
    expect(upload).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/^It is my own photo/));
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeEnabled();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("requires the photographer's credit before a licensed photo can upload", async () => {
    setup();
    await chooseFile(imageFile());
    fireEvent.click(screen.getByLabelText(/^Someone else took it and licensed it/));
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Photographer's credit/), {
      target: { value: "Ryan Jones" },
    });
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeEnabled();
  });

  it("sends the attestation with the upload and reports the new photo centered", async () => {
    const onUpload = vi.fn(
      async (
        _file: File,
        _options: { rightsBasis: string; credit: string },
      ): Promise<MediaAssetSummary> => asset(),
    );
    const { onChange } = setup({ onUpload: onUpload as never });
    await chooseFile(imageFile());
    fireEvent.click(screen.getByLabelText(/^It is my own photo/));
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Upload photo" }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0]?.[1]).toEqual({
      rightsBasis: "own-photo",
      credit: "",
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: "asset-2",
          focalX: 0.5,
          focalY: 0.5,
          rightsBasis: "own-photo",
        }),
      ),
    );
  });

  it("completes an immediate profile save when the route supplies one", async () => {
    const onUploaded = vi.fn(async () => undefined);
    const { onChange } = setup({ onUploaded });
    await chooseFile(imageFile());
    fireEvent.click(screen.getByLabelText(/^It is my own photo/));
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(
      screen.getByRole("button", { name: "Upload and save photo" }),
    );

    await waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: "asset-2", rightsBasis: "own-photo" }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("chooses an existing profile image without uploading another copy", async () => {
    const existing = asset();
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [existing],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { "staff-profile": 1 },
      kindCounts: { image: 1, document: 0 },
    }));
    const { onChange, onUpload } = setup({ loadMedia });

    fireEvent.click(
      screen.getByRole("button", { name: "Choose from media library" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Profile photo: Jordan Avery/ }),
    );
    expect(screen.getByRole("button", { name: "Use photo" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Use photo" }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: "asset-2",
          rightsBasis: "own-photo",
        }),
      ),
    );
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("shows registered category details and a separate origin in the profile picker", async () => {
    const existing = asset({ category: "news", categories: ["news"] });
    const loadMedia = vi.fn(async () => ({
      success: true as const, records: [existing], total: 1, allCount: 1, page: 1, pageCount: 1,
      categoryCounts: { news: 1 }, kindCounts: { image: 1, document: 0 },
    }));
    mocks.cmsListMediaCategories.mockResolvedValue({ categories: [{
      id: "news", label: "News", description: "Newsroom media", order: 10,
      active: true, reserved: false, version: 1, etag: '"media-category.bmV3cw.1"',
      canUpload: true, canManage: false, createdAt: null, createdBy: null, updatedAt: null, updatedBy: null,
    }] });
    setup({ loadMedia });
    expect(mocks.cmsListMediaCategories).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose from media library" }));
    expect(await screen.findByText("Category: News")).toBeVisible();
    expect(screen.getByText("Newsroom media")).toBeVisible();
    expect(screen.getByText("Origin: Uploaded")).toBeVisible();
    expect(mocks.cmsListMediaCategories).toHaveBeenCalledTimes(1);
    expect(mocks.cmsListMediaCategories).toHaveBeenCalledWith("id-token");
  });

  it("uses a general library image with a warning instead of refusing it", async () => {
    const general = asset({ category: "general", categories: ["general"], license: "NJ PBS owned" });
    const loadMedia = vi.fn(async () => ({
      success: true as const, records: [general], total: 1, allCount: 1, page: 1, pageCount: 1,
      categoryCounts: { general: 1 }, kindCounts: { image: 1, document: 0 },
    }));
    const { onChange } = setup({ loadMedia });
    fireEvent.click(screen.getByRole("button", { name: "Choose from media library" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Profile photo: Jordan Avery/ }));
    expect(screen.getByText(/no staff photo rights record/)).toHaveTextContent('"NJ PBS owned"');
    fireEvent.click(screen.getByRole("radio", { name: /NJ PBS or Montclair State took it/ }));
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ assetId: "asset-2", rightsBasis: "station-photo" })),
    );
  });

  it("refuses a library image that the server would refuse, at selection", async () => {
    const small = asset({ category: "general", categories: ["general"], width: 300, height: 300 });
    const loadMedia = vi.fn(async () => ({
      success: true as const, records: [small], total: 1, allCount: 1, page: 1, pageCount: 1,
      categoryCounts: { general: 1 }, kindCounts: { image: 1, document: 0 },
    }));
    const { onChange } = setup({ loadMedia });
    await chooseFile(imageFile());
    fireEvent.click(screen.getByLabelText(/^It is my own photo/));
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Choose from media library" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Profile photo: Jordan Avery/ }));
    expect(screen.getByText(/cannot be a profile photo/)).toHaveTextContent(/at least 400 by 400 pixels/);
    expect(screen.queryByRole("button", { name: /^(Use|Upload) photo$/ })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("warns and keeps the chosen basis when an upload reuses a file without profile rights", async () => {
    const onUpload = vi.fn(async () => asset({ category: "general", license: "NJ PBS owned" }));
    const { onChange } = setup({ onUpload: onUpload as never });
    await chooseFile(imageFile());
    fireEvent.click(screen.getByLabelText(/^It is my own photo/));
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Upload photo" }));
    expect(await screen.findByText(/already in the media library/)).toHaveTextContent('"NJ PBS owned"');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /^It is my own photo/ })).toBeChecked();
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ assetId: "asset-2", rightsBasis: "own-photo" })),
    );
    expect(screen.queryByText(/valid profile-photo rights/)).not.toBeInTheDocument();
  });

  it("preserves the crop and refreshes rights when the current image is reselected", async () => {
    const current = photoValue({
      focalX: 0.2,
      focalY: 0.8,
      credit: "Old credit",
      rightsBasis: "own-photo",
    });
    const existing = asset({
      id: current.assetId,
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/current.jpg",
      width: 1_200,
      height: 1_000,
      license: "Profile photo: licensed from a third party, credit required",
      credit: "Current photographer",
    });
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [existing],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { "staff-profile": 1 },
      kindCounts: { image: 1, document: 0 },
    }));
    const { onChange } = setup({ value: current, loadMedia });

    fireEvent.click(
      screen.getByRole("button", { name: "Choose from media library" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Profile photo: Jordan Avery/ }),
    );
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Use photo" }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        ...current,
        url: existing.url,
        width: existing.width,
        height: existing.height,
        focalX: 0.2,
        focalY: 0.8,
        credit: "Current photographer",
        rightsBasis: "licensed-photo",
      }),
    );
  });

  it("explains a reused photo when a published profile route is paused", async () => {
    const existing = asset();
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [existing],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { "staff-profile": 1 },
      kindCounts: { image: 1, document: 0 },
    }));
    setup({
      loadMedia,
      onUploaded: vi.fn(async () => undefined),
      profileIsPublished: true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Choose from media library" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Profile photo: Jordan Avery/ }),
    );

    expect(
      screen.getByText(
        /existing media asset and saves it to your profile.*Saved photo changes update its public profile data/s,
      ),
    ).toBeInTheDocument();
  });

  it("explains a new upload when a published profile route is paused", async () => {
    setup({ onUploaded: vi.fn(async () => undefined), profileIsPublished: true });
    await chooseFile(imageFile());

    expect(
      screen.getByText(
        /uploads the photo and saves it to your profile.*Saved photo changes update its public profile data/s,
      ),
    ).toBeInTheDocument();
  });

  it("refuses an unsupported type or an over-size file before any request", async () => {
    const { onUpload } = setup();
    fireEvent.change(screen.getByLabelText("Choose a photo"), {
      target: { files: [imageFile({ type: "image/gif", name: "wave.gif" })] },
    });
    expect(
      await screen.findByText("Choose a JPEG, PNG, WebP or AVIF image."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Choose a photo"), {
      target: { files: [imageFile({ bytes: 6 * 1024 * 1024 })] },
    });
    expect(await screen.findByText("Choose a photo under 5 MB.")).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("refuses an image smaller than the minimum when the browser can measure it", async () => {
    Reflect.set(globalThis, "createImageBitmap", async () => ({
      width: 320,
      height: 320,
      close: () => {},
    }));
    const { onUpload } = setup();
    fireEvent.change(screen.getByLabelText("Choose a photo"), {
      target: { files: [imageFile()] },
    });
    expect(
      await screen.findByText(
        "Choose a photo at least 400 pixels wide and 400 pixels tall.",
      ),
    ).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("keeps the chosen file and explains a failed upload", async () => {
    const onUpload = vi.fn(async () => {
      throw new Error("The media library is not available right now.");
    });
    const { onChange } = setup({ onUpload: onUpload as never });
    await chooseFile(imageFile());
    fireEvent.click(screen.getByLabelText(/^It is my own photo/));
    fireEvent.click(screen.getByLabelText(/I confirm NJ PBS may publish/));
    fireEvent.click(screen.getByRole("button", { name: "Upload photo" }));

    expect(
      await screen.findByText("The media library is not available right now."),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // The attestation and the file survive the failure, so retrying is one click.
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeEnabled();
  });

  it("offers a keyboard-usable crop and reports each move", () => {
    const { onChange } = setup({ value: photoValue() });
    expect(
      screen.getByText(/This preview shows the square crop for the public profile/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/square crop saved/i)).not.toBeInTheDocument();
    const image = screen.getByAltText("Original image for crop placement");
    Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    fireEvent.load(image);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Image focal point" }), { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ focalX: 0.4, focalY: 0.5 }),
    );
  });

  it("previews the stored crop rather than re-encoding the original", () => {
    setup({ value: photoValue({ focalX: 0.25, focalY: 0.75 }) });
    const image = screen.getByAltText("Original image for crop placement");
    Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
    fireEvent.load(image);
    const preview = screen.getByAltText("Current crop preview");
    expect(preview).toHaveStyle({ objectPosition: "25% 75%" });
    expect(preview.getAttribute("src")).toContain("asset-1");
  });

  it("removes a photo without touching the media library", () => {
    const { onChange, onUpload } = setup({ value: photoValue() });
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onUpload).not.toHaveBeenCalled();
    expect(
      screen.getByText(/The file stays in the media library/),
    ).toBeInTheDocument();
  });

  it("says whose photo it is on the admin surface", () => {
    setup({ subject: "other" });
    expect(
      screen.getByText(/square crop of this person's photo/i),
    ).toBeInTheDocument();
  });
});
