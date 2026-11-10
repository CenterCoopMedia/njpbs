export type MediaAssetRef =
  | { backend: "r2"; id: string }
  | { backend: "s3"; sourceId: string; id: string };

export type R2MediaAssetRef = Extract<MediaAssetRef, { backend: "r2" }>;
export type S3MediaAssetRef = Extract<MediaAssetRef, { backend: "s3" }>;
