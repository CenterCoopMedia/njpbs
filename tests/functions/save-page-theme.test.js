import { describe, expect, it, vi } from "vitest";
import save from "../../functions/save.js";

describe("runtime Page theme save boundary", () => {
  it.each(["default", "nj-decides"])("rejects Contact theme %s before a database read or write", async pageTheme => {
    const firestore = { collection: vi.fn(), runTransaction: vi.fn(), doc: vi.fn() };
    const handler = save.createCmsSaveHandler({ firestore,
      requirePrincipalFn: async () => ({ uid: "local-editor", principal: { id: "local-editor", grants: [{ role: "admin" }] } }),
      routePurge: { config: {} }, log: { warn() {}, error() {} },
    });
    const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: "POST", headers: {}, body: { collection: "cmsPages", id: "contact",
      document: { pageTheme }, baseVersion: 1 } }, response);
    expect(response.code).toBe(400);
    expect(response.body.error).toBe("Contact keeps its standard header. Page theme changes are not available there.");
    expect(firestore.collection).not.toHaveBeenCalled();
    expect(firestore.doc).not.toHaveBeenCalled();
    expect(firestore.runTransaction).not.toHaveBeenCalled();
  });
});
