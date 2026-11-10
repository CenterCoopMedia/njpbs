import { expect, it } from "vitest";
import withdrawal from "../../functions/lib/public-video-withdrawal.js";

it.each(["persist", "claim"])(
  "identifies a failed Firestore %s without logging the original error",
  async (stage) => {
    const assetId = "withdrawal-error-video";
    const logs = [];
    const handler = withdrawal.createPublicVideoWithdrawalHandler({
      firestore: {
        collection: (collection) => ({ doc: (id) => ({ collection, id }) }),
        async runTransaction(run) {
          return run({
            async get(ref) {
              if (
                stage === "claim" &&
                ref.collection === "cmsPublicVideoWithdrawals"
              )
                return { data: () => undefined };
              throw Object.assign(
                new Error("Request included private credential"),
                {
                  code: 4,
                  headers: { authorization: "private credential" },
                },
              );
            },
            set() {},
          });
        },
      },
      r2Fn: () => ({}),
      purgeConfigFn: () => ({ zoneId: "a".repeat(32), token: "fixture" }),
      log: { error: (message, details) => logs.push({ message, details }) },
    });
    const event = {
      data: {
        before: {
          data: () => ({
            status: "published",
            published: {
              blocks: [
                {
                  id: "video",
                  type: "video",
                  visible: true,
                  order: 0,
                  data: {
                    sourceId: "video-library",
                    assetId,
                    public: {
                      url: `https://media.njpbs.org/cms-media/video/${assetId}/${"a".repeat(64)}.mp4`,
                      posterUrl: `https://media.njpbs.org/cms-media/video/${assetId}/${"b".repeat(64)}.jpg`,
                      width: 1920,
                      height: 1080,
                      mimeType: "video/mp4",
                    },
                  },
                },
              ],
            },
          }),
        },
        after: { data: () => ({ status: "draft", publiclyVisible: false }) },
      },
    };

    await expect(handler(event)).rejects.toMatchObject({
      status: 503,
      message: "Public video withdrawal is pending. It will retry.",
    });
    expect(logs).toEqual([
      {
        message: "public video withdrawal pending",
        details: { assetId, stage, reason: "Withdrawal failure" },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("private credential");
  },
);
