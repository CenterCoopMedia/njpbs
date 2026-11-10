export const CONSUMER_GATES: readonly ["docs", "site", "admin", "firebase"];

export type CiGateSelection = Record<(typeof CONSUMER_GATES)[number], boolean>;

export function normalizeRepoPath(value: unknown): string | null;
export function classifyPath(value: unknown): CiGateSelection | null;
export function classifyChangedPaths(changedPaths: unknown): {
  gates: CiGateSelection;
  classification: "exact" | "fallback";
  reason: string | null;
};
export function readExactChangedPaths(options: {
  baseSha?: string;
  headRef?: string;
  pullRequestHeadSha?: string;
  pullRequestBaseRef?: string;
  cwd?: string;
}): string[];
export function evaluateFinalAggregation(options: {
  classifierResult?: string;
  selectedGates?: Partial<
    Record<(typeof CONSUMER_GATES)[number], boolean | string>
  >;
  results?: Partial<Record<(typeof CONSUMER_GATES)[number] | "policy", string>>;
}): { ok: true; fallback: boolean };
export function main(argv?: string[]): void;
