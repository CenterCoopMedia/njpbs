import type { CmsUserDoc } from "./principal";

export function staffOffboarding(user: CmsUserDoc) {
  const progress = user.offboarding;
  const step = progress && typeof progress === "object" && "step" in progress ? progress.step : undefined;
  if (user.active !== false) return { action: null, text: "" };
  if (step === "public_profile") return { action: "retry", text: "Finish withdrawing the public profile, disabling sign-in and revoking sessions." };
  if (step === "sign_in_and_sessions") return { action: "retry", text: "Finish disabling sign-in and revoking sessions." };
  return { action: step === "complete" ? null : "check", text: step === "complete" ? "Inactive, access removed." : "Inactive. Boardwalk access is off; account shutdown has not been verified." };
}
