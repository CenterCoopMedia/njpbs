export type InstalledConsumerSourceFile = Readonly<{ path: string; sha256: string }>;
export type InstalledConsumerProbe = Readonly<{ schemaVersion: 2; kind: "public-release-installed-consumers";
  nonce: string; revision: string; files: readonly InstalledConsumerSourceFile[]; sourceDigest: string;
  flags: Readonly<{ PUBLIC_RELEASE_READERS_ENABLED: boolean; PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: boolean }> }>;
export const INSTALLED_CONSUMER_FILES: readonly string[];
export const FLAGS: readonly string[];
export function installedConsumerSourceFiles(read?: (path: string) => Uint8Array): InstalledConsumerSourceFile[];
export function installedPublicReleaseConsumers(input?: { nonce?: string; environment?: Record<string, string | undefined>;
  read?: (path: string) => Uint8Array }): InstalledConsumerProbe;
