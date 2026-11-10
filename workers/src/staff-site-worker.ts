import { jwtVerify } from "jose";
import { previewObjectRequest } from "./preview-artifact-request";
import { accessTeamKeys } from "./access-team-keys";

const ADMIN = "https://admin.njpbs.org";
const DEV_ADMIN = "https://dev-admin.example.org";

const COOKIE = "__Host-njpbs-staff";
const SESSION_PATH = "/__cms-session";
const HOSTS = new Set(["dev-public.example.org", "preview.njpbs.org"]);
const TOKEN = /^[A-Za-z0-9._-]{1,3500}$/;

interface Dependencies {
  validateAccess(token: string): Promise<number>;
  validatePreviewAccess?(token: string, target: { schemaVersion: 1; queueId: string; persistent: boolean }): Promise<number>;
  serve(request: Request): Promise<Response>;
  dev?: { audience: string; accessOrigin?: string; origin?: "https://dev-public.example.org" | "https://dev-preview.example.org" };
}

function response(body: BodyInit | null, status: number, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("cache-control", "private, no-store");
  if (status === 429) headers.set("retry-after", "1");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("x-content-type-options", "nosniff");
  return new Response(body, { status, headers });
}

function sessionCookie(request: Request): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE.length + 1);
  return TOKEN.test(token) ? token : null;
}

async function sessionRequest(request: Request, dependencies: Dependencies, admin: string): Promise<Response> {
  if (request.headers.get("origin") !== admin) return response("Forbidden", 403);
  const cors = {
    "access-control-allow-origin": admin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "POST, DELETE",
    "access-control-allow-headers": "Authorization",
    vary: "Origin",
  };
  if (request.method === "OPTIONS") return response(null, 204, cors);
  if (request.method === "DELETE") {
    return response(null, 204, { ...cors,
      "set-cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
    });
  }
  if (request.method !== "POST") return response("Method not allowed", 405, cors);
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!TOKEN.test(token)) return response("Unauthorized", 401, cors);
  const status = await dependencies.validateAccess(token);
  if (status !== 204) return response("Site access unavailable", status, cors);
  return response(null, 204, { ...cors,
    "set-cookie": `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`,
  });
}

export async function serveStaffSite(request: Request, dependencies: Dependencies): Promise<Response> {
  const url = new URL(request.url);
  const dev = url.origin === (dependencies.dev?.origin ?? "https://dev-public.example.org") ? dependencies.dev : undefined;
  if (url.protocol !== "https:" || (!HOSTS.has(url.host) && !(dev && url.host === "dev-preview.example.org"))) {
    return response("Not found", 404);
  }
  const admin = dev ? DEV_ADMIN : ADMIN;
  try {
    if (url.pathname === SESSION_PATH) return await sessionRequest(request, dependencies, admin);
    if (request.method !== "GET" && request.method !== "HEAD") return response("Method not allowed", 405);
    const preview = url.hostname === "preview.njpbs.org" || url.hostname === "dev-preview.example.org";
    const target = preview ? previewObjectRequest(url.pathname) : null;
    if (preview && !target) return response(request.method === "HEAD" ? null : "Preview not found", 404);
    const token = sessionCookie(request);
    const assertion = dev ? request.headers.get("cf-access-jwt-assertion") : null;
    const accessStarted = Date.now();
    // Access user JWTs do not replace the staff session. Only a service identity can.
    // Publisher service admission is confined to the dev public site. Private
    // saved previews always need a fresh staff session, including for machines.
    const machine = url.hostname === "dev-public.example.org" && assertion && await verifyMachineAccess(assertion, dev!.audience, dev!.accessOrigin);
    const admissionStarted = Date.now();
    const status = machine ? 204 : !token ? 401 : preview
      ? await dependencies.validatePreviewAccess!(token, {
        schemaVersion: 1, queueId: target!.queueId, persistent: target!.persistent,
      })
      : await dependencies.validateAccess(token);
    const admittedAt = Date.now();
    if (status === 401) {
      if (request.headers.get("sec-fetch-dest") !== "document") {
        return response(request.method === "HEAD" ? null : "Unauthorized", 401, dev ? receiptCors(request) : {});
      }
      const login = new URL(admin);
      login.searchParams.set("staffSite", url.href);
      return response(null, 302, { location: login.href });
    }
    if (preview && status === 404) return response(request.method === "HEAD" ? null : "Preview not found", 404);
    if (status !== 204) return response(request.method === "HEAD" ? null : "Site access unavailable", status, dev ? receiptCors(request) : {});
    // Never send the CMS bearer token, cookies, or user-controlled credentials
    // to the static origin. Content cannot set a replacement session cookie.
    const originHeaders = new Headers();
    for (const name of ["accept", "range", "if-range", "if-none-match", "if-modified-since"]) {
      const value = request.headers.get(name);
      if (value) originHeaders.set(name, value);
    }
    const upstream = await dependencies.serve(new Request(url, {
      method: request.method,
      headers: originHeaders,
      redirect: "manual",
    }));
    if (preview && upstream.status === 404) {
      await upstream.body?.cancel();
      return response(request.method === "HEAD" ? null : "Preview not found", 404);
    }
    const headers = new Headers(upstream.headers);
    headers.delete("set-cookie");
    if (dev) {
      headers.append("server-timing", [
        `staff-access;dur=${admissionStarted - accessStarted}`,
        `staff-admission;dur=${admittedAt - admissionStarted}`,
        `staff-origin;dur=${Date.now() - admittedAt}`,
      ].join(", "));
      headers.delete("access-control-allow-origin");
      headers.delete("access-control-allow-credentials");
      for (const [name, value] of Object.entries(receiptCors(request))) headers.set(name, value);
    }
    return response(request.method === "HEAD" ? null : upstream.body, upstream.status, headers);
  } catch {
    return response(request.method === "HEAD" ? null : "Site access unavailable", 503, dev ? receiptCors(request) : {});
  }
}

