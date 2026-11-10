export function clipExportMessage(error: unknown): string | null {
  const failure = error as { status?: number; data?: { code?: string }; message?: string } | null;
  if (failure?.status !== 429 || typeof failure.message !== "string") return null;
  if (failure.data?.code === "clip_export_quota") return failure.message;
  if (failure.message === "Wait for your current clip export to finish") return "You already have an active clip export. Check your recent exports and its saved status before starting another.";
  if (failure.message === "Wait for the current original-range extraction to finish") return "Wait for the current original-range extraction to finish, then try again.";
  return null;
}
