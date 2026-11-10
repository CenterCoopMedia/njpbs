export type PreviewStorageCredential = { accessKeyId: string; secretAccessKey: string };

export function parsePreviewStorageCredential(value: string): PreviewStorageCredential {
  if (Buffer.byteLength(value) > 4096) throw new Error("Invalid private preview storage credential");
  let credential: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      credential = parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error("Invalid private preview storage credential");
  }
  const accessKeyId = credential?.accessKeyId;
  const secretAccessKey = credential?.secretAccessKey;
  if (!credential
    || Object.keys(credential).sort().join(",") !== "accessKeyId,secretAccessKey"
    || typeof accessKeyId !== "string" || !/^[A-Za-z0-9]{16,128}$/.test(accessKeyId)
    || typeof secretAccessKey !== "string" || !/^[A-Za-z0-9/+=]{32,128}$/.test(secretAccessKey)) {
    throw new Error("Invalid private preview storage credential");
  }
  return { accessKeyId, secretAccessKey };
}
