export type MeteredApiViolation = {
  rule: "metered-api-host" | "metered-api-sdk" | "markdownlint-module-hook";
  match: string;
};

export type MeteredApiOffender = {
  file: string;
  violations: MeteredApiViolation[];
};

export const SITE_SCAN_ROOTS: readonly string[];
export const REPO_SCAN_ROOTS: readonly string[];
export const SCANNED_MANIFESTS: readonly string[];
export const SCANNED_MARKDOWNLINT_CONFIGS: readonly string[];
export type SourceScanOptions = {
  strictLayout?: boolean;
  excludedRoots?: string[];
};
export function findMeteredApiViolations(source: string): MeteredApiViolation[];
export function findPackageScriptViolations(
  source: string,
): MeteredApiViolation[];
export function findMarkdownlintConfigViolations(
  source: string,
): MeteredApiViolation[];
export function isMeteredApiScanTarget(relPath: string): boolean;
export function isMarkdownlintConfigPath(relPath: string): boolean;
export function scanRepositorySourceFiles(
  repoRoot: string,
  excludedRoots?: string[],
): string[];
export function scanMarkdownlintConfigFiles(
  repoRoot: string,
  excludedRoots?: string[],
): string[];
export function scanPackageManifestFiles(
  repoRoot: string,
  excludedRoots?: string[],
): string[];
export function scanFilesUnder(
  base: string,
  label: string,
  listName: string,
  root: string,
): string[];
export function scanSiteRootFiles(siteRoot: string): string[];
export function meteredOffenders(
  base: string,
  relPaths: string[],
): MeteredApiOffender[];
export function manifestOffenders(
  base: string,
  relPaths: string[],
): MeteredApiOffender[];
export function markdownlintConfigOffenders(
  base: string,
  relPaths: string[],
): MeteredApiOffender[];
export function runSourceScan(
  repoRoot: string,
  options?: SourceScanOptions,
): number;
