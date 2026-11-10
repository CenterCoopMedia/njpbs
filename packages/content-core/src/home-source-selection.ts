/** Public catalog receipt. Copy stays in the current catalog; only IDs/order are saved. */
export interface HomeSelectionReceipt {
  buildBatchId: string;
  generation: number;
  commitSha: string;
  digest: string;
}
export function isHomeSelectionReceipt(value: unknown): value is HomeSelectionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 4 &&
    typeof receipt.buildBatchId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(receipt.buildBatchId) &&
    Number.isSafeInteger(receipt.generation) && Number(receipt.generation) > 0 &&
    typeof receipt.commitSha === "string" && /^[a-f0-9]{40}$/.test(receipt.commitSha) &&
    typeof receipt.digest === "string" && /^[a-f0-9]{64}$/.test(receipt.digest);
}
export function isHomeSelectedIds(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(id =>
    typeof id === "string" && !!id.trim() && id.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(id)) &&
    new Set(value).size === value.length;
}
/** Identical bytes on the server and browser, independent of object key insertion order. */
export function homeCatalogJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(homeCatalogJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${homeCatalogJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Home catalog contains invalid data.");
}
