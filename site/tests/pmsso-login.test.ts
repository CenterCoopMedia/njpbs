import { describe, it, expect, vi } from "vitest";
import {
  isValidCodeVerifier,
  pkceChallengeS256,
  randomCodeVerifier,
  randomState,
  randomNonce,
  verifyState,
  verifyNonce,
  safeReturnTo,
  publicView,
  isExpired,
  isRevoked,
  canServe,
  checkCodecContract,
  buildAuthorizeUrl,
  type SecurityToken,
  parseCallbackParams,
  type MemberSession,
  type SessionCookieCodec,
} from "../src/lib/pmsso-login";

// These prove the credential-free security invariants of the PMSSO member login
// (#207): PKCE derivation against the RFC test vector, fail-closed state/nonce
// checks, an open-redirect-safe return-to, the token/display separation the cookie
// must enforce, session lifecycle, and the seal/unseal contract. Design:
// docs/research/pmsso-login-core.md.

const session = (over: Partial<MemberSession> = {}): MemberSession => ({
  pid: "pid-123",
  firstName: "Alex",
  thumbnail: "https://img.pbs.org/a.jpg",
  membership: { status: "on", expireDate: "2027-01-01", offer: "sustainer" },
  accessToken: "at-secret",
  refreshToken: "rt-secret",
  idToken: "id-secret",
  issuedAt: 1_000,
  expiresAt: 10_000,
  sid: "sid-abc",
  ...over,
});

describe("PKCE (RFC 7636)", () => {
  it("derives the S256 challenge from the RFC 7636 appendix B vector", async () => {
    // The one worked example in the spec: verifier -> challenge.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await pkceChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("emits base64url with no padding and no + or /", async () => {
    const challenge = await pkceChallengeS256("a".repeat(43));
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("accepts a well-formed verifier and rejects out-of-range or bad charset", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    expect(isValidCodeVerifier(`${"a".repeat(41)}.~`)).toBe(true);
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false); // too short: weak entropy
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false); // too long
    expect(isValidCodeVerifier("a".repeat(42) + "+")).toBe(false); // reserved char
    expect(isValidCodeVerifier("a".repeat(42) + " ")).toBe(false); // whitespace
    expect(isValidCodeVerifier("")).toBe(false);
  });
});

