/** Child-directed pages stay outside the consent loader, including aliases. */
export function isKidsPath(path: string | undefined): boolean {
  if (!path) return false;
  try {
    return decodeURIComponent(path).toLowerCase().split(/[/?#]/).includes("kids");
  } catch {
    return true; // A malformed route must not enable tracking.
  }
}

export function isChildDirectedPage(input: {
  path: string;
  canonicalPath?: string;
  pageId?: string;
  childDirected?: boolean;
}): boolean {
  return input.childDirected === true || input.pageId === "kids" ||
    isKidsPath(input.path) || isKidsPath(input.canonicalPath);
}
