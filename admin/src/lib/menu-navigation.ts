// Keyboard movement inside an open menu, as pure arithmetic. The menu button pattern
// asks for wrapping arrow movement plus Home and End, and that rule is the same whether
// the menu is the account menu, a future overflow menu, or a test. Keeping it here means
// the component owns focus and the DOM while this owns the decision, so the rule can be
// checked without rendering anything.
//
// Escape and Tab are deliberately not menu navigation: they dismiss the menu, which is the
// component's job, not a move between items.
const NAVIGATION_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"] as const;

export type MenuNavigationKey = (typeof NAVIGATION_KEYS)[number];

export function isMenuNavigationKey(key: string): key is MenuNavigationKey {
  return (NAVIGATION_KEYS as readonly string[]).includes(key);
}

/**
 * The item index a key press moves to, or null when the press is not movement or
 * there are no items. A currentIndex of -1 means focus is not on an item yet, so
 * ArrowDown enters at the first item and ArrowUp enters at the last.
 */
export function nextMenuIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0 || !isMenuNavigationKey(key)) return null;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
    case "ArrowUp":
      return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
  }
}
