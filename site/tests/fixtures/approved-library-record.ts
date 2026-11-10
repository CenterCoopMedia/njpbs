/** Resolved history fixture; literal expected values live in each contract test. */
export function approvedLibraryRecord<T extends Record<string, unknown>>(metadata: T) {
  const version = typeof metadata.version === "number" ? metadata.version : 1;
  return {
    ...metadata, version,
    approvedLibraryVersion: { ...structuredClone(metadata), status: "approved", version },
  };
}
