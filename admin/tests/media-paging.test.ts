import { describe, expect, it } from "vitest";
import { cursorPagingRules, loadMorePagingRules, numberedPagingRules } from "../src/lib/media-paging";

describe("media paging rules", () => {
  it("keeps unknown totals honest and bounds malformed page counters", () => {
    expect(loadMorePagingRules({ loaded: 12, total: null, hasMore: false }).announcement).toBe("12 items loaded");
    expect(numberedPagingRules(0, 0)).toMatchObject({
      page: 1, announcement: "Page 1 of 1", previous: { disabled: true }, next: { disabled: true },
    });
    expect(cursorPagingRules(-2, true)).toMatchObject({
      announcement: "Page 1 · reload returns to page 1", previous: { disabled: true }, next: { disabled: true },
    });
  });
});
