import type { Page } from "@playwright/test";

export interface CmsNetworkCall {
  endpoint: string;
  requestEpoch: number;
  status: number;
  failed?: boolean;
  durationMs?: number;
  ttfbMs?: number;
  bytes?: number;
  serverTiming?: { name: string; durationMs: number }[] | null;
}

export function createCmsNetworkCapture(page: Page): {
  start(): void;
  finish(): Promise<{
    captureEpoch: number;
    calls: CmsNetworkCall[];
    carryInCalls: CmsNetworkCall[];
  }>;
};
