import { describe, expect, it, vi } from "vitest";
import { bylineFailureReason, readBylineDirectory } from "../src/byline-directory";

describe("byline failure diagnostics", () => {
  it("maps known errors without logging arbitrary private text", () => {
    expect(bylineFailureReason(new Error("Account lookup failed"))).toBe("account_lookup_rejected");
    expect(bylineFailureReason(new Error("secret-token private staff response https://example.org/?key=private"))).toBe("unexpected");
    expect(bylineFailureReason({ message: "Account lookup failed", token: "private" })).toBe("unexpected");
  });
  it("identifies the failed transport stage without altering the exception", async () => {
    const stages: string[] = [];
    const failure = new Error("private transport detail");
    const fetcher = vi.fn().mockRejectedValue(failure);
    await expect(readBylineDirectory({ ...input(fetcher), onStage: stage => stages.push(stage) })).rejects.toBe(failure);
    expect(stages).toEqual(["account_lookup"]);
  });
});

const ROOT = "projects/njpbs-site/databases/(default)/documents";
const AUTHOR_A = `au_${"a".repeat(32)}`;
const AUTHOR_B = `au_${"b".repeat(32)}`;
const AUTHOR_C = `au_${"c".repeat(32)}`;
const EMPTY_READINESS = { hasPhoto: false, hasJobTitle: false, hasBio: false, published: false };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function row(id: string, eligible: boolean, name?: string) {
  return {
    document: {
      name: `${ROOT}/cmsBylineDirectory/${id}`,
      fields: {
        authorId: { stringValue: id },
        eligible: { booleanValue: eligible },
        ...(eligible ? {
          displayName: { stringValue: name },
          jobTitle: { nullValue: "NULL_VALUE" },
          profileReadiness: { mapValue: { fields: Object.fromEntries(
            Object.entries(EMPTY_READINESS).map(([key, value]) => [key, { booleanValue: value }]),
          ) } },
          uid: { stringValue: "must-not-leak" },
          email: { stringValue: "must-not-leak@example.org" },
        } : {}),
      },
    },
  };
}

function input(fetcher: typeof fetch, body: object = {}) {
  return {
    token: "signed-token",
    uid: "editor-1",
    authTime: 100,
    apiKey: "test-api-key-1234567890",
    projectId: "njpbs-site",
    body: new TextEncoder().encode(JSON.stringify(body)).buffer,
    fetcher,
  };
}

describe("Cloudflare byline directory", () => {
  it("does not pass its input object as the native fetch receiver", async () => {
    const receivers: unknown[] = [];
    const fetcher: typeof fetch = async function (this: unknown, url) {
      receivers.push(this);
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      const address = String(url);
      if (address.includes("accounts:lookup")) return json({ users: [{ localId: "editor-1" }] });
      if (address.includes("/users/editor-1")) return json({ fields: { active: { booleanValue: true } } });
      if (address.includes(":runQuery")) return json([row(AUTHOR_A, true, "Amy")]);
      return json({ fields: { authorId: { stringValue: AUTHOR_A } } });
    };
    const result = await readBylineDirectory(input(fetcher));
    expect(result.authors).toEqual([{ authorId: AUTHOR_A, displayName: "Amy", jobTitle: null,
      profileReadiness: EMPTY_READINESS }]);
    expect(receivers).toHaveLength(4);
    expect(receivers.every(receiver => receiver === undefined || receiver === globalThis)).toBe(true);
  });

  it("preserves raw-page cursors, filters tombstones, and returns only byline fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const address = String(url);
      if (address.includes("accounts:lookup")) {
        return json({ users: [{ localId: "editor-1", validSince: "90" }] });
      }
      if (address.includes("/users/editor-1")) return json({ fields: { active: { booleanValue: true } } });
      if (address.includes(":runQuery")) {
        return json([row(AUTHOR_A, true, "Zoe"), row(AUTHOR_B, false), row(AUTHOR_C, true, "Amy")]);
      }
      if (address.includes("/cmsBylineSelf/editor-1")) {
        return json({ fields: { authorId: { stringValue: AUTHOR_A } } });
      }
      throw new Error("Unexpected URL");
    });

    const result = await readBylineDirectory(input(fetcher, { limit: 3, startAfter: AUTHOR_A }));
    expect(result).toEqual({
      apiVersion: 1,
      success: true,
      authors: [
        { authorId: AUTHOR_C, displayName: "Amy", jobTitle: null, profileReadiness: EMPTY_READINESS },
        { authorId: AUTHOR_A, displayName: "Zoe", jobTitle: null, profileReadiness: EMPTY_READINESS },
      ],
      nextCursor: AUTHOR_C,
      selfAuthorId: AUTHOR_A,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    const query = fetcher.mock.calls.find(([url]) => String(url).includes(":runQuery"));
    const request = JSON.parse(String(query?.[1]?.body));
    expect(request.structuredQuery.limit).toBe(3);
    expect(request.structuredQuery.startAt).toEqual({
      values: [{ referenceValue: `${ROOT}/cmsBylineDirectory/${AUTHOR_A}` }],
      before: false,
    });
  });

  it("stops before any directory read when the Firebase token was revoked", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ users: [{ localId: "editor-1", validSince: "101" }] }),
    );
    await expect(readBylineDirectory(input(fetcher))).rejects.toThrow("Account is unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([undefined, { mapValue: { fields: { hasPhoto: { stringValue: "true" } } } }])(
    "refuses missing or malformed readiness so the caller can use Functions",
    async (readiness) => {
      const document = row(AUTHOR_A, true, "Amy");
      Object.assign(document.document.fields, { profileReadiness: readiness });
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const address = String(url);
        if (address.includes("accounts:lookup")) return json({ users: [{ localId: "editor-1" }] });
        if (address.includes("/users/editor-1")) return json({});
        if (address.includes(":runQuery")) return json([document]);
        return json({}, 404);
      });
      await expect(readBylineDirectory(input(fetcher))).rejects.toThrow("Invalid byline fields");
    },
  );

  it("stops before any directory read when the CMS account is inactive", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("accounts:lookup")
        ? json({ users: [{ localId: "editor-1", validSince: "90" }] })
        : json({ error: "denied" }, 403),
    );
    await expect(readBylineDirectory(input(fetcher))).rejects.toThrow("CMS account is unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an inactive account even if the account read returns 200", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("accounts:lookup")
        ? json({ users: [{ localId: "editor-1", validSince: "90" }] })
        : json({ fields: { active: { booleanValue: false } } }),
    );
    await expect(readBylineDirectory(input(fetcher))).rejects.toThrow("CMS account is inactive");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed projection rows instead of returning incomplete names", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const address = String(url);
      if (address.includes("accounts:lookup")) {
        return json({ users: [{ localId: "editor-1", validSince: "90" }] });
      }
      if (address.includes("/users/editor-1")) return json({});
      if (address.includes(":runQuery")) {
        return json([{ document: { name: `${ROOT}/cmsBylineDirectory/${AUTHOR_A}`,
          fields: { authorId: { stringValue: AUTHOR_A }, eligible: { booleanValue: true } } } }]);
      }
      if (address.includes("/cmsBylineSelf/editor-1")) return json({}, 404);
      throw new Error("Unexpected URL");
    });
    await expect(readBylineDirectory(input(fetcher))).rejects.toThrow("Invalid byline fields");
  });
});
