export type PublicationRuntime = { owner: "node-compute" | "cloudflare"; release: string };
export function publicationRuntime(value: unknown): PublicationRuntime;
export function runtimeFields(value: unknown): { runtime?: PublicationRuntime };
export function ownsPublication(record: Record<string, any>, runtime: PublicationRuntime): boolean;
export function samePublicationOwner(record: Record<string, any>, runtime: PublicationRuntime): boolean;
export function assertPublicationOwner(record: Record<string, any>, runtime: PublicationRuntime): void;
export function assertRuntimeSource(runtime: PublicationRuntime, commitSha: string): void;
