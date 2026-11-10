export const PAGE_READER_VERSION: 1;
export const PAGE_BLOCK_TYPES: readonly string[];
export function requiredPageReaderVersion(blocks: unknown, pageId: string): number;
export function pageReaderSupports(blocks: unknown, pageId: string, version: unknown): boolean;
