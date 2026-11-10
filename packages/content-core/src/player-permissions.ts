// Cross-origin PBS player permissions are part of the security boundary, not
// presentation copy. The GA livestream needs location for PBS's market rules;
// an on-demand Partner Player does not. Keep the distinction typed so a future
// embed cannot inherit geolocation merely by sharing the same iframe component.
export type PbsPlayerKind = "livestream" | "on-demand";

const PLAYER_PERMISSIONS = {
  livestream: "geolocation; encrypted-media",
  "on-demand": "encrypted-media",
} as const satisfies Record<PbsPlayerKind, string>;

export function pbsPlayerPermissions(kind: PbsPlayerKind): string {
  return PLAYER_PERMISSIONS[kind];
}
