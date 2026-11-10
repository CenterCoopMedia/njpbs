export type PublicationTarget = {
  environment: "production" | "development";
  projectId: "njpbs-site" | "njpbs-site-dev";
  workerName: "njpbs-production" | "template-dev-public";
  origin: string;
  publisherWorker: string;
  serializerId: string;
  publisherOrigin: string;
  publicationBucket: string;
  previewBucket: string;
  backgroundBucket: string;
};
export function publicationTarget(environment?: string): PublicationTarget;
export function assertPublicationTarget(value: unknown): PublicationTarget;
export function assertPublicationDatabase(firestore: { projectId?: string }, target: PublicationTarget): void;
export function publicationPostCacheTag(target: PublicationTarget, slug: string): string;
