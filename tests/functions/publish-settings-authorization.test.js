import { describe, expect, it, vi } from "vitest";
import publish from "../../functions/publish.js";

const { authorizePublishRequest, createCmsPublishHandler } = publish;

const BANNER_CHANGE = {
  collection: "cmsSettings",
  id: "public-homepage-banner",
  sourceVersion: 3,
};

function principal(role, sections) {
  return {
    id: `${role}-one`,
    grants: [{ role, ...(sections ? { sections } : {}) }],
  };
}

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  return res;
}

describe("CMS settings publish authorization", () => {
  it("allows a settings manager to publish the admitted banner without content reads", async () => {
    const firestore = { collection: vi.fn() };

    await expect(
      authorizePublishRequest(principal("admin"), [BANNER_CHANGE], firestore),
    ).resolves.toEqual({ allowed: true, reason: null });
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("refuses a contributor before cmsPublish invokes a transport", async () => {
    const firestore = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({
            exists: true,
            data: () => ({ createdBy: "contributor-one", section: "watch" }),
          })),
        })),
      })),
    };
    const change = { collection: "cmsPosts", id: "post-1", sourceVersion: 2 };
    const tryRuntimePublicationFn = vi.fn();
    const enqueuePublishBuildFn = vi.fn();
    const actor = principal("contributor");
    const handler = createCmsPublishHandler({
      firestore,
      requirePrincipalFn: async () => ({ uid: actor.id, principal: actor }),
      tryRuntimePublicationFn,
      enqueuePublishBuildFn,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const res = makeRes();

    await handler(
      { method: "POST", body: { changes: [change], runtimeFirst: true } },
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Publish access required" });
    expect(tryRuntimePublicationFn).not.toHaveBeenCalled();
    expect(enqueuePublishBuildFn).not.toHaveBeenCalled();
  });

  it("refuses a contributor a document owned by someone else", async () => {
    const firestore = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({
            exists: true,
            data: () => ({ createdBy: "another-person", section: "watch" }),
          })),
        })),
      })),
    };
    const change = { collection: "cmsPosts", id: "post-1", sourceVersion: 2 };

    const decision = await authorizePublishRequest(
      principal("contributor"),
      [change],
      firestore,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/publish scope/);
  });

  it("applies an editor's publish grant to the stored content section", async () => {
    const firestore = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({
            exists: true,
            data: () => ({
              createdBy: "another-person",
              section: "watch",
              status: "published",
              publishBuildPending: true,
              published: { sourceVersion: 2 },
            }),
          })),
        })),
      })),
    };
    const change = { collection: "cmsPosts", id: "post-1", sourceVersion: 2 };

    await expect(
      authorizePublishRequest(principal("editor", ["watch"]), [change], firestore),
    ).resolves.toEqual({
      allowed: true,
      reason: null,
      requireExactPendingChanges: true,
    });
    await expect(
      authorizePublishRequest(principal("editor", ["news"]), [change], firestore),
    ).resolves.toEqual({
      allowed: false,
      reason: "cmsPosts/post-1 is outside this grant's publish scope",
    });
  });

  it("allows a scoped retry of an already confirmed runtime revision", async () => {
    const firestore = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({
          get: vi.fn(async () => ({
            exists: true,
            data: () => ({
              createdBy: "another-person",
              section: "watch",
              status: "published",
              publishBuildPending: false,
              published: { sourceVersion: 2 },
            }),
          })),
        })),
      })),
    };
    const change = { collection: "cmsPosts", id: "post-1", sourceVersion: 2 };

    await expect(
      authorizePublishRequest(principal("editor", ["watch"]), [change], firestore),
    ).resolves.toEqual({
      allowed: true,
      reason: null,
      requireExactPendingChanges: true,
    });
  });

  it("allows a settings manager to publish the site navigation with or without the banner", async () => {
    const firestore = { collection: vi.fn() };
    const navigation = { collection: "cmsSettings", id: "site-navigation", sourceVersion: 5 };

    await expect(
      authorizePublishRequest(principal("admin"), [navigation], firestore),
    ).resolves.toEqual({ allowed: true, reason: null });
    await expect(
      authorizePublishRequest(principal("admin"), [BANNER_CHANGE, navigation], firestore),
    ).resolves.toEqual({ allowed: true, reason: null });
    await expect(
      authorizePublishRequest(principal("editor"), [navigation], firestore),
    ).resolves.toEqual({
      allowed: false,
      reason: "settings.manage is required to publish settings",
    });
    await expect(
      authorizePublishRequest(
        principal("admin"),
        [{ ...navigation, operation: "withdraw" }],
        firestore,
      ),
    ).resolves.toMatchObject({ allowed: false });
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("requires settings.manage even from a site-wide content publisher", async () => {
    const firestore = { collection: vi.fn() };

    await expect(
      authorizePublishRequest(principal("editor"), [BANNER_CHANGE], firestore),
    ).resolves.toEqual({
      allowed: false,
      reason: "settings.manage is required to publish settings",
    });
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("rejects an unadmitted settings document even from an administrator", async () => {
    const firestore = { collection: vi.fn() };

    const decision = await authorizePublishRequest(
      principal("admin"),
      [{ ...BANNER_CHANGE, id: "newsroom-home" }],
      firestore,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/public site setting/i);
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("requires global settings authority before it reads a mixed build", async () => {
    const firestore = { collection: vi.fn() };
    const settingsOnly = {
      id: "settings-only",
      grants: [{ role: "admin", sections: ["watch"] }],
    };

    const decision = await authorizePublishRequest(
      settingsOnly,
      [
        BANNER_CHANGE,
        { collection: "cmsPages", id: "home", sourceVersion: 7 },
      ],
      firestore,
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "settings.manage is required to publish settings",
    });
    expect(firestore.collection).not.toHaveBeenCalled();
  });
});
