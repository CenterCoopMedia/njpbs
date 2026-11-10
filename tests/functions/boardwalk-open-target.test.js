import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import targets from "../../functions/lib/boardwalk-open-target.js";
import getContent from "../../functions/get-content.js";

const { normalizePublicPath, resolveEditorTarget, UNAVAILABLE_MESSAGE } = targets;
const project = "demo-njpbs-boardwalk-open";
let app, firestore;
const editor = { id: "editor", grants: [{ role: "editor" }] };
const newsEditor = { id: "news-editor", grants: [{ role: "editor", sections: ["news"] }] };
const writer = { id: "writer", grants: [{ role: "contributor" }] };
const id = "a".repeat(32);
const pageId = `page-${"b".repeat(32)}`;
const post = {
  type: "post", section: "news", createdBy: "author", status: "draft", slug: "future-draft-name",
  publiclyVisible: true, published: { metadata: { slug: "public-post", previousSlugs: ["old-post"] } },
};

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Local Firestore emulator required");
  app = initializeApp({ projectId: project }, project);
  firestore = getFirestore(app);
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  await Promise.all([
    firestore.collection("cmsPosts").doc(id).set(post),
    firestore.collection("cmsPages").doc(pageId).set({ status: "draft", section: "station", published: { metadata: { slug: "station-page", previousSlugs: ["previous-page"] } } }),
    firestore.collection("cmsPages").doc("home").set({ status: "draft", homeCompositionVersion: 2, blocks: [] }),
  ]);
});
afterAll(async () => { if (app) await deleteApp(app); });
const resolve = (input, principal = editor) => resolveEditorTarget({ firestore, principal, input });

it.each(["/", "/contact", "/posts/public-post/", "/programs/program/"])("normalizes the local public path %s", path => {
  expect(normalizePublicPath(path)).toBe(path === "/" || path.endsWith("/") ? path : `${path}/`);
});
it.each(["https://outside.example/", "//outside.example/", "/posts/../contact", "/posts/%2F", "/contact?token=value", "/contact#section", "/contact//", ""])("refuses ambiguous or external path %s", path => {
  expect(normalizePublicPath(path)).toBeNull();
});
it("refuses a maximum-length malformed segment and retains a valid segment", async () => {
  const segment = "a".repeat(254);
  expect(normalizePublicPath(`/${segment}!`)).toBeNull();
  expect(normalizePublicPath(`/${segment}`)).toBe(`/${segment}/`);
  await expect(resolve({ path: `/${segment}!` })).rejects.toMatchObject({ status: 403, message: UNAVAILABLE_MESSAGE });
});

