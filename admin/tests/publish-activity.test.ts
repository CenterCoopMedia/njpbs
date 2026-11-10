import { describe, expect, it } from "vitest";
import { summarizePublishActivity } from "../src/lib/publish-activity";

describe("publish activity summary", () => {
  it("separates active requests from failed recovery work", () => {
    expect(
      summarizePublishActivity([
        { status: "reserved" },
        { status: "pending" },
        { status: "publishing" },
        { status: "failed" },
        { status: "failed" },
        { status: "public_unconfirmed" },
        { status: "success" },
        { status: "unknown" },
      ]),
    ).toEqual({ activeCount: 3, recoveryCount: 3 });
  });
});
