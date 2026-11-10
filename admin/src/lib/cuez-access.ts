import { canAccessMediaWorkspace, canUseContentStudio } from "./access";
import type { Principal } from "../../../packages/content-core/src/rbac";

export const canUseCuez = (principal: Principal): boolean => canAccessMediaWorkspace(principal) || canUseContentStudio(principal);
