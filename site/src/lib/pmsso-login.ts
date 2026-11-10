// Pure security and session contracts for PBS Public Media SSO login.
// Enforce PKCE, state, nonce, safe return paths, token/display separation,
// expiry and revocation. Callers own client credentials, redirect registration,
// token exchange and identity reads. SessionCookieCodec requires a maintained
// authenticated-encryption implementation or provider-managed session; this
// module checks that contract and does not implement cookie encryption.

// --- OIDC request security: PKCE (RFC 7636) -------------------------------

/** The RFC 7636 code-verifier grammar: 43 to 128 unreserved characters. */
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Whether a PKCE code verifier is well-formed per RFC 7636 section 4.1: 43 to 128
 * characters drawn from the unreserved set. A verifier shorter than 43 characters
 * has too little entropy to resist a guessing attack, so this is a security check,
 * not just a format check. The verifier is generated with a CSPRNG in the slice
 * that builds the auth request; this validates one before it is used.
 */
export function isValidCodeVerifier(verifier: string): boolean {
  return typeof verifier === "string" && CODE_VERIFIER_RE.test(verifier);
}

/** base64url with no padding, from raw bytes. */
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A digest derived by `pkceChallengeS256`, distinct from its input verifier. */
export type CodeChallenge = string & { readonly __brand: "pkce-s256-challenge" };

/**
 * Derive the PKCE `code_challenge` from a verifier using the S256 method:
 * base64url(SHA-256(verifier)) with no padding (RFC 7636 section 4.2). S256 is the
 * only method a public client should use; the `plain` method offers no protection
 * and is not implemented here. The reference PMSSO client
 * (OpenPublicMedia/oauth2-pbs) uses PKCE, so the station site sends the challenge
 * on the authorize request and the verifier on the token exchange.
 *
 * The return type is branded: see `CodeChallenge`.
 */
export async function pkceChallengeS256(verifier: string): Promise<CodeChallenge> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlFromBytes(new Uint8Array(digest)) as CodeChallenge;
}

// --- OIDC request security: state and nonce -------------------------------

/**
 * Length-independent string equality. Compares every character rather than
 * returning at the first mismatch, so a match check does not leak how much of a
 * high-entropy token an attacker guessed. Unequal lengths are rejected up front;
 * the token length itself is not secret.
 */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the `state` returned on the callback against the value stashed when the
 * login began. Fail-closed: a missing, empty, or mismatched state is a failed CSRF
 * check and denies the callback. This is the defense against an attacker
 * stitching their own authorization response onto a victim's session.
 */
export function verifyState(
  returned: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!returned || !expected) return false;
  return safeEqual(returned, expected);
}

/**
 * Verify the `nonce` claim in the returned id token against the value sent on the
 * authorize request. Fail-closed on anything missing or mismatched. This binds the
 * id token to this specific login and is the defense against an id token being
 * replayed from a different session.
 */
export function verifyNonce(
  idTokenNonce: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!idTokenNonce || !expected) return false;
  return safeEqual(idTokenNonce, expected);
}

// --- OIDC request security: minting the verifier, state, and nonce --------

/**
 * The random-byte width behind a minted verifier, state, or nonce. RFC 7636
 * section 7.1 recommends 32 octets (256 bits) from a suitable random number
 * generator for the code verifier, and 32 bytes base64url-encode to a
 * 43-character string -- exactly the RFC 7636 minimum verifier length. That
 * coincidence is the point: a minted verifier lands at the bottom of the
 * `isValidCodeVerifier` range with no padding or truncation, so generation and
 * validation agree by construction. State and nonce reuse the same width; their
 * only requirement is that they be unguessable.
 */
const TOKEN_ENTROPY_BYTES = 32;

/**
 * A `state` or `nonce` this module minted. Length is not entropy, so
 * `"a".repeat(43)` satisfies every
 * shape check while leaving the CSRF guard and the replay guard guessable, and
 * the resulting authorize url looks entirely normal. The brand forces a caller
 * through `randomState` / `randomNonce` rather than trusting a string that
 * happens to be the right width.
 */
export type SecurityToken = string & { readonly __brand: "csprng-token" };

/**
 * A base64url token of `TOKEN_ENTROPY_BYTES` drawn from the platform CSPRNG. This
 * is the security-critical step in generation: `crypto.getRandomValues` is a
 * cryptographically secure source, and the classic PKCE/OAuth mistake is to reach
 * for `Math.random` here, which is predictable and lets an attacker forge the
 * verifier or the state. Routing all three minters through this single function
 * keeps that guarantee auditable in one place.
 */
