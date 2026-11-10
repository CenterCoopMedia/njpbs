import { can, type Principal } from "../../../packages/content-core/src/rbac";

export function liveProductionEnabled(): boolean {
  return import.meta.env.VITE_LIVE_PRODUCTION_ENABLED === "true";
}

// Match cmsLiveProduction's existing global staff capability; no new role.
export function canUseLiveProduction(principal: Principal): boolean {
  return liveProductionEnabled() && can(principal, "content.edit.any");
}
