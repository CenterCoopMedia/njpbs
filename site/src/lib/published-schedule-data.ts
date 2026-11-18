/** Public page projection requires its qualified schedule context upstream. */
export function loadScheduleData(): never {
  throw new Error("Qualified schedule data is required");
}
