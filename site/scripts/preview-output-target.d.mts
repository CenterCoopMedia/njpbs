export interface PreviewOutputTarget {
  readonly environment: "production" | "development";
  readonly projectId: "njpbs-site" | "njpbs-site-dev";
  readonly bucket: "njpbs-cms-previews" | "template-dev-cms-previews";
  readonly origin: "https://preview.njpbs.org" | "https://dev-preview.example.org";
}

export function previewOutputTarget(environment?: string, projectId?: string): PreviewOutputTarget;
