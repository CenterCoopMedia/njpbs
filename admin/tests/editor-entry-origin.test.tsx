import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { NewsroomHome, type NewsroomRecord } from "../src/components/NewsroomHome";
import { selectLibraryRecords } from "../src/lib/content-library";
import { DEFAULT_CONTENT_QUERY } from "../src/lib/content-query";
import { readListOrigin } from "../src/lib/editor-back";

// Every surface a person opens an editor from has to record which list that was, or the editor's
// Back action falls to a list they never chose and getting back costs a second navigation. The
// content lists already carry it; newsroom home is the work list outside `/content/**` that did not
// (#1036, the Aug. 20 task-flow criterion).
//
// The origin rides on history state, which is not in the DOM, so each case activates the real link
// under a memory router and reads the state the navigation actually landed with.

function renderAt(pathname: string, element: React.ReactNode) {
  const router = createMemoryRouter(
    [
      { path: pathname, element },
      { path: "*", element: <p>elsewhere</p> },
    ],
    { initialEntries: [pathname] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

async function openAndReadOrigin(
  router: ReturnType<typeof createMemoryRouter>,
  link: HTMLElement,
): Promise<string | null> {
  await act(async () => {
    fireEvent.click(link);
  });
  return readListOrigin(router.state.location.state);
}

const records: NewsroomRecord[] = [
  {
    id: "story-17",
    kind: "post",
    status: "draft",
    title: "Transit funding explained",
    updatedAt: "2026-07-20T14:00:00.000Z",
    updatedBy: "user-1",
  },
];

function newsroomSelection() {
  return selectLibraryRecords(records, DEFAULT_CONTENT_QUERY, "user-1");
}

describe("newsroom home as an editor origin", () => {
  function home() {
    return (
      <NewsroomHome
        canEditHomepage
        canBrowsePages
        canBrowseRecords
        canCreate
        canViewPublishActivity={false}
        currentUserId="user-1"
        loadHomeSettings={vi.fn().mockResolvedValue({
          heading: "Newsroom",
          milestoneNumber: 16,
        })}
        loadRecords={vi.fn().mockResolvedValue(newsroomSelection())}
      />
    );
  }

  it("records newsroom home when recent work is opened from it", async () => {
    const { router } = renderAt("/", home());

    const origin = await openAndReadOrigin(
      router,
      await screen.findByRole("link", { name: "Transit funding explained" }),
    );
    expect(origin).toBe("/");
  });

  it("records newsroom home when the homepage editor is opened from it", async () => {
    const { router } = renderAt("/", home());

    const origin = await openAndReadOrigin(
      router,
      await screen.findByRole("link", { name: "Edit homepage" }),
    );
    expect(origin).toBe("/");
  });

  it("records newsroom home when a new event is started from Next steps", async () => {
    const { router } = renderAt("/", home());

    const origin = await openAndReadOrigin(
      router,
      await screen.findByRole("link", { name: "New event" }),
    );
    expect(origin).toBe("/");
  });

  it("records newsroom home when a new post is started from it", async () => {
    const { router } = renderAt("/", home());

    const origin = await openAndReadOrigin(
      router,
      await screen.findByRole("link", { name: "New post" }),
    );
    expect(origin).toBe("/");
  });
});
