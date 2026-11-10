import { useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { createCuezApi } from "../lib/cuez-transfers";
import { canUseCuez } from "../lib/cuez-access";
import { CuezTransferWorkspace } from "../components/cuez-transfer-workspace";
import { RequireCapability } from "./RequireCapability";

export function CuezStorydeskRoute() {
  const { getIdToken } = useAuth();
  const api = useMemo(() => createCuezApi(getIdToken), [getIdToken]);
  return <RequireCapability allowed={canUseCuez} notice="Your account cannot use StoryDesk transfers.">
    <CuezTransferWorkspace api={api} />
  </RequireCapability>;
}
