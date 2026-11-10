import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthorPagePosts } from "../src/lib/author-page-posts";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  cmsListAuthorPagePosts: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsListAuthorPagePosts: mocks.cmsListAuthorPagePosts,
}));

function Harness({ authorId }: { authorId: string }) {
  const result = useAuthorPagePosts(authorId, true);
  return (
    <>
      <p data-testid="state">{result.state}</p>
      <p data-testid="ids">{result.posts.map((post) => post.id).join(",")}</p>
      <p data-testid="more-error">{result.moreError ?? ""}</p>
      <button disabled={!result.hasMore} onClick={() => void result.loadMore()}>
        more
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIdToken.mockResolvedValue("id-token");
});

describe("useAuthorPagePosts", () => {
  it("requests only the selected byline and follows its exact cursor", async () => {
    mocks.cmsListAuthorPagePosts
      .mockResolvedValueOnce({
        apiVersion: 1,
        success: true,
        posts: [
          { id: "post-1", headline: "One", publishDate: "2026-08-20" },
        ],
        nextCursor: "post-1",
      })
      .mockResolvedValueOnce({
        apiVersion: 1,
        success: true,
        posts: [
          { id: "post-2", headline: "Two", publishDate: "2026-08-21" },
        ],
        nextCursor: null,
      });

    render(<Harness authorId="au_123" />);

    expect(await screen.findByText("post-1")).toBeInTheDocument();
    expect(mocks.cmsListAuthorPagePosts).toHaveBeenNthCalledWith(
      1,
      "id-token",
      { authorId: "au_123" },
    );

    fireEvent.click(screen.getByRole("button", { name: "more" }));
    await waitFor(() => expect(screen.getByTestId("ids")).toHaveTextContent("post-1,post-2"));
    expect(mocks.cmsListAuthorPagePosts).toHaveBeenNthCalledWith(
      2,
      "id-token",
      { authorId: "au_123", startAfter: "post-1" },
    );
    expect(screen.getByRole("button", { name: "more" })).toBeDisabled();
  });

  it("keeps an already loaded page when a later page fails", async () => {
    mocks.cmsListAuthorPagePosts
      .mockResolvedValueOnce({
        apiVersion: 1,
        success: true,
        posts: [
          { id: "post-1", headline: "One", publishDate: "2026-08-20" },
        ],
        nextCursor: "post-1",
      })
      .mockRejectedValueOnce(new Error("offline"));

    render(<Harness authorId="au_123" />);
    expect(await screen.findByText("post-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "more" }));

    expect(await screen.findByText("More posts could not be loaded. Try again.")).toBeInTheDocument();
    expect(screen.getByTestId("ids")).toHaveTextContent("post-1");
    expect(screen.getByRole("button", { name: "more" })).not.toBeDisabled();
  });
});
