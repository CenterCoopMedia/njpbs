export const HISTORICAL_CHANGE_LIMIT: number;
export const HISTORICAL_TRANSACTION_MS: number;
export const HISTORICAL_READ_MS: number;
export type HistoricalSourceMetric = "changes" | "transactionMs" | "readMs" | "rootFiles" | "censusBytes";
export class HistoricalSourceLimitError extends Error {
 constructor(metric: HistoricalSourceMetric, used: number);
 code: string; details: { metric: HistoricalSourceMetric; used: number; limit: number };
}
export function isHistoricalSourceLimitError(value: unknown): value is HistoricalSourceLimitError;
export function checkHistoricalSourceLimit(metric: HistoricalSourceMetric, used: number): void;
export function historicalSourceHeadroom(usage?: Partial<Record<HistoricalSourceMetric, number | null>>): {
 schemaVersion: 1; kind: "historical-source-headroom";
 checks: Record<HistoricalSourceMetric, { used: number | null; limit: number; remaining: number | null; percent: number | null; warning: boolean; exceeded: boolean }>;
 warnings: HistoricalSourceMetric[];
};
export function historicalSourceReadBudget(): { check(): void; read<T>(operation: () => Promise<T>): Promise<T>;
 usage(): { transactionMs: number; readMs: number } };
export function createHistoricalSourceInventory<T extends { bytes: Uint8Array }>(entries?: Iterable<readonly [string, T]>): Map<string, T>;
export function encodeHistoricalSourceCensus(value: unknown): Uint8Array;
