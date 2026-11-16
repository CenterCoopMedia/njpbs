export const PAGE_READER_VERSION: 2;
export const PAGE_BLOCK_TYPES: readonly string[];
export function requiredPageReaderVersion(blocks: unknown, pageId: string): number;
export function pageReaderSupports(blocks: unknown, pageId: string, version: unknown): boolean;
