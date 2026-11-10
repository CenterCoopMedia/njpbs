import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { InlineMessage } from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { cmsResolveEditorTarget } from "../lib/functions";
import { contentPagesPath, editPagePath, editRecordPath } from "../lib/routes";
import { isPublicPageId } from "../../../packages/content-core/src/public-pages";
import { recordKindHasPublicRoute } from "../../../packages/content-core/src/public-record-kinds";
import { useShell } from "./ShellContext";

export function OpenContentRoute() {
  const { getIdToken, principal } = useShell();
  const { search } = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setError(false);
    if (!getIdToken) {
      setError(true);
      return;
    }
    const params = new URLSearchParams(search);
    const exact = params.has("type") || params.has("id");
    const input = exact
      ? { type: params.get("type") ?? "", id: params.get("id") ?? "" }
      : { path: params.get("path") ?? "" };
    void getIdToken().then(token => cmsResolveEditorTarget(token, input)).then(({ target }) => {
      if (!active) return;
      if ((target.type === "home" && target.id === "home") ||
          (target.type === "page" && target.id !== "home" && isPublicPageId(target.id))) {
        navigate(editPagePath(target.id as Parameters<typeof editPagePath>[0]), { replace: true });
        return;
      }
      if (recordKindHasPublicRoute(target.type)) {
        navigate(editRecordPath(target.type, target.id), { replace: true });
        return;
      }
      setError(true);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [getIdToken, navigate, principal, search]);

  if (error) return <>
    <InlineMessage tone="info">This page is unavailable or you do not have permission to edit it.</InlineMessage>
    <Link to={contentPagesPath()}>Open site pages</Link>
  </>;
  return <LoadingIndicator label="Opening the editor" stages={["Checking your access to this page"]} />;
}
