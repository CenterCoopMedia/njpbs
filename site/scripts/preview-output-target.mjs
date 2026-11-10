const TARGETS = Object.freeze({
  production: Object.freeze({ environment: "production", projectId: "njpbs-site",
    bucket: "njpbs-cms-previews", origin: "https://preview.njpbs.org" }),
  development: Object.freeze({ environment: "development", projectId: "njpbs-site-dev",
    bucket: "template-dev-cms-previews", origin: "https://dev-preview.example.org" }),
});

export function previewOutputTarget(environment = "production", projectId = "njpbs-site") {
  const target = TARGETS[environment];
  if (!target || target.projectId !== projectId) throw new Error("Private preview output target differs from its Firebase project");
  return target;
}
