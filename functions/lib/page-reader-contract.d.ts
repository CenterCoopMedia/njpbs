export const PAGE_READER_VERSION: 3;
export const PAGE_BLOCK_TYPES: readonly string[];
export function isPageReaderVersion(version: unknown): version is 1 | 2 | 3;
export function requiredPageReaderVersion(blocks: unknown, pageId: string, scheduleCopy?: unknown): number;
export function pageReaderSupports(blocks: unknown, pageId: string, version: unknown, scheduleCopy?: unknown): boolean;
