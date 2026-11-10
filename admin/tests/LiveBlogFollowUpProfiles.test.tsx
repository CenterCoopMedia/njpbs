import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LiveBlogEditor } from "../src/components/LiveBlogEditor";
import { LiveBlogDirectPublish } from "../src/components/LiveBlogDirectPublish";
import type { LiveBlogDraft } from "../../packages/content-core/src/live-blog-draft";

afterEach(cleanup);
const author = {
  authorId: `au_${"a".repeat(32)}`, displayName: "Follow-up Reporter", jobTitle: "Reporter",
  profileReadiness: { hasPhoto: false, hasJobTitle: true, hasBio: true, published: true },
};
const draft = (): LiveBlogDraft => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{
  id: "entry-a", headline: "First report", body: { type: "doc", content: [] }, credits: [], keyUpdate: false,
  followUps: [{ id: "follow-a", body: { type: "doc", content: [] }, credits: [{ kind: "registered", authorId: author.authorId }] }],
}] });

describe("follow-up reporter profile notices", () => {
  it("warns beside a follow-up byline and before publication with the protected self-profile link", () => {
    render(<LiveBlogEditor controlId="follow-up-profiles" value={draft()} authors={[author]} selfAuthorId={author.authorId} onChange={vi.fn()} />);
    for (const label of ["Reporter profiles for follow-up 1", "Reporter profiles before publishing"]) {
      const notice = screen.getByRole("group", { name: label });
      expect(notice).toHaveTextContent("Follow-up Reporter’s author profile is missing a photo.");
      expect(within(notice).getByRole("link", { name: "Edit Follow-up Reporter’s author profile" })).toHaveAttribute("href", "/account/profile");
    }
    expect(screen.getByRole("button", { name: "Add follow-up" })).toBeEnabled();
  });

  it("includes nested credits before direct publication without blocking the action", async () => {
    const onPublish = vi.fn(async () => {});
    render(<LiveBlogDirectPublish liveBlog={draft()} authors={[author]} selfAuthorId={author.authorId} onPublish={onPublish} />);
    expect(screen.getByRole("group", { name: "Reporter profiles before publishing" })).toHaveTextContent("missing a photo");
    fireEvent.click(screen.getByRole("button", { name: "Publish live updates now" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledOnce());
  });

  it("stays quiet while the profile directory is loading", () => {
    render(<LiveBlogEditor controlId="follow-up-profiles" value={draft()} authorsLoading onChange={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Reporter profiles for follow-up 1" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Reporter profiles before publishing" })).toBeNull();
  });

  it("omits nested notices after the follow-up or its parent is withdrawn", () => {
    const value = draft(); value.updates[0].followUps![0].withdrawal = "Could not verify.";
    const { rerender } = render(<LiveBlogEditor controlId="follow-up-profiles" value={value} authors={[author]} onChange={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Reporter profiles for follow-up 1" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Reporter profiles before publishing" })).toBeNull();
    delete value.updates[0].followUps![0].withdrawal; value.updates[0].withdrawal = "Update withdrawn.";
    rerender(<LiveBlogEditor controlId="follow-up-profiles" value={value} authors={[author]} onChange={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Reporter profiles before publishing" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add follow-up" })).toBeDisabled();
  });
});
