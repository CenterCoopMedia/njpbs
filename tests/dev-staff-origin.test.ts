import { afterEach, describe, expect, it, vi } from "vitest";
import devWorker from "../workers/src/staff-site-dev-worker";

const originEnv = {
  DEV_ACCESS_AUDIENCE: "fixture-audience",
  DEV_PUBLIC: { fetch: (request: Request) => fetch(request) },
  DEV_STAFF_ACCESS: {
    getSiteEnvironment: async () => "development",
    validateAccess: async (token: string) => token === "dev-session" ? 204 : 401,
  },
} as Parameters<typeof devWorker.fetch>[1];
const authenticated = (path: string, method = "GET") => new Request(`https://dev-public.example.org${path}`, {
  method, headers: {
    cookie: "__Host-njpbs-staff=dev-session; CF_Authorization=user-access",
    authorization: "Bearer user-bearer", "cf-access-client-id": "attacker-id",
    "cf-access-client-secret": "attacker-secret", "cf-access-jwt-assertion": "invalid-jwt",
    range: "bytes=0-99", origin: "https://dev-admin.example.org",
  },
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("isolated dev public Worker origin", () => {
  it.each(["GET", "HEAD"])("uses the private service binding for %s staff reads", async method => {
    const network = vi.fn(async (_sent: Request) => new Response(null, { status: 404 }));
    const internet = vi.fn(() => { throw new Error("No public origin permitted"); });
    vi.stubGlobal("fetch", internet);
    vi.spyOn(originEnv.DEV_PUBLIC, "fetch").mockImplementation(network);

    const result = await devWorker.fetch(authenticated("/posts/withdrawn-post/", method), originEnv);
    expect(internet).not.toHaveBeenCalled();

    expect(network).toHaveBeenCalledOnce();
    const sent = network.mock.calls[0][0];
    expect(sent.url).toBe("https://dev-public.example.org/posts/withdrawn-post/");
    expect(sent.method).toBe(method);
    expect(result.status).toBe(404);
  });

  it.each(["/", "/_publication.json", "/brand/njpbs-horizontal-white.svg"])("streams %s without origin credentials", async path => {
    vi.stubGlobal("fetch", async (sent: Request) => {
      expect(sent.url).toBe(`https://dev-public.example.org${path}`);
      expect(sent.redirect).toBe("manual");
      expect([...sent.headers]).toEqual([
        ["range", "bytes=0-99"],
      ]);
      return new Response(new Uint8Array([0, 1, 2, 255]), {
        headers: { "set-cookie": "CF_Authorization=origin-only", "content-type": "application/octet-stream", "cache-control": "public" },
      });
    });
    const result = await devWorker.fetch(authenticated(path), originEnv);
    expect(result.status).toBe(200);
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 1, 2, 255]);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
  });

  it("uses HEAD at the origin and returns no body", async () => {
    vi.stubGlobal("fetch", async (sent: Request) => {
      expect(sent.method).toBe("HEAD");
      return new Response(null, { headers: { "content-type": "application/json" } });
    });
    const result = await devWorker.fetch(authenticated("/_publication.json", "HEAD"), originEnv);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("");
  });

  it("fails closed without the private service binding", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const config = { ...originEnv };
    delete (config as Partial<typeof config>).DEV_PUBLIC;
    const result = await devWorker.fetch(authenticated("/"), config);
    expect(result.status).toBe(503);
    expect(await result.text()).toBe("Site access unavailable");
    expect(network).not.toHaveBeenCalled();
  });

  it("does not contact the origin for a production-only or absent staff session", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    for (const cookie of ["", "__Host-njpbs-staff=production-session"]) {
      const result = await devWorker.fetch(new Request("https://dev-public.example.org/", { headers: { cookie } }), originEnv);
      expect(result.status).toBe(401);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308])("rewrites only same-site %s redirects without following them", async status => {
    const network = vi.fn(async () => new Response(null, { status, headers: { location: "https://dev-public.example.org/posts/item/", "set-cookie": "origin=value" } }));
    vi.stubGlobal("fetch", network);
    const result = await devWorker.fetch(authenticated("/posts/item"), originEnv);
    expect(result.status).toBe(status);
    expect(result.headers.get("location")).toBe("https://dev-public.example.org/posts/item/");
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(network).toHaveBeenCalledOnce();
  });

  it.each(["https://access.example.org/login?token=private", "https://dev-public.example.org.evil.test/", "http://template-dev.pages.dev/", "https://user:pass@dev-public.example.org/"])("refuses an origin challenge or foreign redirect: %s", async location => {
    const network = vi.fn(async () => new Response("private challenge", { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", network);
    const result = await devWorker.fetch(authenticated("/"), originEnv);
    expect(result.status).toBe(503);
    expect(result.headers.get("location")).toBeNull();
    expect(await result.text()).toBe("Site access unavailable");
    expect(network).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("does not relay an origin %s challenge body", async status => {
    vi.stubGlobal("fetch", async () => new Response("private challenge", { status }));
    const result = await devWorker.fetch(authenticated("/"), originEnv);
    expect(result.status).toBe(503);
    expect(await result.text()).toBe("Site access unavailable");
  });

  it("consumes the resumed Access callback after admission without forwarding its query", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const result = await devWorker.fetch(authenticated("/cdn-cgi/access/authorized?token=private"), originEnv);
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("https://dev-public.example.org/");
    expect(network).not.toHaveBeenCalled();
  });
});
