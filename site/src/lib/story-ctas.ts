import type { PageBlock } from "../../../packages/content-core/src/content-model";
import { insertStoryCtas } from "../../../packages/content-core/src/story-cta-rules";
import { isStoryCtasBuildData } from "../../../packages/content-core/src/story-ctas";

/** Accept projected public settings only; working settings are never render inputs. */
export function storyCtaComposition(blocks: readonly PageBlock[], settings: readonly unknown[], liveBlog = false): {
  body: PageBlock[]; afterUpdates: PageBlock[];
} {
  const registry = settings.find(isStoryCtasBuildData);
  const rules = registry?.rules ?? [];
  return liveBlog
    ? { body: insertStoryCtas(blocks, rules.filter(rule => rule.position.kind !== "end")),
      afterUpdates: insertStoryCtas(blocks, rules.filter(rule => rule.position.kind === "end")).slice(blocks.length) }
    : { body: insertStoryCtas(blocks, rules), afterUpdates: [] };
}