describe("public paths to authorized editor identities (#3145)", () => {
  it("opens published Post and retired slug despite an unpublished draft rename", async () => {
    for (const path of ["/posts/public-post", "/posts/old-post/"]) expect(await resolve({ path }, newsEditor)).toEqual({ type: "post", id });
    await expect(resolve({ path: "/posts/future-draft-name/" })).rejects.toThrow(UNAVAILABLE_MESSAGE);
  });
  it("opens custom Page, alias, code-owned Page and Home v2 at their real ids", async () => {
    expect(await resolve({ path: "/station-page/" })).toEqual({ type: "page", id: pageId });
    expect(await resolve({ path: "/previous-page/" })).toEqual({ type: "page", id: pageId });
    expect(await resolve({ path: "/donate/" })).toEqual({ type: "page", id: "give" });
    expect(await resolve({ path: "/contact/" })).toEqual({ type: "page", id: "contact" });
    expect(await resolve({ path: "/" })).toEqual({ type: "home", id: "home" });
  });
  it.each([["program", "/programs/"], ["event", "/events/"]])("resolves the %s CMS surface", async (type, base) => {
    await firestore.collection("cmsPosts").doc(id).update({ type });
    expect(await resolve({ path: `${base}public-post/` })).toEqual({ type, id });
    await expect(resolve({ path: "/posts/public-post/" })).rejects.toThrow(UNAVAILABLE_MESSAGE);
  });
  it("resolves exact ids without guessing and returns only identity", async () => {
    expect(await resolve({ type: "post", id })).toEqual({ type: "post", id });
    await expect(resolve({ type: "event", id })).rejects.toThrow(UNAVAILABLE_MESSAGE);
    await expect(resolve({ type: "home", id: "contact" })).rejects.toThrow(UNAVAILABLE_MESSAGE);
    await expect(resolve({ type: "page", id: "home" })).rejects.toThrow(UNAVAILABLE_MESSAGE);
    await expect(resolve({ type: "page", id: `page-${"c".repeat(32)}` })).rejects.toThrow(UNAVAILABLE_MESSAGE);
  });
  it("opens a built-in public fallback before its first CMS publication", async () => {
    await firestore.collection("cmsPages").doc("contact").set({ status: "draft", section: "station", publiclyVisible: false });
    expect(await resolve({ path: "/contact/" })).toEqual({ type: "page", id: "contact" });
  });
  it("refuses foreign desks, unknown records, deleted content, unsupported surfaces and duplicate paths with the same message", async () => {
    for (const input of [{ type: "page", id: "home" }, { path: "/" }, { path: "/station-page/" }, { path: "/unknown/" }, { path: "/search/" }, { type: "users", id: "editor" }]) {
      await expect(resolve(input, newsEditor)).rejects.toThrow(UNAVAILABLE_MESSAGE);
    }
    await expect(resolve({ type: "post", id }, writer)).rejects.toThrow(UNAVAILABLE_MESSAGE);
    await firestore.collection("cmsPosts").doc(id).update({ deleted: true });
    await expect(resolve({ type: "post", id })).rejects.toThrow(UNAVAILABLE_MESSAGE);
    await firestore.collection("cmsPosts").doc("duplicate").set(post);
    await expect(resolve({ path: "/posts/public-post/" })).rejects.toThrow(UNAVAILABLE_MESSAGE);
  });
  it("keeps Home closed to a Writer even with ownership and station creation access", async () => {
    await firestore.collection("cmsPages").doc("home").update({ createdBy: "writer" });
    await expect(resolve({ type: "home", id: "home" }, writer)).rejects.toThrow(UNAVAILABLE_MESSAGE);
  });
  it("runs the deep-link action behind the existing authentication boundary", async () => {
    const handler = getContent.createCmsGetContentHandler({ firestore,
      requirePrincipalFn: async req => {
        if (req.headers.authorization !== "test-editor") throw Object.assign(new Error("Authentication required"), { status: 401 });
        return { uid: "editor", principal: editor };
      }, log: { error() {}, warn() {} },
    });
    async function call(headers) {
      let code, body;
      const res = { status(value) { code = value; return this; }, json(value) { body = value; this.headersSent = true; } };
      await handler({ method: "POST", body: { action: "resolveEditor", path: "/posts/public-post/" }, headers }, res);
      return { code, body };
    }
    expect(await call({ cookie: "bw_staff=1" })).toEqual({ code: 401, body: { error: "Authentication required" } });
    expect(await call({ authorization: "test-editor" })).toEqual({ code: 200, body: { success: true, target: { type: "post", id } } });
  });
  it("records bounded refusal diagnostics without submitted paths or IDs", async () => {
    const warnings = [];
    const handler = getContent.createCmsGetContentHandler({ firestore,
      requirePrincipalFn: async () => ({ uid: "news-editor", principal: newsEditor }),
      log: { error() {}, warn(message, fields) { warnings.push({ message, fields }); } },
    });
    const inputs = [
      [{ path: "/contact?private-input=value" }, "path", "invalid-path"],
      [{ type: "post", id: "private-input/invalid" }, "identity", "invalid-target"],
      [{ path: "/station-page/" }, "path", "read-forbidden"],
    ];
    for (const [input] of inputs) {
      let code, body;
      const res = { status(value) { code = value; return this; }, json(value) { body = value; } };
      await handler({ method: "POST", body: { action: "resolveEditor", ...input } }, res);
      expect({ code, body }).toEqual({ code: 403, body: { error: UNAVAILABLE_MESSAGE } });
    }
    expect(warnings).toEqual(inputs.map(([, targetMode, reason]) => ({
      message: "cmsGetContent refused an editor target",
      fields: { uid: "news-editor", targetMode, reason },
    })));
    expect(JSON.stringify(warnings)).not.toContain("private-input");
  });
});
