// Which toolbar items stay visible and which move into the More menu, as pure arithmetic.
// Higher priority stays visible longer; within the
// result both lists keep document order so controls never swap places as the width changes.

export interface OverflowCandidate {
  key: string;
  width: number;
  priority: number;
}

export interface OverflowResult {
  visible: string[];
  overflow: string[];
}

export function fitToolbarItems(
  items: readonly OverflowCandidate[],
  available: number,
  gap: number,
  moreWidth: number,
): OverflowResult {
  const measured = items.every((item) => Number.isFinite(item.width));
  const total = items.reduce((sum, item, index) => sum + item.width + (index > 0 ? gap : 0), 0);
  if (measured && total <= available) {
    return { visible: items.map((item) => item.key), overflow: [] };
  }

  const budget = available - moreWidth - gap;
  const byPriority = items
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  const kept = new Set<string>();
  let used = 0;
  for (const item of byPriority) {
    const cost = item.width + (kept.size > 0 ? gap : 0);
    if (!Number.isFinite(cost) || used + cost > budget) break;
    kept.add(item.key);
    used += cost;
  }

  return {
    visible: items.filter((item) => kept.has(item.key)).map((item) => item.key),
    overflow: items.filter((item) => !kept.has(item.key)).map((item) => item.key),
  };
}
