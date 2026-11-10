const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function findExactRecentWorkerVersion(
  value: unknown,
  tag: string,
  message: string,
): string | null {
  if (!Array.isArray(value)) {
    throw new Error("The Wrangler version list receipt is invalid");
  }
  const tagged = value.filter(
    (entry) => entry?.annotations?.["workers/tag"] === tag,
  );
  if (tagged.length === 0) return null;
  if (
    tagged.length !== 1 ||
    tagged[0]?.annotations?.["workers/message"] !== message ||
    !CLOUDFLARE_UUID.test(tagged[0]?.id)
  ) {
    throw new Error("The public Worker version tag conflicts with another upload");
  }
  return tagged[0].id.toLowerCase();
}
