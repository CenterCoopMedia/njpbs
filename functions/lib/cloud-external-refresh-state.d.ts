import type { PublicationRuntime } from "./publication-runtime-owner";

export const EXTERNAL_REFRESH_PATH: string;
export const EXTERNAL_INPUT_FILES: readonly string[];
export interface ExternalRefreshHold { operationId: string; startedAt: number; until: number }
export function externalRefreshHold(state: unknown, now?: number): ExternalRefreshHold | null;
export function externalRefreshHeld(state: unknown, now?: number): boolean;
export function externalRefreshDue(state: unknown, runtime: PublicationRuntime, now?: number): boolean;
export function nextExternalRefreshAt(now: number): number;