describe("minting the verifier, state, and nonce (CSPRNG)", () => {
  const BASE64URL_43 = /^[A-Za-z0-9\-_]{43}$/;

  it("mints a verifier the validator always accepts", () => {
    // The generate/validate round-trip: a freshly minted verifier must pass the
    // same isValidCodeVerifier check that guards it before use, every time.
    for (let i = 0; i < 50; i++) {
      const verifier = randomCodeVerifier();
      expect(verifier).toMatch(BASE64URL_43);
      expect(isValidCodeVerifier(verifier)).toBe(true);
    }
  });

  it("mints state and nonce as 43-char base64url tokens", () => {
    expect(randomState()).toMatch(BASE64URL_43);
    expect(randomNonce()).toMatch(BASE64URL_43);
  });

  it("draws from the CSPRNG, never Math.random", () => {
    // The classic PKCE/OAuth mistake is minting these with Math.random, which is
    // predictable and lets an attacker forge the verifier or state. Assert the
    // secure source is used and the unsafe one is never touched.
    const secure = vi.spyOn(globalThis.crypto, "getRandomValues");
    const unsafe = vi.spyOn(Math, "random");
    try {
      randomCodeVerifier();
      randomState();
      randomNonce();
      expect(secure).toHaveBeenCalled();
      expect(unsafe).not.toHaveBeenCalled();
    } finally {
      secure.mockRestore();
      unsafe.mockRestore();
    }
  });

  it("produces unique values across many calls and across the three minters", () => {
    // A constant stub or a low-entropy source collides fast; 256 bits does not.
    const rounds = 256;
    const seen = new Set<string>();
    for (let i = 0; i < rounds; i++) {
      seen.add(randomCodeVerifier());
      seen.add(randomState());
      seen.add(randomNonce());
    }
    expect(seen.size).toBe(rounds * 3);
  });

  it("feeds pkceChallengeS256 a valid verifier end to end", async () => {
    // Generation then derivation: the minted verifier hashes to a well-formed
    // base64url challenge, the value the authorize request carries.
    const challenge = await pkceChallengeS256(randomCodeVerifier());
    expect(challenge).toMatch(BASE64URL_43);
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe("state and nonce verification (fail-closed)", () => {
  it("verifyState accepts an exact match and rejects everything else", () => {
    expect(verifyState("s-abc", "s-abc")).toBe(true);
    expect(verifyState("s-abc", "s-xyz")).toBe(false);
    expect(verifyState("s-ab", "s-abc")).toBe(false); // length mismatch
    expect(verifyState(undefined, "s-abc")).toBe(false); // missing returned
    expect(verifyState("s-abc", undefined)).toBe(false); // missing expected
    expect(verifyState("", "")).toBe(false); // empty is not a valid state
  });

  it("verifyNonce accepts an exact match and rejects mismatch or missing", () => {
    expect(verifyNonce("n-1", "n-1")).toBe(true);
    expect(verifyNonce("n-1", "n-2")).toBe(false);
    expect(verifyNonce(null, "n-1")).toBe(false);
  });
});

describe("safeReturnTo (open-redirect guard)", () => {
  it("allows same-site absolute paths, with query and fragment", () => {
    expect(safeReturnTo("/give/")).toBe("/give/");
    expect(safeReturnTo("/watch/passport/nova")).toBe("/watch/passport/nova");
    expect(safeReturnTo("/search?q=nova#top")).toBe("/search?q=nova#top");
    expect(safeReturnTo("/")).toBe("/");
    // A scheme inside a query value is fine: only the path can redirect off-site.
    expect(safeReturnTo("/out?next=https://pbs.org")).toBe(
      "/out?next=https://pbs.org",
    );
  });

  it("falls back for anything that could leave the site", () => {
    expect(safeReturnTo("//evil.com")).toBe("/"); // protocol-relative
    expect(safeReturnTo("/\\evil.com")).toBe("/"); // backslash folds to //
    expect(safeReturnTo("https://evil.com")).toBe("/"); // absolute url
    expect(safeReturnTo("javascript:alert(1)")).toBe("/"); // scheme, no slash
    expect(safeReturnTo("/a:b")).toBe("/"); // colon in the path is a scheme
    expect(safeReturnTo("evil.com")).toBe("/"); // relative, not a site path
    expect(safeReturnTo("")).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("/a".repeat(2000))).toBe("/"); // over the length cap
  });

  it("rejects control characters that enable header injection", () => {
    expect(safeReturnTo("/ok\r\nSet-Cookie: x=1")).toBe("/");
    expect(safeReturnTo("/ok\tpath")).toBe("/");
    expect(safeReturnTo("/ok\x00")).toBe("/");
  });

  it("honors a caller-supplied fallback", () => {
    expect(safeReturnTo("//evil.com", "/home")).toBe("/home");
  });
});

describe("publicView (token/display separation)", () => {
  it("exposes only display fields and the membership snapshot", () => {
    const view = publicView(session());
    expect(view).toEqual({
      pid: "pid-123",
      firstName: "Alex",
      thumbnail: "https://img.pbs.org/a.jpg",
      membership: { status: "on", expireDate: "2027-01-01", offer: "sustainer" },
    });
  });

  it("never carries a token or the session id, even by key", () => {
    // Allowlist by construction: iterate the output so a leak would fail here.
    const keys = Object.keys(publicView(session()));
    for (const secret of ["accessToken", "refreshToken", "idToken", "sid"]) {
      expect(keys).not.toContain(secret);
    }
  });

  it("does not let an extra property on the source ride along", () => {
    const tainted = session() as MemberSession & { leaked?: string };
    tainted.leaked = "should-not-appear";
    expect(JSON.stringify(publicView(tainted))).not.toContain("should-not-appear");
  });
});

describe("session lifecycle", () => {
  it("expires at or after expiresAt and is live before it", () => {
    const s = session({ expiresAt: 10_000 });
    expect(isExpired(s, 9_999)).toBe(false);
    expect(isExpired(s, 10_000)).toBe(true);
    expect(isExpired(s, 10_001)).toBe(true);
  });

  it("treats a non-finite clock as expired (fail-closed)", () => {
    expect(isExpired(session(), Number.NaN)).toBe(true);
    expect(isExpired(session(), Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("treats a malformed expiresAt as expired (fail-closed)", () => {
    // A buggy codec or a migration could hand back a non-finite expiry; it must
    // force re-auth, not leave the session live forever.
    expect(isExpired(session({ expiresAt: Number.NaN }), 5_000)).toBe(true);
    expect(isExpired(session({ expiresAt: Number.POSITIVE_INFINITY }), 5_000)).toBe(
      true,
    );
    expect(canServe(session({ expiresAt: Number.NaN }), 5_000, new Set())).toBe(
      false,
    );
  });

  it("revokes a session by its id", () => {
    const revoked = new Set(["sid-abc"]);
    expect(isRevoked("sid-abc", revoked)).toBe(true);
    expect(isRevoked("sid-other", revoked)).toBe(false);
  });

  it("canServe requires both live and not revoked", () => {
    const s = session({ expiresAt: 10_000, sid: "sid-abc" });
    const none: ReadonlySet<string> = new Set();
    expect(canServe(s, 5_000, none)).toBe(true);
    expect(canServe(s, 20_000, none)).toBe(false); // expired
    expect(canServe(s, 5_000, new Set(["sid-abc"]))).toBe(false); // revoked
  });
});

describe("checkCodecContract", () => {
  const binaryFromBytes = (bytes: Uint8Array): string => {
    let out = "";
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  };
  const base64UrlFromBytes = (bytes: Uint8Array): string =>
    btoa(binaryFromBytes(bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const bytesFromBase64Url = (value: string): Uint8Array => {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  };
  const key = new TextEncoder().encode("pmsso-contract-test-key");
  const crypt = (bytes: Uint8Array): Uint8Array =>
    bytes.map((byte, i) => byte ^ key[i % key.length] ^ ((i * 17 + 29) & 0xff));

  // JSON payload plus a content checksum. This proves integrity, but anyone with
  // the cookie can base64-decode the body and read the tokens.
  const checksum = (s: string): string =>
    String([...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7));
  const signedReadableCodec: SessionCookieCodec = {
    seal(sess) {
      const body = btoa(JSON.stringify(sess));
      return `${body}.${checksum(body)}`;
    },
    unseal(blob) {
      const dot = blob.lastIndexOf(".");
      if (dot === -1) return null;
      const body = blob.slice(0, dot);
      if (blob.slice(dot + 1) !== checksum(body)) return null; // tamper/garbage
      try {
        return JSON.parse(atob(body)) as MemberSession;
      } catch {
        return null;
      }
    },
  };

  // Test-only reversible encryption plus a content checksum. The runtime uses a
  // vetted AEAD; this fixture only gives the contract checker opaque bytes while
  // keeping the sync seal/unseal shape.
  const encryptedCodec: SessionCookieCodec = {
    seal(sess) {
      const plain = new TextEncoder().encode(JSON.stringify(sess));
      const body = base64UrlFromBytes(crypt(plain));
      return `${body}.${checksum(body)}`;
    },
    unseal(blob) {
      const dot = blob.lastIndexOf(".");
      if (dot === -1) return null;
      const body = blob.slice(0, dot);
      if (blob.slice(dot + 1) !== checksum(body)) return null;
      try {
        const plain = crypt(bytesFromBase64Url(body));
        return JSON.parse(new TextDecoder().decode(plain)) as MemberSession;
      } catch {
        return null;
      }
    },
  };

  it("reports no violations for an encrypting codec", () => {
    expect(checkCodecContract(encryptedCodec, session())).toEqual([]);
  });

  it("rejects a signed but readable codec that leaks sealed tokens", () => {
    const problems = checkCodecContract(signedReadableCodec, session());
    expect(problems).toContain(
      "sealed cookie leaks accessToken via base64 decoding",
    );
    expect(problems).toContain(
      "sealed cookie leaks refreshToken via base64 decoding",
    );
    expect(problems).toContain("sealed cookie leaks idToken via base64 decoding");
  });

  it("catches a codec that silently drops a sealed field", () => {
    // Round-trips and rejects tampering, but loses the refresh token. Downstream
    // session-refresh code would break; the checker must surface it.
    const dropsRefreshToken: SessionCookieCodec = {
      seal: encryptedCodec.seal,
      unseal: (blob) => {
        const back = encryptedCodec.unseal(blob);
        if (!back) return null;
        return { ...back, refreshToken: "" };
      },
    };
    const problems = checkCodecContract(dropsRefreshToken, session());
    expect(problems.some((p) => p.includes("refreshToken"))).toBe(true);
  });

  it("catches a codec with no integrity check (accepts tampering)", () => {
    const noIntegrity: SessionCookieCodec = {
      seal: (s) => btoa(JSON.stringify(s)),
      unseal: (blob) => {
        try {
          return JSON.parse(atob(blob)) as MemberSession;
        } catch {
          return null;
        }
      },
    };
    const problems = checkCodecContract(noIntegrity, session());
    expect(problems.some((p) => p.includes("tampered"))).toBe(true);
  });

  it("catches a codec that throws on malformed input", () => {
    const throwsOnGarbage: SessionCookieCodec = {
      seal: encryptedCodec.seal,
      unseal: (blob) => {
        if (!blob.includes(".")) throw new Error("bad cookie");
        return encryptedCodec.unseal(blob);
      },
    };
    const problems = checkCodecContract(throwsOnGarbage, session());
    expect(problems.some((p) => p.includes("threw on malformed input"))).toBe(true);
  });

  it("catches a codec that throws on a tampered blob instead of returning null", () => {
    // Handles obvious garbage cleanly, but throws when a real-looking blob fails
    // its integrity check. In production that is a 500 on a stale cookie, not a
    // clean logout, so the contract forbids it.
    const throwsOnTamper: SessionCookieCodec = {
      seal: encryptedCodec.seal,
      unseal: (blob) => {
        const dot = blob.lastIndexOf(".");
        if (dot === -1) return null; // garbage: fail closed, no throw
        const body = blob.slice(0, dot);
        if (blob.slice(dot + 1) !== checksum(body)) throw new Error("bad tag");
        return encryptedCodec.unseal(blob);
      },
    };
    const problems = checkCodecContract(throwsOnTamper, session());
    expect(problems.some((p) => p.includes("threw on a tampered blob"))).toBe(true);
  });
});

// --- The authorize request and the callback ------------------------------

describe("buildAuthorizeUrl", () => {
  const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const asToken = (s: string) => s as SecurityToken;

  const valid = () => ({
    authorizeEndpoint: "https://account.pbs.org/oauth2/authorize",
    clientId: "njpbs-station-client",
    redirectUri: "https://njpbs.org/auth/callback",
    scopes: ["openid", "profile", "email"],
    state: randomState(),
    nonce: randomNonce(),
    codeVerifier: RFC_VERIFIER,
  });

  const paramsOf = (url: string) => new URL(url).searchParams;

  it("keeps validated request fields when the caller mutates them during hashing", async () => {
    const request = valid();
    const original = { ...request, scopes: [...request.scopes] };
    const pending = buildAuthorizeUrl(request);
    request.authorizeEndpoint = "http://untrusted.example/authorize";
    request.redirectUri = "http://untrusted.example/callback";
    request.clientId = "changed-client";
    request.scopes.splice(0, request.scopes.length, "changed-scope");
    request.state = asToken("changed-state");
    request.nonce = asToken("changed-nonce");
    request.codeVerifier = "changed-verifier";
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(`${url.origin}${url.pathname}`).toBe(original.authorizeEndpoint);
    expect(url.searchParams.get("redirect_uri")).toBe(original.redirectUri);
    expect(url.searchParams.get("client_id")).toBe(original.clientId);
    expect(url.searchParams.get("scope")).toBe(original.scopes.join(" "));
    expect(url.searchParams.get("state")).toBe(original.state);
    expect(url.searchParams.get("nonce")).toBe(original.nonce);
    expect(url.searchParams.get("code_challenge")).toBe(RFC_CHALLENGE);
  });

  it("sends every parameter the flow's security depends on", async () => {
    const request = valid();
    const result = await buildAuthorizeUrl(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = paramsOf(result.url);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("scope")).toBe("openid profile email");
    // By identity, not truthiness. state and nonce are same-shaped random
    // tokens, so a check that only asks "is something there" passes just as
    // happily when the two are swapped -- and a state landing in the nonce
    // parameter aliases the CSRF guard to the replay guard, which is the exact
    // failure randomNonce's own docstring warns about.
    expect(p.get("state")).toBe(request.state);
    expect(p.get("nonce")).toBe(request.nonce);
    expect(p.get("state")).not.toBe(p.get("nonce"));
    expect(p.get("redirect_uri")).toBe(request.redirectUri);
    expect(p.get("client_id")).toBe(request.clientId);
    expect(p.get("code_challenge")).toBe(RFC_CHALLENGE);
  });

  it("derives a 43-character verifier and never sends it raw", async () => {
    const verifier = `${"a".repeat(41)}.~`;
    const challenge = await pkceChallengeS256(verifier);
    const result = await buildAuthorizeUrl({ ...valid(), codeVerifier: verifier });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const params = paramsOf(result.url);
    expect(verifier).toHaveLength(43);
    expect(params.get("code_challenge")).toBe(challenge);
    expect(params.has("code_verifier")).toBe(false);
    expect([...params.values()]).not.toContain(verifier);
  });

  it("accepts a verifier from the module's CSPRNG", async () => {
    const result = await buildAuthorizeUrl({
      ...valid(),
      codeVerifier: randomCodeVerifier(),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses to build a url that silently drops a security parameter", async () => {
    // Each of these still produces a working login, which is why they have to
    // fail here rather than at runtime.
    const cases: Array<[string, Partial<ReturnType<typeof valid>>]> = [
      ["state", { state: asToken("") }],
      ["nonce", { nonce: asToken("") }],
      ["codeVerifier", { codeVerifier: "" }],
      ["clientId", { clientId: "" }],
      ["openid", { scopes: ["profile", "email"] }],
    ];
    for (const [name, override] of cases) {
      const result = await buildAuthorizeUrl({ ...valid(), ...override });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.problems.join(" ")).toContain(name);
    }
  });

  it("rejects a challenge-only JavaScript request with no verifier", async () => {
    const request: Record<string, unknown> = {
      ...valid(),
      codeChallenge: RFC_CHALLENGE,
    };
    delete request.codeVerifier;
    const result = await buildAuthorizeUrl(
      request as unknown as Parameters<typeof buildAuthorizeUrl>[0],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("codeVerifier");
  });

  it("enforces the RFC verifier length and unreserved-character grammar", async () => {
    const accepted = ["a".repeat(43), `${"a".repeat(126)}.~`];
    for (const codeVerifier of accepted) {
      expect((await buildAuthorizeUrl({ ...valid(), codeVerifier })).ok).toBe(true);
    }

    const rejected = [
      "a".repeat(42),
      "a".repeat(129),
      `${"a".repeat(42)}+`,
      `${"a".repeat(42)}/`,
      `${"a".repeat(42)}=`,
      `${"a".repeat(42)} `,
    ];
    for (const codeVerifier of rejected) {
      const result = await buildAuthorizeUrl({ ...valid(), codeVerifier });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.problems.join(" ")).toContain("codeVerifier");
    }
  });

  it("returns a generic failure when challenge derivation fails", async () => {
    const codeVerifier = `${"v".repeat(41)}.~`;
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(
      new Error(`digest detail containing ${codeVerifier}`),
    );
    try {
      const result = await buildAuthorizeUrl({ ...valid(), codeVerifier });
      expect(result).toEqual({
        ok: false,
        problems: ["PKCE challenge derivation failed"],
      });
      expect(JSON.stringify(result)).not.toContain(codeVerifier);
      expect(JSON.stringify(result)).not.toContain("digest detail");
    } finally {
      digest.mockRestore();
    }
  });

  it("rejects a state or nonce too weak to defend anything", async () => {
    // A truthiness check passes "x", and the resulting url looks perfectly
    // normal: the CSRF token and the replay guard are just guessable. Nothing
    // downstream notices, which is why it has to fail here.
    for (const weak of ["x", "abc", "a".repeat(42)]) {
      expect(
        (await buildAuthorizeUrl({ ...valid(), state: asToken(weak) })).ok,
      ).toBe(false);
      expect(
        (await buildAuthorizeUrl({ ...valid(), nonce: asToken(weak) })).ok,
      ).toBe(false);
    }
    // The module's own generators clear the bar, which is what makes it usable.
    expect(
      (await buildAuthorizeUrl({
        ...valid(),
        state: randomState(),
        nonce: randomNonce(),
      })).ok,
    ).toBe(true);
  });

  it("rejects a non-https endpoint or redirect, and credentials in the url", async () => {
    const bad = [
      { authorizeEndpoint: "http://account.pbs.org/oauth2/authorize" },
      { redirectUri: "http://njpbs.org/auth/callback" },
      { redirectUri: "javascript:alert(1)" },
      { redirectUri: `https://fixture-user:fixture-password@${"njpbs.org"}/auth/callback` },
      { authorizeEndpoint: "not a url" },
    ];
    for (const override of bad) {
      expect((await buildAuthorizeUrl({ ...valid(), ...override })).ok).toBe(false);
    }
  });

  it("returns a result rather than throwing on a non-array scopes value", async () => {
    // A space-delimited string satisfies .includes("openid") through
    // String.prototype and would then throw on .join, breaking the contract this
    // whole function is built around.
    const result = await buildAuthorizeUrl({
      ...valid(),
      scopes: "openid profile" as unknown as readonly string[],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("array");
  });

  it("allows http on loopback so local development works", async () => {
    const result = await buildAuthorizeUrl({
      ...valid(),
      redirectUri: "http://localhost:4321/auth/callback",
    });
    expect(result.ok).toBe(true);
  });

  it("preserves an endpoint's own query string and cannot be injected into", async () => {
    // clientId is the free-form field left after state and nonce are pinned to a
    // token shape, so it is where an injected `&scope=` would come from.
    const clientId = "njpbs&scope=evil";
    const result = await buildAuthorizeUrl({
      ...valid(),
      authorizeEndpoint: "https://account.pbs.org/oauth2/authorize?tenant=njpbs",
      clientId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = paramsOf(result.url);
    expect(p.get("tenant")).toBe("njpbs");
    expect(p.get("scope")).toBe("openid profile email");
    expect(p.get("client_id")).toBe(clientId);
  });
});

describe("parseCallbackParams", () => {
  it("reads a grant as code plus state", () => {
    expect(parseCallbackParams("code=abc123&state=xyz789")).toEqual({
      kind: "code",
      code: "abc123",
      state: "xyz789",
    });
  });

  it("reads a provider decline as an error", () => {
    expect(
      parseCallbackParams("error=access_denied&error_description=User+said+no&state=xyz"),
    ).toEqual({
      kind: "error",
      error: "access_denied",
      description: "User said no",
      state: "xyz",
    });
  });

  it("never returns a result without the state that guards it", () => {
    // A lone code, or a decline with no state, would let a handler skip
    // verifyState by accident. An unsolicited error redirect is the attack:
    // no login started it, so there is no stashed state it could match.
    for (const q of ["code=abc123", "error=access_denied", "error=access_denied&error_description=nope"]) {
      expect(parseCallbackParams(q).kind).toBe("malformed");
    }
  });

  it("refuses a response that is both a grant and a decline", () => {
    // Not a shape the spec produces, so picking a half is how a grant gets
    // processed under cover of a decline.
    expect(parseCallbackParams("code=abc&error=access_denied&state=xyz").kind).toBe(
      "malformed",
    );
  });

  it("rejects a duplicated parameter instead of picking one", () => {
    // Parameter smuggling: the provider or a proxy reads one value, the handler
    // reads the other. This flow never legitimately sees two.
    for (const q of [
      "code=good&code=evil&state=xyz",
      "code=abc&state=mine&state=theirs",
      "error=access_denied&error=server_error",
    ]) {
      expect(parseCallbackParams(q).kind).toBe("malformed");
    }
  });

  it("treats an empty or unrecognizable response as malformed", () => {
    for (const q of ["", "foo=bar"]) {
      expect(parseCallbackParams(q).kind).toBe("malformed");
    }
  });

  it("accepts a URLSearchParams as well as a raw query string", () => {
    const params = new URLSearchParams({ code: "abc", state: "xyz" });
    expect(parseCallbackParams(params)).toEqual({
      kind: "code",
      code: "abc",
      state: "xyz",
    });
  });
});
