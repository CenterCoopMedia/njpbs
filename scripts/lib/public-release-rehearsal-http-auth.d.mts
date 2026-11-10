declare const credentialBrand: unique symbol;
export type RehearsalHttpCredential = Readonly<{ [credentialBrand]: true }>;
export function createRehearsalHttpCredential(): RehearsalHttpCredential;
export function bindRehearsalHttpCredential(credential: RehearsalHttpCredential, origins: readonly string[]): void;
export function hasRehearsalHttpCredential(value: unknown, origins?: readonly string[]): value is RehearsalHttpCredential;
export function rehearsalHttpHeaders(credential: RehearsalHttpCredential, origin: string): { authorization: string };
export function acceptRehearsalHttpAuthorization(credential: RehearsalHttpCredential, origin: string, value: unknown): boolean;
export function closeRehearsalHttpCredential(credential: RehearsalHttpCredential): void;
