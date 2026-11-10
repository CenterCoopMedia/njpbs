export interface GuideVideoPlanItem {
  member: string;
  key: string;
  contentType: string;
}

export interface GuideVideoUploadFile {
  key: string;
  size: number;
  sha256: string;
}

export function guideTranscriptFiles(
  markdown: string,
  videos: Array<{ id: string; title: string }>,
): Array<GuideVideoUploadFile & { body: string; contentType: string }>;

export interface GuideVideoUploadClient {
  // Read the stored body and return its measured size and SHA-256, not metadata.
  head: (key: string) => Promise<{ size: number; sha256: string } | null>;
  put: (file: GuideVideoUploadFile) => Promise<void>;
}

export function planGuideVideoUpload(
  memberNames: string[],
  videos: Array<{ id: string }>,
): GuideVideoPlanItem[];

export function tarExtractArgs(archive: string, directory: string, members: string[]): string[];

export function containedGuideFile(root: string, member: string): Promise<string>;

export function guideVideoObjectMatches(
  existing: { size: number; sha256: string } | null,
  size: number,
  sha256: string,
): boolean;

export function guideVideoReleaseId(files: Array<{ key: string; sha256: string }>): string;

export function versionedGuideVideoKey(release: string, key: string): string;

export function publishGuideVideoRelease(
  files: GuideVideoUploadFile[],
  client: GuideVideoUploadClient,
): Promise<string>;

export function putGuideVideoObjects(
  files: GuideVideoUploadFile[],
  client: GuideVideoUploadClient,
): Promise<{ uploaded: string[]; skipped: string[] }>;
