import { afterEach, describe, expect, it } from "vitest";
import { db } from "../../functions/lib/firebase.js";
import lifecycle from "../../functions/lifecycle-transition.js";

const path = "cmsPosts/lead-media-review-fixture";
afterEach(async () => { await db.doc(path).delete(); });
const lead = { kind: "linked-video", data: { title: "Coastal voices", url: "https://watch.njpbs.org/video/coastal-voices/" } };
function response() {
  return { statusCode: null, body: null, headersSent: false,
    set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.headersSent = true; return this; } };
}

describe("Post lead media review lifecycle", () => {
  it.each(["submit", "approve"])("uses the new lead media for a Multimedia %s decision", async action => {
    const current = { type: "post", title: "Coastal voices", section: "watch", version: 1,
      status: action === "submit" ? "draft" : "in_review", createdBy: "lead-author", tags: ["format:multimedia"], blocks: [], leadMedia: lead };
    await db.doc(path).set(current);
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: "lead-editor", principal: { id: "lead-editor", grants: [{ role: "editor" }] } }),
      now: () => "2026-10-15T12:00:00.000Z" });
    const body = { collection: "cmsPosts", id: "lead-media-review-fixture", baseVersion: 1, action };
    const res = response();
    await handler({ method: "POST", body, headers: { "content-type": "application/json" }, rawBody: Buffer.from(JSON.stringify(body)) }, res);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(res.body.document.status).toBe(action === "submit" ? "in_review" : "approved");
  });
  it.each(["submit", "approve"])("does not revive a cleared lead from legacy heroImage during %s", async action => {
    await db.doc(path).set({ type: "post", title: "Coastal voices", section: "watch", version: 1,
      status: action === "submit" ? "draft" : "in_review", createdBy: "lead-author", tags: ["format:multimedia"], blocks: [],
      leadMedia: null, heroImage: "old-photo", heroImageAlt: "Old photo" });
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: "lead-editor", principal: { id: "lead-editor", grants: [{ role: "editor" }] } }) });
    const body = { collection: "cmsPosts", id: "lead-media-review-fixture", baseVersion: 1, action };
    const res = response();
    await handler({ method: "POST", body, headers: { "content-type": "application/json" }, rawBody: Buffer.from(JSON.stringify(body)) }, res);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("Multimedia Feature");
  });

});
