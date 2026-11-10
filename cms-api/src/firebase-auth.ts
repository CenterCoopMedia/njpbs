import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
  {
    cacheMaxAge: 60 * 60 * 1_000,
    cooldownDuration: 5 * 60 * 1_000,
    timeoutDuration: 5_000,
  },
);

// Firebase refresh tokens have no end date. Measured from auth_time, so a token refresh does not
// extend a session. firestore.rules and functions/lib/session-refusal.js hold the same limit.
export const MAX_SESSION_AGE_SECONDS = 60 * 24 * 60 * 60;

export class FirebaseTokenError extends Error {
  constructor(message = "Invalid or expired authentication token", readonly reason?: "token_expired") {
    super(message);
    this.name = "FirebaseTokenError";
  }
}

export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  options: {
    currentDate?: Date;
    keySet?: JWTVerifyGetKey;
  } = {},
): Promise<{ uid: string; authTime?: number; deviceIdentity?: true }> {
  try {
    const currentDate = options.currentDate ?? new Date();
    const keySet = options.keySet ?? FIREBASE_JWKS;
    const getKey: JWTVerifyGetKey = async (header, jwt) => {
      // A warm remote set skips the network for an unknown key during cooldown.
      // That miss cannot establish that a newly rotated signing key is invalid.
      const unchecked = "fresh" in keySet && keySet.fresh === true &&
        "coolingDown" in keySet && keySet.coolingDown === true;
      try {
        return await keySet(header, jwt);
      } catch (error) {
        if (unchecked && error instanceof errors.JWKSNoMatchingKey) {
          throw new Error("The signing key has not been checked against fresh keys");
        }
        throw error;
      }
    };
    const { payload } = await jwtVerify(token, getKey, {
      algorithms: ["RS256"],
      audience: projectId,
      clockTolerance: 5,
      currentDate,
      issuer: `https://securetoken.google.com/${projectId}`,
      requiredClaims: ["sub", "iat", "exp", "auth_time"],
    });
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      payload.sub.length > 128
    ) {
      throw new FirebaseTokenError();
    }
    if (
      typeof payload.auth_time !== "number" ||
      payload.auth_time > Math.floor(currentDate.getTime() / 1_000) + 5
    ) {
      throw new FirebaseTokenError();
    }
    // A studio connector holds a server-issued device identity, not a staff sign-in. Its refresh
    // keeps the first auth_time, and it has no person to sign in again.
    if (
      typeof payload.liveProductionDeviceId !== "string" &&
      currentDate.getTime() / 1_000 - payload.auth_time >= MAX_SESSION_AGE_SECONDS
    ) {
      throw new FirebaseTokenError();
    }
    if (
      typeof payload.iat !== "number" ||
      payload.iat > Math.floor(currentDate.getTime() / 1_000) + 5
    ) {
      throw new FirebaseTokenError();
    }
    return { uid: payload.sub, authTime: payload.auth_time,
      ...(typeof payload.liveProductionDeviceId === "string" ? { deviceIdentity: true as const } : {}) };
  } catch (error) {
    if (error instanceof FirebaseTokenError) throw error;
    if (error instanceof errors.JWTExpired) throw new FirebaseTokenError(undefined, "token_expired");
    // JWKS transport, parsing and key configuration errors are retryable service
    // failures. Only token-specific JOSE errors mean the staff must sign in.
    if (
      error instanceof errors.JWTClaimValidationFailed ||
      error instanceof errors.JOSEAlgNotAllowed ||
      error instanceof errors.JWSInvalid ||
      error instanceof errors.JWTInvalid ||
      error instanceof errors.JOSENotSupported ||
      error instanceof errors.JWKSMultipleMatchingKeys ||
      error instanceof errors.JWSSignatureVerificationFailed ||
      error instanceof errors.JWKSNoMatchingKey
    ) throw new FirebaseTokenError();
    throw error;
  }
}
