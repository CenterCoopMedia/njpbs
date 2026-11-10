import {
  contentStatusTone,
  displayLiveVersion,
  listRowNeedsPublicationWatch,
  livePublishedSourceVersion,
} from "../src/lib/content-status";

describe("public snapshot status", () => {
  it("shows a reserved publish queue row as pending work", () => {
    expect(contentStatusTone("reserved")).toBe("pending");
  });

  it("does not call an unconfirmed build live", () => {
    const record = {
      status: "published",
      publiclyVisible: true,
      publishBuildPending: true,
      published: { sourceVersion: 12 },
    };

    expect(livePublishedSourceVersion(record)).toBeNull();
    expect(displayLiveVersion(null, true)).toBe("Not live");
  });

  it("keeps confirmed and legacy live snapshots compatible", () => {
    expect(
      livePublishedSourceVersion({
        status: "published",
        publiclyVisible: true,
        publishBuildPending: false,
        published: { sourceVersion: 12 },
      }),
    ).toBe(12);
    expect(
      livePublishedSourceVersion({
        status: "published",
        published: { sourceVersion: 8 },
      }),
    ).toBe(8);
  });

  it("keeps the confirmed live version visible while a newer version publishes", () => {
    expect(
      livePublishedSourceVersion({
        status: "published",
        publiclyVisible: true,
        publicSourceVersion: 35,
        publishBuildPending: true,
        published: { sourceVersion: 44 },
      }),
    ).toBe(35);
  });

  it("watches compact list rows only when the list payload shows live publish work", () => {
    expect(listRowNeedsPublicationWatch({})).toBe(false);
    expect(listRowNeedsPublicationWatch({ publicUpdatePending: false })).toBe(false);
    expect(listRowNeedsPublicationWatch({ publicUpdatePending: true })).toBe(true);
    expect(listRowNeedsPublicationWatch({ queueStatus: "pending" })).toBe(true);
    expect(listRowNeedsPublicationWatch({ queueStatus: "success" })).toBe(false);
    expect(listRowNeedsPublicationWatch({
      publishedSourceVersion: 11,
      liveSourceVersion: 10,
    })).toBe(true);
    expect(listRowNeedsPublicationWatch({
      publishedSourceVersion: 10,
      liveSourceVersion: 10,
    })).toBe(false);
  });

  it("does not report a retained confirmation after content is removed", () => {
    expect(
      livePublishedSourceVersion({
        status: "draft",
        publiclyVisible: false,
        publicSourceVersion: 35,
        published: { sourceVersion: 44 },
      }),
    ).toBeNull();
  });
});
