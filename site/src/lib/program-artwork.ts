/** Suppress the known incorrect logo only on its mismatched program page.
 * Replacement artwork and the same logo on its matching program remain available.
 */
export function isIncorrectProgramArtwork(
  canonicalPath: string,
  artwork: { assetId: string } | null | undefined,
): boolean {
  return canonicalPath === "/programs/state-of-the-arts/" &&
    artwork?.assetId === "8ba39d8d-adc2-47d9-af5f-c07dcdf3f10b";
}
