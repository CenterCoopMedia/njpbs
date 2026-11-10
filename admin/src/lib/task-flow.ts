// The canonical editorial task flow: the one repeatable path #1036 is measured against.
//
// The Aug. 20 acceptance addition asks that the hierarchy work be judged as task-flow performance
// rather than as a restyling — open a post, edit a paragraph, add or select media, save, and
// return to the originating list, recording elapsed time, wrong turns and recovery actions. The
// path is held here as data so the walk that drives it reads its stages and budgets from source
// instead of from numbers typed into one test, and so a later slice that adds a step to the path
// has to change the declared budget in the open rather than quietly absorbing it.
//
// An activation is one deliberate pointer or key action: a click, or the key that stands in for
// it. Typing into a field the caret already sits in is not an activation, and neither is reading.
// Component editing uses three deliberate actions: open its editor, focus the paragraph,
// then choose Done to return to the canvas. Other stages keep their direct controls.
// Additional navigation or recovery actions remain outside the declared budget.
//
// Pure: no React and no router import, so the contract is readable on its own.

export type TaskFlowStageId = "open" | "edit" | "media" | "save" | "return";

export interface TaskFlowStage {
  id: TaskFlowStageId;
  // What the person is doing at this point on the path, in their words rather than the code's.
  label: string;
  // The deliberate activations this stage may cost.
  activationBudget: number;
}

export const EDITORIAL_TASK_FLOW: readonly TaskFlowStage[] = [
  { id: "open", label: "Open a post from the list", activationBudget: 1 },
  { id: "edit", label: "Edit a paragraph", activationBudget: 3 },
  { id: "media", label: "Add or select media", activationBudget: 2 },
  { id: "save", label: "Save", activationBudget: 1 },
  { id: "return", label: "Return to the originating list", activationBudget: 1 },
] as const;

export function taskFlowStage(id: TaskFlowStageId): TaskFlowStage {
  const stage = EDITORIAL_TASK_FLOW.find((candidate) => candidate.id === id);
  if (!stage) {
    throw new Error(`"${id}" is not on the canonical editorial task flow.`);
  }
  return stage;
}

// What the whole path may cost. A walk that needs more than this has grown a wrong turn or a
// recovery action, which is the regression the criterion is written to catch.
export function taskFlowActivationBudget(): number {
  return EDITORIAL_TASK_FLOW.reduce(
    (total, stage) => total + stage.activationBudget,
    0,
  );
}
