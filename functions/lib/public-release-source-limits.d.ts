export const HISTORICAL_CHANGE_LIMIT: number;
export type HistoricalSourceMetric = "changes" | "rootFiles" | "censusBytes";
export type HistoricalSourceMeasure = "transactionMs" | "readMs";
export class HistoricalSourceLimitError extends Error {
 constructor(metric: HistoricalSourceMetric, used: number);
 code: string; details: { metric: HistoricalSourceMetric; used: number; limit: number };
}
export function isHistoricalSourceLimitError(value: unknown): value is HistoricalSourceLimitError;
export function checkHistoricalSourceLimit(metric: HistoricalSourceMetric, used: number): void;
export function historicalSourceHeadroom(usage?: Partial<Record<HistoricalSourceMetric | HistoricalSourceMeasure, number | null>>): {
 schemaVersion: 1; kind: "historical-source-headroom";
 checks: Record<HistoricalSourceMetric, { used: number | null; limit: number; remaining: number | null; percent: number | null; warning: boolean; exceeded: boolean }> &
  Record<HistoricalSourceMeasure, { used: number | null; limit: null; remaining: null; percent: null; warning: false; exceeded: false }>;
 warnings: HistoricalSourceMetric[];
};
export function historicalSourceReadBudget(): { read<T>(operation: () => Promise<T>): Promise<T>;
 usage(): { transactionMs: number; readMs: number } };
export function createHistoricalSourceInventory<T extends { bytes: Uint8Array }>(entries?: Iterable<readonly [string, T]>): Map<string, T>;
export function encodeHistoricalSourceCensus(value: unknown): Uint8Array;