function receiptCors(request: Request): Record<string, string> {
  return request.headers.get("origin") === DEV_ADMIN ? {
    "access-control-allow-origin": DEV_ADMIN,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  } : { vary: "Origin" };
}

async function verifyMachineAccess(token: string, audience: string, accessOrigin?: string): Promise<boolean> {
  if (!audience || token.length > 8192) return false;
  try {
    const { issuer, keys } = accessTeamKeys(accessOrigin, 5_000);
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"], issuer, audience,
      requiredClaims: ["exp", "iat", "sub", "common_name"],
    });
    return payload.type === "app" && payload.sub === "" &&
      !Object.hasOwn(payload, "email") &&
      typeof payload.common_name === "string" && /^[a-zA-Z0-9]+\.access$/.test(payload.common_name) &&
      typeof payload.iat === "number" && payload.iat <= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

type StaffSiteRuntimeEnv = Omit<StaffSiteEnv, "DEV_STAFF_SITE_MODE" | "DEV_ACCESS_AUDIENCE"> & {
  DEV_STAFF_SITE_MODE?: string;
  DEV_ACCESS_AUDIENCE?: string;
  CMS_DEV_ACCESS_ORIGIN?: string;
};

export type DevStaffSiteEnv = Pick<StaffSiteRuntimeEnv, "DEV_STAFF_ACCESS" | "DEV_ACCESS_AUDIENCE" | "CMS_DEV_ACCESS_ORIGIN">;

export async function serveDevStaffSite(
  request: Request, env: DevStaffSiteEnv,
  serve: Dependencies["serve"] = (cleanRequest) => fetch(cleanRequest),
  origin: "https://dev-public.example.org" | "https://dev-preview.example.org" = "https://dev-public.example.org",
): Promise<Response> {
  if (!["https://dev-public.example.org", "https://dev-preview.example.org"].includes(origin) ||
      new URL(request.url).origin !== origin) return response("Not found", 404);
  try {
    if (!env.DEV_ACCESS_AUDIENCE?.trim() ||
      await env.DEV_STAFF_ACCESS.getSiteEnvironment() !== "development") {
      return response("Site configuration unavailable", 503, receiptCors(request));
    }
  } catch {
    return response("Site configuration unavailable", 503, receiptCors(request));
  }
  return serveStaffSite(request, {
    dev: { audience: env.DEV_ACCESS_AUDIENCE, accessOrigin: env.CMS_DEV_ACCESS_ORIGIN, origin },
    // The Function reuses token verification only; roles and rate limits stay fresh.
    validateAccess: (token) => env.DEV_STAFF_ACCESS.validateAccess(
      token, request.headers.get("cf-connecting-ip")?.trim() || "missing",
    ),
    validatePreviewAccess: (token, target) => env.DEV_STAFF_ACCESS.validatePreviewAccess(
      token, request.headers.get("cf-connecting-ip")?.trim() || "missing", target,
    ),
    serve,
  });
}

export default {
  async fetch(request: Request, env: StaffSiteRuntimeEnv): Promise<Response> {
    const devHost = new URL(request.url).hostname === "dev-public.example.org";
    const mode = env.DEV_STAFF_SITE_MODE ?? "production";
    if (devHost && mode !== "production" && mode !== "development") return response("Site configuration unavailable", 503);
    if (devHost && mode === "development") return serveDevStaffSite(request, env);
    return serveStaffSite(request, {
      validateAccess: (token) => env.STAFF_ACCESS.validateAccess(
        token, request.headers.get("cf-connecting-ip")?.trim() || "missing",
      ),
      validatePreviewAccess: (token, target) => env.STAFF_ACCESS.validatePreviewAccess(
        token, request.headers.get("cf-connecting-ip")?.trim() || "missing", target,
      ),
      serve: (cleanRequest) => new URL(cleanRequest.url).hostname === "preview.njpbs.org"
        ? env.PREVIEW.fetch(cleanRequest)
        : fetch(cleanRequest),
    });
  },
} satisfies ExportedHandler<StaffSiteEnv>;