function randomToken(): SecurityToken {
  const bytes = new Uint8Array(TOKEN_ENTROPY_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlFromBytes(bytes) as SecurityToken;
}

/**
 * Mint a fresh PKCE code verifier: a `randomToken` at the width that satisfies
 * `isValidCodeVerifier` by construction (see `TOKEN_ENTROPY_BYTES`). The derive
 * half, `pkceChallengeS256`, then hashes it for the authorize request; the
 * verifier stays server-side and only the challenge is sent, per RFC 7636.
 *
 * Returns a plain string so a verifier restored from server-side session storage
 * can reach `buildAuthorizeUrl`. That builder validates it and derives the
 * challenge itself; callers cannot pass a raw verifier as the challenge.
 */
export function randomCodeVerifier(): string {
  return randomToken();
}

/**
 * Mint the CSRF `state`: an opaque token stashed when login begins and checked
 * with `verifyState` when the callback echoes it back. Only unpredictability and
 * an exact round-trip matter, which `randomToken` already provides.
 */
export function randomState(): SecurityToken {
  return randomToken();
}

/**
 * Mint the `nonce` sent on the authorize request and later matched against the id
 * token claim with `verifyNonce`. Same construction as `randomState` but a
 * separate call on purpose: state and nonce are distinct values guarding distinct
 * attacks (CSRF on the callback versus id-token replay), and must never be
 * aliased to one generated string.
 */
export function randomNonce(): SecurityToken {
  return randomToken();
}

// --- The authorize request and the callback ------------------------------

/**
 * The inputs to a PMSSO authorize request. Every PBS-specific value -- the
 * endpoint, the client id, the registered redirect uri, the scopes -- is a
 * parameter rather than a constant, which is what keeps this credential-free: the
 * secret store and the real values arrive with the Firebase Functions slice, and
 * this builder is already tested against them.
 *
 * The client *secret* is deliberately absent. It belongs only to the back-channel
 * token exchange; putting it on the authorize URL would send it through the
 * viewer's browser.
 */
export interface AuthorizeRequest {
  authorizeEndpoint: string;
  clientId: string;
  /** Must exactly match a redirect uri registered with PBS for this client. */
  redirectUri: string;
  scopes: readonly string[];
  /** From `randomState`, stashed for `verifyState` on the callback. */
  state: SecurityToken;
  /** From `randomNonce`, matched against the id token claim by `verifyNonce`. */
  nonce: SecurityToken;
  /** From `randomCodeVerifier`, retained server-side for the token exchange. */
  codeVerifier: string;
}

export type AuthorizeUrlResult =
  | { ok: true; url: string }
  | { ok: false; problems: readonly string[] };

// A token from `randomToken`: TOKEN_ENTROPY_BYTES of CSPRNG output in unpadded
// base64url, so 43 chars. Longer is accepted -- the bar is entropy, not this
// module's exact format -- but a short or constant value is not, since "state"
// and "nonce" only defend anything when they are unguessable and a truthiness
// check would pass `"x"` straight through to a live authorize url.
const MIN_TOKEN_CHARS = 43;
const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${MIN_TOKEN_CHARS},}$`);

/**
 * Whether a url is a legitimate endpoint or redirect target for this flow. HTTPS
 * only, with one carve-out: `http` on a loopback host, so local development
 * against a `localhost` callback works without weakening the deployed path. A
 * url carrying credentials in its userinfo is refused outright.
 */
function isHttpsOrLoopback(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
}

/**
 * Build the PMSSO authorize URL that starts a member login.
 *
 * This returns a result rather than throwing, and refuses to build a URL it is
 * not sure about, because every field here is load-bearing for security and the
 * failure mode is silent. A missing `code_challenge` downgrades the flow to one
 * without PKCE; a missing `state` removes the CSRF check on the callback; a
 * missing `nonce` allows an id token from another session to be replayed. None of
 * those break anything visibly at runtime -- login still works -- so they must
 * fail here, at build time, where a test can see them.
 *
 * `response_type` and `code_challenge_method` are fixed, not parameters:
 * authorization code plus S256 is the only combination a public client should
 * send, and making them arguments would only create a way to get them wrong.
 * Parameters are set through `URLSearchParams`, so a value cannot inject an extra
 * parameter and an endpoint's own query string cannot be duplicated or dropped.
 */
export async function buildAuthorizeUrl(
  request: AuthorizeRequest,
): Promise<AuthorizeUrlResult> {
  const problems: string[] = [];

  if (!isHttpsOrLoopback(request.authorizeEndpoint)) {
    problems.push("authorizeEndpoint must be an https url (or http on loopback)");
  }
  if (!isHttpsOrLoopback(request.redirectUri)) {
    problems.push("redirectUri must be an https url (or http on loopback)");
  }
  if (!request.clientId) {
    problems.push("clientId is required");
  }
  if (!TOKEN_RE.test(request.state ?? "")) {
    problems.push(
      "state must be a high-entropy token from randomState: without one the " +
        "callback has no CSRF check",
    );
  }
  if (!TOKEN_RE.test(request.nonce ?? "")) {
    problems.push(
      "nonce must be a high-entropy token from randomNonce: without one an id " +
        "token can be replayed",
    );
  }
  if (!isValidCodeVerifier(request.codeVerifier)) {
    problems.push(
      "codeVerifier must contain 43 to 128 unreserved characters",
    );
  }
  // Array-ness is checked before membership, not after: a space-delimited string
  // from JS or config plumbing ("openid profile") passes `.includes("openid")`
  // via String.prototype and then throws on `.join` below -- which breaks this
  // function's whole contract of returning a result instead of raising.
  //
  // OIDC is an OAuth2 profile: without the `openid` scope PMSSO runs a plain
  // OAuth2 authorization and returns no id token, so the nonce check silently has
  // nothing to verify.
  if (!Array.isArray(request.scopes)) {
    problems.push("scopes must be an array of scope strings");
  } else if (!request.scopes.includes("openid")) {
    problems.push("scopes must include openid for an OIDC login");
  }

  if (problems.length > 0) return { ok: false, problems };

  // Capture every validated field before hashing yields to the caller, who
  // could otherwise mutate the request (including its scopes array).
  const url = new URL(request.authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", request.scopes.join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("nonce", request.nonce);
  let codeChallenge: CodeChallenge;
  try {
    codeChallenge = await pkceChallengeS256(request.codeVerifier);
  } catch {
    return { ok: false, problems: ["PKCE challenge derivation failed"] };
  }
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { ok: true, url: url.toString() };
}

/**
 * What came back on the callback, once. `error` is the provider declining
 * (RFC 6749 section 4.1.2.1: the viewer cancelled, the client is misconfigured);
 * `malformed` is a response that is neither a grant nor a well-formed decline, so
 * it is treated as hostile rather than guessed at.
 */
export type CallbackParams =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description?: string; state: string }
  | { kind: "malformed"; problems: readonly string[] };

/**
 * Read the authorization response off the callback query string.
 *
 * Fail-closed and single-valued: a repeated `code` or `state` is `malformed`, not
 * first-wins. A duplicated parameter is how a response gets smuggled past a
 * handler that reads one value while the provider or a proxy read the other, and
 * this flow has no reason to ever see two.
 *
 * `state` is required on every response, decline included. `buildAuthorizeUrl`
 * always sends one, and RFC 6749 section 4.1.2.1 requires the provider to echo it
 * back on the error redirect too, so a decline without it did not come from a
 * login this site started. The caller still has to run `verifyState` against the
 * value stashed at login; this only guarantees there is something to check.
 * Handing back a result with no `state` would let a handler skip that check by
 * accident, which is the whole attack: an unsolicited `error` redirect that walks
 * a viewer through the site's failure path.
 *
 * A response carrying both `code` and `error` is malformed rather than one or the
 * other -- it is not a shape the spec produces, so guessing which half to honor is
 * how a grant gets processed under cover of a decline.
 */
export function parseCallbackParams(
  query: string | URLSearchParams,
): CallbackParams {
  const params =
    typeof query === "string" ? new URLSearchParams(query) : query;
  const problems: string[] = [];

  const single = (name: string): string | undefined => {
    const all = params.getAll(name);
    if (all.length > 1) {
      problems.push(
        `${name} appeared ${all.length} times: a duplicated parameter is how a ` +
          `response gets smuggled past a handler that reads one value`,
      );
      return undefined;
    }
    return all[0];
  };

  const code = single("code");
  const state = single("state");
  const error = single("error");
  const description = single("error_description");

  if (problems.length > 0) return { kind: "malformed", problems };

  if (error && code) {
    return {
      kind: "malformed",
      problems: ["both code and error present: not a response shape the spec produces"],
    };
  }
  if (!state) {
    problems.push(
      code || error
        ? "no state: nothing to check the CSRF token against"
        : "no code and no error",
    );
    return { kind: "malformed", problems };
  }
  if (error) {
    return {
      kind: "error",
      error,
      ...(description ? { description } : {}),
      state,
    };
  }
  if (code) return { kind: "code", code, state };

  problems.push("state alone: neither a grant nor a decline");
  return { kind: "malformed", problems };
}

// --- Return-to safety: open-redirect guard --------------------------------

/** A return-to longer than this is rejected outright rather than parsed. */
const RETURN_TO_MAX = 2048;

/**
 * Sanitize the "return the viewer to the page they started on" value into a safe
 * same-site path, falling back to a caller-supplied safe default when the
 * candidate is anything else. Open redirect is OWASP-flagged, and a login callback
 * that honors an arbitrary return url is a classic phishing pivot, so the rule is
 * an allowlist: a candidate must be an absolute path on this site.
 *
 * Rejected: absolute urls and `javascript:` (no leading slash, or a colon in the
 * path), protocol-relative `//host`, backslash tricks that browsers fold to `/`,
 * and control characters including the CR/LF that enable header injection when the
 * value later lands in a `Location` header. A scheme inside a query value is
 * allowed, since only the path can redirect the browser off-site. `fallback` must
 * itself be a caller-controlled safe path (default `/`).
 */
