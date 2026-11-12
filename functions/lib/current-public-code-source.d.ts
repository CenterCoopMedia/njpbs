import type { CurrentCodeReference } from "./current-public-code-reference";
export { validateCurrentCodeReference, type CurrentCodeReference } from "./current-public-code-reference";
export function createCurrentCodeTransport(options: import("./current-public-code-v2").PairCodeTransportOptions): ReturnType<
  typeof import("./current-public-code-v2").createPairCurrentCodeTransport>;
export function createCurrentCodeTransport(options: { target: import("./publication-target").PublicationTarget; rendererSha: string;
  request?: typeof fetch; readSecret?: () => string }): { readCurrentCode(): Promise<{ reference: CurrentCodeReference; bytes: Buffer }>;
  readCurrentCodeReference(): Promise<CurrentCodeReference> };
