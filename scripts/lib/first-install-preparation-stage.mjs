// Typed stage tags carry no original exception, provider body or input value.
export class FirstInstallPreparationStageError extends Error {
  constructor(stage) { super('First-install preparation refused'); this.stage = stage; }
}
export async function atFirstInstallPreparationStage(stage, run) {
  try { return await run(); }
  catch { throw new FirstInstallPreparationStageError(stage); }
}