export function safeReturnTo(
  candidate: string | undefined | null,
  fallback = "/",
): string {
  if (typeof candidate !== "string") return fallback;
  const c = candidate;
  if (c.length === 0 || c.length > RETURN_TO_MAX) return fallback;
  // Control chars (incl. CR/LF) or a backslash anywhere: browsers normalize `\`
  // to `/`, so `/\evil.com` would become protocol-relative.
  if (/[\x00-\x1f\x7f\\]/.test(c)) return fallback;
  if (c[0] !== "/") return fallback; // relative or absolute-url, not a site path
  if (c[1] === "/") return fallback; // protocol-relative //host
  // A colon in the path portion is a scheme; a colon inside a query value is fine
  // because only the path can send the browser off-site.
  const queryOrHash = c.search(/[?#]/);
  const path = queryOrHash === -1 ? c : c.slice(0, queryOrHash);
  if (path.includes(":")) return fallback;
  return c;
}

// --- The session cookie: token/display separation and lifecycle -----------

/**
 * The Passport entitlement snapshot read from PBS MVault. Stored only as a
 * short-lived session snapshot, never as a system of record: MVault is the
 * authority and is queried live at content-gate time. `status` mirrors MVault's
 * on/off answer.
 */
export interface MembershipInfo {
  status: "on" | "off";
  /** MVault expiry, ISO date, if the membership is on. */
  expireDate?: string;
  /** The MVault offer/level label, if present. */
  offer?: string;
}

/**
 * The full member session, sealed inside the encrypted server-side cookie. It
 * holds the PBS tokens, which never reach the browser, alongside the display
 * fields that may. `sid` is an opaque id for server-side revocation. Identity
 * comes from PBS PIDS (`pid`), never copied into the site database.
 */
export interface MemberSession {
  /** PBS profile id: the stable member key. */
  pid: string;
  firstName: string;
  thumbnail?: string;
  membership: MembershipInfo;
  /** PBS tokens: server-only, never exposed to the client. */
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch ms. */
  issuedAt: number;
  /** Epoch ms after which the session is dead and must be re-authenticated. */
  expiresAt: number;
  /** Opaque session id; membership of the revoked set logs this session out. */
  sid: string;
}

/**
 * The client-readable projection: what the browser may see, exposed via a
 * JS-readable cookie or a `/me` endpoint. It carries display fields and the
 * membership snapshot and nothing else. This is built as an allowlist, naming only
 * the safe fields, so a secret added to `MemberSession` later cannot leak by
 * default: it simply is not copied.
 */
export interface MemberPublicView {
  pid: string;
  firstName: string;
  thumbnail?: string;
  membership: MembershipInfo;
}

/**
 * Project a session down to what the client may read. Allowlist by construction:
 * the tokens and the session id are never named here, so they cannot cross to the
 * browser. Membership is rebuilt field by field so a future extra property on the
 * source object does not ride along.
 */
export function publicView(session: MemberSession): MemberPublicView {
  return {
    pid: session.pid,
    firstName: session.firstName,
    thumbnail: session.thumbnail,
    membership: {
      status: session.membership.status,
      expireDate: session.membership.expireDate,
      offer: session.membership.offer,
    },
  };
}

/**
 * Whether the session has expired at `now` (epoch ms). Fail-closed on either side
 * of the comparison: a broken `now` and a malformed `expiresAt` (NaN or Infinity
 * from a buggy codec or a session migration) are both treated as expired, so a bad
 * timestamp forces re-authentication instead of leaving the session live forever.
 */
export function isExpired(session: MemberSession, now: number): boolean {
  if (!Number.isFinite(now)) return true;
  if (!Number.isFinite(session.expiresAt)) return true;
  return now >= session.expiresAt;
}

/** Whether this session id has been revoked (logged out server-side). */
export function isRevoked(sid: string, revoked: ReadonlySet<string>): boolean {
  return revoked.has(sid);
}

/**
 * Whether a session may still be served: not expired and not revoked. This is the
 * session-validity gate only. Passport content entitlement is a separate live
 * MVault check at play time (auth-and-rbac.md part 3), never folded in here, so a
 * valid session and an active membership stay independent answers.
 */
export function canServe(
  session: MemberSession,
  now: number,
  revoked: ReadonlySet<string>,
): boolean {
  return !isExpired(session, now) && !isRevoked(session.sid, revoked);
}

// --- Cookie encryption supplied by a vetted implementation ----------------

/**
 * The seal/unseal contract for the encrypted session cookie. The runtime fills
 * this with a vetted authenticated-encryption implementation (a provider-managed
 * session or a maintained library such as iron), never a hand-rolled cipher, per
 * auth-and-rbac.md part 4. `unseal` must fail closed: return null for a tampered,
 * wrong-key, expired, or malformed blob, and never throw on bad input.
 */
export interface SessionCookieCodec {
  seal(session: MemberSession): string;
  unseal(blob: string): MemberSession | null;
}

const CONTRACT_SECRET_SENTINELS = {
  accessToken:
    "pmsso-contract-access-token::sentinel/raw?probe=alpha&kind=access",
  refreshToken:
    "pmsso-contract-refresh-token::sentinel/raw?probe=bravo&kind=refresh",
  idToken: "pmsso-contract-id-token::sentinel/raw?probe=charlie&kind=id",
} satisfies Pick<MemberSession, "accessToken" | "refreshToken" | "idToken">;

type TokenField = keyof typeof CONTRACT_SECRET_SENTINELS;

const BASE64_CHUNK_RE = /[A-Za-z0-9+/_=\-]{4,}/g;

function stringToBase64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToString(value: string): string | null {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 4 || compact.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  try {
    return atob(compact.padEnd(Math.ceil(compact.length / 4) * 4, "="));
  } catch {
    return null;
  }
}

function base64UrlToString(value: string): string | null {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 4 || compact.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(compact)) return null;
  return base64ToString(compact.replace(/-/g, "+").replace(/_/g, "/"));
}

function decodeUrl(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function encodedChunks(value: string): string[] {
  return [value, ...(value.match(BASE64_CHUNK_RE) ?? [])];
}

function confidentialityViolations(sealed: string): string[] {
  const problems: string[] = [];
  const decodedViews: Array<{ how: string; value: string }> = [];
  const urlDecoded = decodeUrl(sealed);
  if (urlDecoded && urlDecoded !== sealed) {
    decodedViews.push({ how: "url", value: urlDecoded });
  }

  for (const source of [sealed, ...(urlDecoded ? [urlDecoded] : [])]) {
    for (const chunk of encodedChunks(source)) {
      const base64 = base64ToString(chunk);
      if (base64 !== null) {
        decodedViews.push({ how: "base64", value: base64 });
      }
      const base64url = base64UrlToString(chunk);
      if (base64url !== null) {
        decodedViews.push({ how: "base64url", value: base64url });
      }
    }
  }

  for (const field of Object.keys(CONTRACT_SECRET_SENTINELS) as TokenField[]) {
    const value = CONTRACT_SECRET_SENTINELS[field];
    const seen = new Set<string>();
    const add = (how: string) => {
      if (seen.has(how)) return;
      seen.add(how);
      problems.push(`sealed cookie leaks ${field} ${how}`);
    };

    if (sealed.includes(value)) add("raw");
    if (sealed.includes(encodeURIComponent(value))) add("via url encoding");
    if (sealed.includes(stringToBase64(value))) add("via base64 encoding");
    if (
      sealed.includes(
        stringToBase64(value)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
      )
    ) {
      add("via base64url encoding");
    }

    for (const decoded of decodedViews) {
      if (decoded.value.includes(value)) {
        add(`via ${decoded.how} decoding`);
      }
    }
  }

  return problems;
}

/**
 * Check a codec implementation against the contract the encrypted cookie must
 * honor, returning a list of violations (empty means it conforms). The runtime's
 * real codec test calls this and asserts an empty result; the checker is the
 * invariant; the caller supplies the AEAD. It verifies round-trip fidelity of
 * every sealed field, that the sealed cookie does not expose the PBS tokens, that
 * a single-character tamper is rejected (the authentication tag is enforced), and
 * that garbage input fails closed instead of throwing.
 *
 * It covers the generically-constructible cases only. Two of the four fail-closed
 * cases the `SessionCookieCodec` contract names, rejecting a wrong-key blob and
 * rejecting an expired one, need a second key and a clock the contract does not
 * expose, so the concrete codec owns those tests: an empty result here means
 * "conforms on round-trip, confidentiality, tamper, and malformed input," not
 * "fully conformant."
 */
export function checkCodecContract(
  codec: SessionCookieCodec,
  sample: MemberSession,
): string[] {
  const problems: string[] = [];
  const contractSample: MemberSession = {
    ...sample,
    ...CONTRACT_SECRET_SENTINELS,
  };

  let sealed: string;
  try {
    sealed = codec.seal(contractSample);
  } catch (err) {
    return [`seal threw instead of returning a string: ${String(err)}`];
  }
  if (typeof sealed !== "string" || sealed.length === 0) {
    return ["seal must return a non-empty string"];
  }

  problems.push(...confidentialityViolations(sealed));

  const back = codec.unseal(sealed);
  if (!back) {
    problems.push("unseal of a freshly sealed session returned null");
  } else {
    // Verify every field a downstream consumer relies on, not a sample. A codec
    // that silently drops the refresh token breaks session refresh; one that
    // drops pid or membership breaks identity and entitlement. Catch all of it
    // here, before that code runs.
    const lost: string[] = [];
    if (back.pid !== contractSample.pid) lost.push("pid");
    if (back.firstName !== contractSample.firstName) lost.push("firstName");
    if (back.thumbnail !== contractSample.thumbnail) lost.push("thumbnail");
    if (back.accessToken !== contractSample.accessToken) lost.push("accessToken");
    if (back.refreshToken !== contractSample.refreshToken)
      lost.push("refreshToken");
    if (back.idToken !== contractSample.idToken) lost.push("idToken");
    if (back.issuedAt !== contractSample.issuedAt) lost.push("issuedAt");
    if (back.expiresAt !== contractSample.expiresAt) lost.push("expiresAt");
    if (back.sid !== contractSample.sid) lost.push("sid");
    if (back.membership?.status !== contractSample.membership.status)
      lost.push("membership.status");
    if (back.membership?.expireDate !== contractSample.membership.expireDate)
      lost.push("membership.expireDate");
    if (back.membership?.offer !== contractSample.membership.offer)
      lost.push("membership.offer");
    if (lost.length > 0) {
      problems.push(`round-trip did not preserve: ${lost.join(", ")}`);
    }
  }

  // Tamper rejection: a real authentication tag rejects every mutation of the
  // sealed bytes, so probe a spread of positions rather than one. A codec without
  // integrity (plain base64 of the payload, say) fails closed on most single-char
  // flips by chance -- the decode or parse breaks -- but accepts at least one that
  // still decodes to a different valid session, and that one is the whole point.
  // The contract also says unseal must never throw on bad input, so a throw on a
  // tampered blob is a violation too: in production it would surface as a 500
  // instead of a clean logout on a routine stale or tampered cookie.
  let tamperProblem: string | null = null;
  for (let i = 0; i < sealed.length; i++) {
    const replacement = sealed[i] === "A" ? "B" : "A";
    const tampered = sealed.slice(0, i) + replacement + sealed.slice(i + 1);
    if (tampered === sealed) continue;
    let out: MemberSession | null;
    try {
      out = codec.unseal(tampered);
    } catch {
      tamperProblem = "unseal threw on a tampered blob instead of returning null";
      break;
    }
    if (out !== null) {
      tamperProblem =
        "unseal accepted a tampered blob (authentication tag not enforced)";
      break;
    }
  }
  if (tamperProblem) {
    problems.push(tamperProblem);
  }

  try {
    if (codec.unseal("not-a-real-cookie") !== null)
      problems.push("unseal accepted malformed input");
  } catch {
    problems.push("unseal threw on malformed input instead of returning null");
  }

  return problems;
}
