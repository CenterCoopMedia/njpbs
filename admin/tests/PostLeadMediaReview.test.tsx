import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";
import { RecordForm } from "../src/components/RecordForm";
import { PostLeadMediaReview } from "../src/components/PostLeadMediaReview";
import { VIDEO_BLOCK_SOURCE_ID } from "../../packages/content-core/src/video-block";

afterEach(cleanup);
afterEach(() => localStorage.clear());

const selections = [
  ["cleared", null, "No lead media selected."],
  ["image", { kind: "image", data: { assetId: "selected-photo", alt: "Selected image description", caption: "Selected image credit" } }, "Alt text: Selected image description"],
  ["library video", { kind: "library-video", data: { sourceId: VIDEO_BLOCK_SOURCE_ID, assetId: "selected-video", title: "Selected library video" } }, "Selected video: selected-video"],
  ["linked video", { kind: "linked-video", data: { url: "https://example.org/selected-video", title: "Selected linked video" } }, "Selected linked video"],
  ["embed", { kind: "embed", data: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Selected embedded video" } }, "Selected embedded video"],
  ["invalid", { kind: "embed", data: { url: "javascript:alert(1)", title: "Unsafe source" } }, "The saved lead media is incomplete or unavailable. The article will show no lead media."],
] as const;

describe("empty template lead review (#3640)", () => {
  it.each([undefined, ""])("shows no selection for an absent template lead and legacy image %s", heroImage => {
    render(<PostLeadMediaReview template record={{ heroImage }} />);
    const review = screen.getByRole("group", { name: "Lead media review" });
    expect(within(review).getByText("No lead media selected.")).toBeVisible();
    expect(within(review).getByText(/Posts made from this template/)).toBeVisible();
    expect(screen.queryByText(/incomplete or unavailable/)).toBeNull();
  });

  it.each([{}, { kind: "unsupported" }, { kind: "embed", data: { url: "javascript:alert(1)", title: "Unsafe" } }])(
    "keeps an explicit malformed template lead unavailable: %j", leadMedia => {
      render(<PostLeadMediaReview template record={{ leadMedia }} />);
      expect(screen.getByText(/The saved lead media is incomplete or unavailable/)).toBeVisible();
      expect(screen.queryByText("No lead media selected.")).toBeNull();
      expect(document.querySelector("iframe, a")).toBeNull();
    });

  it.each([null, " ", "invalid/image", 0, {}, []])("keeps a malformed legacy image unavailable: %j", heroImage => {
    render(<PostLeadMediaReview template record={{ heroImage }} />);
    expect(screen.getByText(/The saved lead media is incomplete or unavailable/)).toBeVisible();
  });

  it("keeps a valid legacy image inspectable", () => {
    render(<PostLeadMediaReview template record={{ heroImage: "legacy-photo", heroImageAlt: "A reporter at the desk" }} />);
    expect(screen.getByText("Alt text: A reporter at the desk")).toBeVisible();
    expect(screen.queryByText("No lead media selected.")).toBeNull();
  });

  it("preserves the unavailable state outside template context", () => {
    render(<PostLeadMediaReview record={{}} />);
    expect(screen.getByText(/The saved lead media is incomplete or unavailable/)).toBeVisible();
    expect(screen.getByText(/Shown at the top of this Post/)).toBeVisible();
  });
});

describe.each([false, true])("Post lead review in workspace=%s", workspace => {
  it.each(selections)("shows the actual %s selection and hides inactive legacy fields", (_name, leadMedia, expected) => {
    const form = <RecordForm kind="post" readOnly canSave={false} onSave={vi.fn()}
      initial={{ title: "Review this post", tags: [], blocks: [], leadMedia,
        heroImage: "inactive-legacy-photo", heroImageAlt: "Inactive legacy description", heroImageCaption: "Inactive legacy credit" }} />;
    render(workspace ? <EditorWorkspaceViewProvider kind="post">{form}</EditorWorkspaceViewProvider> : form);
    if (workspace) {
      const opener = screen.getByLabelText("View lead media");
      expect(opener.closest("details")).not.toHaveAttribute("open");
      fireEvent.click(opener);
      expect(opener.closest("details")).toHaveAttribute("open");
      expect(screen.queryByRole("button", { name: "Remove lead media", hidden: true })).toBeNull();
    }
    const review = screen.getByRole("group", { name: "Lead media review" });
    expect(within(review).getByText(expected)).toBeVisible();
    expect(screen.queryByDisplayValue("Inactive legacy description")).toBeNull();
    expect(screen.queryByDisplayValue("Inactive legacy credit")).toBeNull();
    expect(screen.queryByDisplayValue("inactive-legacy-photo")).toBeNull();
    expect(review.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(review.querySelector("iframe")).toBeNull();
    if (_name === "linked video") expect(within(review).getByRole("link")).toHaveAttribute("href", "https://example.org/selected-video");
    if (_name === "embed") expect(within(review).getByRole("link").getAttribute("href")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  });

  it("keeps the existing image editor when the new field is absent", () => {
    const form = <RecordForm kind="post" onSave={vi.fn()} canSave initial={{ title: "Legacy image", tags: [], blocks: [], heroImage: "legacy-photo", heroImageAlt: "Existing image description" }} />;
    render(workspace ? <EditorWorkspaceViewProvider kind="post">{form}</EditorWorkspaceViewProvider> : form);
    expect(screen.queryByRole("group", { name: "Lead media review" })).toBeNull();
    expect(screen.getByDisplayValue("Existing image description")).toBeInTheDocument();
  });
});
