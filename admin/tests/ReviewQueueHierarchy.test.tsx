import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ReviewQueueList } from "../src/components/ReviewQueueList";
import type { ReviewQueueItem } from "../src/lib/review-queue";

// A reviewer scans the editorial queue by content: the title answers "is this mine to read next",
// and everything else on the row is context for that answer. The table shipped the opposite
// weighting — the title column was the narrowest and wore the muted secondary type, while the
// submitter's name was bold ink in a generous column — so real titles wrapped to three lines while
// two people columns sat half empty. The stacked narrow card had the matching defect: every
// label/value pair read from the left edge except the status pill, which floated in the middle
// (#1036).

const REQUESTS: ReviewQueueItem[] = [
  {
    requestId: `review_${"a".repeat(64)}`,
    recordId: "post-station-update",
    title: "Station update: what changes on July 1",
    state: "in_review",
    collection: "cmsPosts",
    contentType: "post",
    sourceVersion: 4,
    requestedByLabel: "Blake Sutton",
    requestedAt: "2026-08-18T15:12:00.000Z",
    assigneeLabel: "Jordan Avery",
    recovered: false,
  },
];

function renderQueue(requests = REQUESTS) {
  render(
    <MemoryRouter initialEntries={["/publish-queue"]}>
      <ReviewQueueList requests={requests} />
    </MemoryRouter>,
  );
  return within(screen.getByTestId("review-queue-item"));
}

describe("editorial queue hierarchy", () => {
  it("does not invent an open-draft action for a retired request with no editor route", () => {
    const row = renderQueue([{ ...REQUESTS[0], collection: "cmsPosts", contentType: "article" }]);
    expect(row.getByText(REQUESTS[0].title)).toBeVisible();
    expect(row.queryByRole("link")).not.toBeInTheDocument();
  });

});
