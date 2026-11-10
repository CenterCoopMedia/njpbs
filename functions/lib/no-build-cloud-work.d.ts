export function retryDue(value: unknown, now: number): boolean;
export function cloudBillingPaused(input: { read(path: string): Promise<Record<string, any> | null>; runtime?: { owner: string; release: string } }): Promise<boolean>;
export function previewContextDue(queue: Record<string, any>, pointer: Record<string, any>, now?: number, claimMasked?: boolean, preparation?: Record<string, any> | null): boolean;
export function publicContextProgressAt(input: {
  aggregate: Record<string, any> | null | undefined;
  queue: Record<string, any> | null | undefined;
  preparation: Record<string, any> | null | undefined;
  runtime: { owner: "cloudflare"; release: string };
  now: number;
  retainProgress?: boolean;
}): number | null;
type CloudPostWorkInput = {
  read(path: string): Promise<Record<string, any> | null>;
  listOwners?(): Promise<Record<string, any>[]>;
  runtime: { owner: "cloudflare"; release: string };
  now?: number;
};
export function activeCloudPostStates(input: CloudPostWorkInput): Promise<Record<string, any>[]>;
export function currentCloudPostStates(input: CloudPostWorkInput): Promise<Record<string, any>[]>;
export function readNoBuildCloudWork(input: CloudPostWorkInput): Promise<{ maintenance: boolean; reconcile: boolean; previewContext?: boolean }>;
