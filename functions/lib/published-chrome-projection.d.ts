export type PublishedContentLink = { path: string; contentLinkMode: "custom"; contentLinkUrl: string; contentLinkNewTab: boolean; previousSlugs: string[] };
export type PublishedChromeSetting = { id: string; version: number; published: any; assets?: Record<string, any> };
export const PUBLIC_CHROME_SETTINGS_IDS: readonly string[];
export function publishedChromeSettings(records: ReadonlyMap<string, any>, options?: { strictBanner?: boolean }): PublishedChromeSetting[];
export function publishedChromeBrandAssetIds(settings: readonly PublishedChromeSetting[]): string[];
export function publishedChromePageIds(settings: readonly PublishedChromeSetting[]): string[];
export function projectPublishedChromeRecords(records: ReadonlyMap<string, any>, now: Date, options?: { strictBanner?: boolean }): {
  contentLinks?: PublishedContentLink[];
  coverageLabels?: PublishedChromeSetting;
  settings: PublishedChromeSetting[]; navigationPages: { pageId: string; path: string }[];
};
export function contentLinkDirectoryEntry(path: string, document: any): PublishedContentLink[];
