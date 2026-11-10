import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BOARDWALK_TIPS, pickBoardwalkTipIndex } from "../src/lib/boardwalk-tips";

it("keeps all 48 tips exact and makes every other tip reachable without an immediate repeat", () => {
  expect(BOARDWALK_TIPS).toHaveLength(48);
  expect(BOARDWALK_TIPS.map(tip => tip.label)).toEqual(
    Array.from({ length: 48 }, (_, i) => `BOARDWALK TIP NO. ${i + 1}`),
  );
  // Pins all tip copy.
  expect(createHash("sha256").update(JSON.stringify(BOARDWALK_TIPS)).digest("hex"))
    .toBe("2454f69734c84c7fc2e82ccfd3038ab30aaf065ab25251b641335cbb9253055b");
  const random = vi.spyOn(Math, "random");
  try {
    for (let previous = 0; previous < 48; previous++) {
      random.mockReturnValue((previous + 0.5) / 48);
      expect(pickBoardwalkTipIndex()).toBe(previous);
      const choices = new Set<number>();
      for (let draw = 0; draw < 47; draw++) {
        random.mockReturnValue((draw + 0.5) / 47);
        const next = pickBoardwalkTipIndex(previous);
        expect(next).not.toBe(previous);
        expect(BOARDWALK_TIPS[next]).toBeDefined();
        choices.add(next);
      }
      expect(choices.size).toBe(47);
    }
  } finally {
    random.mockRestore();
  }
});
