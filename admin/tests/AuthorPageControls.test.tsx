import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AuthorPageControls,
  type AuthorPageControlsValue,
} from "../src/components/AuthorPageControls";

const POSTS = [
  { id: "post-1", headline: "Budget hearing", publishDate: "2026-08-21" },
  { id: "post-2", headline: "Transit delays", publishDate: "2026-08-22" },
];

function renderControls(
  value: AuthorPageControlsValue,
  overrides: Partial<React.ComponentProps<typeof AuthorPageControls>> = {},
) {
  const onChange = vi.fn();
  render(
    <AuthorPageControls
      idPrefix="test"
      onChange={onChange}
      posts={POSTS}
      postsState="ready"
      value={value}
      {...overrides}
    />,
  );
  return onChange;
}

describe("author page controls", () => {
  it("excludes noindex choices and marks a saved noindex pin unavailable without clearing it", () => {
    const posts = [...POSTS, { id: "hidden", headline: "Staff test Post", publishDate: "2026-11-01", noindex: true as const }];
    const value = { pinnedPostId: "hidden", hiddenPostIds: [] };
    const { rerender } = render(<AuthorPageControls idPrefix="visibility" onChange={vi.fn()} posts={posts} postsState="ready" value={value} />);
    const pin = screen.getByRole("combobox", { name: "Pinned post" });
    expect(pin).toHaveValue("hidden");
    expect(screen.getByRole("option", { name: /Staff test Post.*unavailable on author page/ })).toBeDisabled();
    expect(pin).toHaveAccessibleDescription(/The pinned Post is hidden from search engines and cannot appear/);
    expect(screen.getByRole("combobox", { name: "Leave a post off this page" }).querySelector('option[value="hidden"]')).toBeNull();
    rerender(<AuthorPageControls idPrefix="visibility" onChange={vi.fn()} posts={posts} postsState="ready" value={{ ...value, pinnedPostId: null }} />);
    expect(pin.querySelector('option[value="hidden"]')).toBeNull();
    expect(screen.getByRole("combobox", { name: "Leave a post off this page" }).querySelector('option[value="hidden"]')).toBeNull();
    expect(pin.querySelector('option[value="post-1"]')).not.toBeNull();
  });

  it("marks an unloaded saved pin unchecked, then explains noindex when its page loads", () => {
    const value = { pinnedPostId: "later-page", hiddenPostIds: [] };
    const props = { idPrefix: "paging", onChange: vi.fn(), postsState: "ready" as const, value, hasMore: true };
    const { rerender } = render(<AuthorPageControls {...props} posts={POSTS} />);
    const pin = screen.getByRole("combobox", { name: "Pinned post" });
    expect(pin).toHaveValue("later-page");
    expect(screen.getByRole("option", { name: "later-page — status not checked" })).toBeDisabled();
    expect(pin).toHaveAccessibleDescription(/not in the loaded list, so its status is unknown/);
    rerender(<AuthorPageControls {...props} posts={[...POSTS, { id: "later-page", headline: "Later hidden Post", publishDate: "2026-11-01", noindex: true }]} />);
    expect(pin).toHaveValue("later-page");
    expect(screen.getByRole("option", { name: /Later hidden Post.*unavailable on author page/ })).toBeDisabled();
    expect(pin).toHaveAccessibleDescription(/hidden from search engines and cannot appear/);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("says hiding affects only this author page", () => {
    renderControls({ pinnedPostId: null, hiddenPostIds: [] });
    expect(screen.getByText(/stays published at its own address/)).toBeInTheDocument();
    expect(screen.getByText(/still appears on every coauthor’s page/)).toBeInTheDocument();
  });

  it("pins and hides by stable Post id while showing safe summaries", () => {
    const onChange = renderControls({ pinnedPostId: null, hiddenPostIds: [] });
    expect(screen.getAllByText(/Budget hearing.*2026-08-21/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Pinned post"), {
      target: { value: "post-2" },
    });
    expect(onChange).toHaveBeenCalledWith({
      pinnedPostId: "post-2",
      hiddenPostIds: [],
    });

    fireEvent.change(screen.getByLabelText("Leave a post off this page"), {
      target: { value: "post-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Leave off" }));
    expect(onChange).toHaveBeenCalledWith({
      pinnedPostId: null,
      hiddenPostIds: ["post-1"],
    });
  });

  it("keeps a stored unknown id removable", () => {
    const onChange = renderControls({
      pinnedPostId: null,
      hiddenPostIds: ["unpublished-post"],
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: /Put “unpublished-post” back on the page/,
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      pinnedPostId: null,
      hiddenPostIds: [],
    });
  });

  it("drops a pending hide when the editor opens another author", () => {
    const onChange = vi.fn();
    const value = { pinnedPostId: null, hiddenPostIds: [] };
    const { rerender } = render(
      <AuthorPageControls
        idPrefix="author-a"
        onChange={onChange}
        posts={POSTS}
        postsState="ready"
        value={value}
      />,
    );
    fireEvent.change(screen.getByLabelText("Leave a post off this page"), {
      target: { value: "post-1" },
    });

    rerender(
      <AuthorPageControls
        idPrefix="author-b"
        onChange={onChange}
        posts={[]}
        postsState="loading"
        value={value}
      />,
    );

    expect(screen.getByLabelText("Leave a post off this page")).toHaveValue("");
    const leaveOff = screen.getByRole("button", { name: "Leave off" });
    expect(leaveOff).toBeDisabled();
    fireEvent.click(leaveOff);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("loads another cursor page on demand", () => {
    const onLoadMore = vi.fn();
    renderControls(
      { pinnedPostId: null, hiddenPostIds: [] },
      { hasMore: true, onLoadMore },
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more posts" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("leaves the rest of the form usable when the picker fails", () => {
    const onReload = vi.fn();
    renderControls(
      { pinnedPostId: null, hiddenPostIds: [] },
      { onReload, posts: [], postsState: "error" },
    );
    expect(screen.getByText(/Everything else on this form still saves/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try loading posts again" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
