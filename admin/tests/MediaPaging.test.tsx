import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaPaging } from "../src/components/media/MediaPaging";

describe("MediaPaging", () => {
  it("moves from the bounded numbered page when the requested page is out of range", () => {
    const onPage = vi.fn();
    render(<MediaPaging mode="numbered" page={5} pageCount={3} onPage={onPage} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPage).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("keeps focus pending until a slow page transition changes the status", async () => {
    const onPage = vi.fn();
    const { rerender } = render(<MediaPaging mode="numbered" page={1} pageCount={3} onPage={onPage} />);
    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    rerender(<MediaPaging mode="numbered" page={2} pageCount={3} onPage={onPage} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toHaveFocus());
  });

  it("restores Load more focus after a failed request", async () => {
    const onMore = vi.fn();
    const { rerender } = render(<MediaPaging mode="load-more" loaded={24} hasMore onMore={onMore} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more items" }));
    expect(onMore).toHaveBeenCalledOnce();
    rerender(<MediaPaging mode="load-more" loaded={24} hasMore loading onMore={onMore} />);
    rerender(<MediaPaging mode="load-more" loaded={24} hasMore error="Could not load more items" onMore={onMore} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more items" })).toHaveFocus());
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load more items");
  });

  it("moves focus to an enabled control when a cursor step reaches page one", async () => {
    const onFirst = vi.fn();
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(<MediaPaging mode="cursor" page={2} isLastPage={false} onFirst={onFirst} onPrevious={onPrevious} onNext={onNext} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPrevious).toHaveBeenCalledOnce();
    rerender(<MediaPaging mode="cursor" page={1} isLastPage={false} onFirst={onFirst} onPrevious={onPrevious} onNext={onNext} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toHaveFocus());
  });

  it("does not reclaim focus when the user leaves paging during a slow transition", async () => {
    const onPage = vi.fn();
    const view = (page: number) => <>
      <button type="button">Filter</button>
      <MediaPaging mode="numbered" page={page} pageCount={3} onPage={onPage} />
    </>;
    const { rerender } = render(view(1));
    const next = screen.getByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    screen.getByRole("button", { name: "Filter" }).focus();
    rerender(view(2));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(screen.getByRole("button", { name: "Filter" })).toHaveFocus();
  });
});
