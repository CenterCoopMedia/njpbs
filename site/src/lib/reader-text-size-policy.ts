import { isKidsPath } from "./analytics-page-policy";

/** The public layout supplies its full child-directed metadata decision. */
export function readerTextSizeEnabled(pathname: string, childDirected = false): boolean {
  return pathname.split("/").filter(Boolean).length > 0 &&
    !childDirected && !isKidsPath(pathname);
}
