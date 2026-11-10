import {
  base64url,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FirebaseTokenError,
  verifyFirebaseIdToken,
} from "../src/firebase-auth";

const PROJECT = "njpbs-site";
const NOW_SECONDS = 1_786_656_000;
const HMAC_SECRET = new TextEncoder().encode("test-secret-with-at-least-32-characters");
let keySet: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  keySet = createLocalJWKSet({
    keys: [
      {
        ...(await exportJWK(pair.publicKey)),
        alg: "RS256",
        kid: "test-key",
        use: "sig",
      },
    ],
  });
});

async function token(overrides: {
  audience?: string;
  authTime?: number;
  claims?: Record<string, unknown>;
  expiresAt?: number;
  issuedAt?: number;
  issuer?: string;
  subject?: string;
} = {}) {
  return new SignJWT({ ...overrides.claims, auth_time: overrides.authTime ?? NOW_SECONDS - 60 })
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
    .setIssuer(overrides.issuer ?? `https://securetoken.google.com/${PROJECT}`)
    .setAudience(overrides.audience ?? PROJECT)
    .setSubject(overrides.subject ?? "editor-1")
    .setIssuedAt(overrides.issuedAt ?? NOW_SECONDS - 60)
    .setExpirationTime(overrides.expiresAt ?? NOW_SECONDS + 3_600)
    .sign(privateKey);
}

async function hmacToken() {
  return new SignJWT({ auth_time: NOW_SECONDS - 60 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(`https://securetoken.google.com/${PROJECT}`)
    .setAudience(PROJECT)
    .setSubject("editor-1")
    .setIssuedAt(NOW_SECONDS - 60)
    .setExpirationTime(NOW_SECONDS + 3_600)
    .sign(HMAC_SECRET);
}

describe("Firebase ID-token verification", () => {
  it("accepts a signed token with the exact Firebase claims", async () => {
    await expect(
      verifyFirebaseIdToken(await token(), PROJECT, {
        currentDate: new Date(NOW_SECONDS * 1_000),
        keySet,
      }),
    ).resolves.toEqual({ uid: "editor-1", authTime: NOW_SECONDS - 60 });
  });

  it.each([
    [{ audience: "other-project" }, "audience"],
    [{ issuer: "https://securetoken.google.com/other-project" }, "issuer"],
    [{ expiresAt: NOW_SECONDS - 60 }, "expiry"],
    [{ authTime: NOW_SECONDS + 60 }, "future auth time"],
    [{ issuedAt: NOW_SECONDS + 60 }, "future issued time"],
    [{ subject: "" }, "subject"],
  ])("rejects a token with the wrong claims", async (overrides, _label) => {
    await expect(
      verifyFirebaseIdToken(await token(overrides), PROJECT, {
        currentDate: new Date(NOW_SECONDS * 1_000),
        keySet,
      }),
    ).rejects.toBeInstanceOf(FirebaseTokenError);
  });

  it("accepts a session 59 days after sign-in and refuses one at 60 days", async () => {
    const days = (count: number) => NOW_SECONDS - count * 24 * 60 * 60;
    const verify = async (authTime: number) => verifyFirebaseIdToken(await token({ authTime }), PROJECT, {
      currentDate: new Date(NOW_SECONDS * 1_000),
      keySet,
    });
    await expect(verify(days(59))).resolves.toMatchObject({ authTime: days(59) });
    await expect(verify(days(60))).rejects.toBeInstanceOf(FirebaseTokenError);
  });

  it("keeps a studio device identity outside the staff session limit", async () => {
    const authTime = NOW_SECONDS - 90 * 24 * 60 * 60;
    await expect(verifyFirebaseIdToken(await token({
      authTime,
      claims: { liveProductionDeviceId: "device-1" },
      subject: "vmix_device-1",
    }), PROJECT, { currentDate: new Date(NOW_SECONDS * 1_000), keySet })).resolves.toMatchObject({ uid: "vmix_device-1", deviceIdentity: true });
  });

  it("rejects a token that uses an unapproved signing algorithm", async () => {
    await expect(
      verifyFirebaseIdToken(await hmacToken(), PROJECT, {
        currentDate: new Date(NOW_SECONDS * 1_000),
        keySet,
      }),
    ).rejects.toBeInstanceOf(FirebaseTokenError);
  });

  it("rejects malformed tokens and tokens with no matching signing key", async () => {
    for (const [value, keys] of [
      ["not-a-jwt", keySet],
      [await token(), createLocalJWKSet({ keys: [] })],
    ] as const) {
      await expect(verifyFirebaseIdToken(value, PROJECT, {
        currentDate: new Date(NOW_SECONDS * 1_000),
        keySet: keys,
      })).rejects.toBeInstanceOf(FirebaseTokenError);
    }
  });

  it.each([
    { alg: "RS256", typ: "JWT" },
    { alg: "RS256", kid: "test-key", typ: "JWT", crit: ["unsupported"], unsupported: true },
  ])("rejects token-specific key and critical-header failures: %j", async header => {
    const [, payload, signature] = (await token()).split(".");
    const malformed = [base64url.encode(JSON.stringify(header)), payload, signature].join(".");
    const keys = keySet.jwks().keys;
    const multipleKeys = createLocalJWKSet({ keys: [...keys, { ...keys[0], kid: "second-key" }] });
    await expect(verifyFirebaseIdToken(malformed, PROJECT, {
      currentDate: new Date(NOW_SECONDS * 1_000), keySet: multipleKeys,
    })).rejects.toBeInstanceOf(FirebaseTokenError);
  });

  it("rejects a token whose signature does not match the signing key", async () => {
    const { publicKey } = await generateKeyPair("RS256", { extractable: true });
    const wrongKeySet = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "test-key", use: "sig" }],
    });
    await expect(verifyFirebaseIdToken(await token(), PROJECT, {
      currentDate: new Date(NOW_SECONDS * 1_000),
      keySet: wrongKeySet,
    })).rejects.toBeInstanceOf(FirebaseTokenError);
  });
});
