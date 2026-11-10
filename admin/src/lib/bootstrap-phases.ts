// The phases a person waits through between opening admin.njpbs.org and seeing a workspace,
// in the order they run, with the work each one does. The bootstrap screen renders this as a
// checklist that tracks the real auth state (AuthContext dispatches the stage it is in), and
// decorative Boardwalk tips stay separate from that real progress.
//
// Every line here describes something the code does. Keep it that way: the screen exists to
// tell staff what the wait is, not to keep them company with invented progress.

export type BootstrapStage = "session" | "admission" | "profile" | "workspace";

export interface BootstrapPhase {
  stage: BootstrapStage;
  // The checklist line.
  title: string;
  // What the phase does. These are descriptions, not measured sub-stage progress.
  details: readonly string[];
}

export const BOOTSTRAP_PHASES: readonly BootstrapPhase[] = [
  {
    stage: "session",
    title: "Restoring your sign-in",
    details: [
      "Connecting to Firebase Authentication",
      "Checking this browser for a saved session",
      "Starting the download of your workspace code",
    ],
  },
  {
    stage: "admission",
    title: "Confirming staff access",
    details: [
      "Sending your identity token to the CMS API",
      "Checking your staff profile and active status",
      "Recording the sign-in for the audit log",
    ],
  },
  {
    stage: "profile",
    title: "Loading your profile and permissions",
    details: [
      "Subscribing to your staff profile in Firestore",
      "Applying your roles and area grants",
    ],
  },
  {
    stage: "workspace",
    title: "Opening your workspace",
    details: [
      "Loading the code for this workspace",
      "Building your rail",
    ],
  },
];

export type BootstrapPhaseState = "done" | "active" | "pending";

export interface BootstrapPhaseView extends BootstrapPhase {
  state: BootstrapPhaseState;
}

export function bootstrapStageIndex(stage: BootstrapStage): number {
  return BOOTSTRAP_PHASES.findIndex((phase) => phase.stage === stage);
}

// The checklist for a stage: everything before it is done, it is active, the rest waits.
export function bootstrapPhaseViews(stage: BootstrapStage): BootstrapPhaseView[] {
  const activeIndex = bootstrapStageIndex(stage);
  return BOOTSTRAP_PHASES.map((phase, index) => ({
    ...phase,
    state: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending",
  }));
}

export function bootstrapPhase(stage: BootstrapStage): BootstrapPhase {
  return BOOTSTRAP_PHASES[bootstrapStageIndex(stage)];
}

// After this long on one screen the wait is no longer ordinary and the person deserves a
// sentence about it, not only a glyph that keeps turning.
export const BOOTSTRAP_SLOW_AFTER_MS = 8000;
