import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import {
  cmsGetContent,
  cmsSaveContent,
  cmsTransitionContent,
  type LifecycleAction,
} from "../lib/functions";
import type { ExitSaveOutcome } from "../lib/exit-save";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";
import {
  publicPage,
  type PublicPageId,
} from "../../../packages/content-core/src/public-pages";
import type { Principal } from "../../../packages/content-core/src/rbac";

export interface ContentQuickActionsApi {
  principal: Principal;
  loadPage: (pageId: PublicPageId) => Promise<Record<string, unknown> | null>;
  savePageMetadata: (
    pageId: PublicPageId,
    values: { title: string; description: string },
    baseVersion: number,
  ) => Promise<Record<string, unknown>>;
  loadRecord: (
    kind: RecordKind,
    recordId: string,
  ) => Promise<Record<string, unknown> | null>;
  saveRecordMetadata: (
    kind: RecordKind,
    recordId: string,
    values: { title: string; summary: string },
    baseVersion: number,
  ) => Promise<Record<string, unknown>>;
  transition: (request: {
    collection: "cmsPages" | "cmsPosts";
    id: string;
    action: LifecycleAction;
    baseVersion: number;
    comment?: string;
  }) => Promise<Record<string, unknown>>;
}

export interface ContentQuickEditGuardContract {
  label: string;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<ExitSaveOutcome>;
}

export interface ContentQuickEditGuardState {
  dirty: boolean;
  saving: boolean;
  hasUnsavedWork: () => boolean;
  save: () => Promise<ExitSaveOutcome>;
}

interface ContentQuickEditGuardRegistry {
  register: (id: symbol, contract: ContentQuickEditGuardContract) => void;
  unregister: (id: symbol) => void;
}

const ContentQuickActionsContext =
  createContext<ContentQuickActionsApi | null>(null);
const ContentQuickEditGuardRegistryContext =
  createContext<ContentQuickEditGuardRegistry | null>(null);
const ContentQuickEditGuardStateContext =
  createContext<ContentQuickEditGuardState | null>(null);

const EMPTY_QUICK_EDIT_GUARD: ContentQuickEditGuardState = {
  dirty: false,
  saving: false,
  hasUnsavedWork: () => false,
  save: async () => ({ status: "saved" }),
};

function ContentQuickEditGuardProvider({ children }: { children: ReactNode }) {
  const [contracts, setContracts] = useState(
    () => new Map<symbol, ContentQuickEditGuardContract>(),
  );

  const register = useCallback(
    (id: symbol, contract: ContentQuickEditGuardContract) => {
      setContracts((current) => {
        const next = new Map(current);
        next.set(id, contract);
        return next;
      });
    },
    [],
  );

  const unregister = useCallback((id: symbol) => {
    setContracts((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const registry = useMemo(
    () => ({ register, unregister }),
    [register, unregister],
  );

  const state = useMemo<ContentQuickEditGuardState>(() => {
    const active = [...contracts.values()];
    const hasUnsavedWork = () => active.some((contract) => contract.dirty);

    return {
      dirty: hasUnsavedWork(),
      saving: active.some((contract) => contract.saving),
      hasUnsavedWork,
      save: async () => {
        const outstanding: string[] = [];
        for (const contract of active) {
          if (!contract.dirty) continue;
          let outcome: ExitSaveOutcome;
          try {
            outcome = await contract.save();
          } catch {
            return { status: "failed" };
          }
          if (outcome.status === "failed") return outcome;
          if (outcome.status === "unsaved-elsewhere") {
            outstanding.push(...outcome.items);
          }
        }
        return outstanding.length > 0
          ? {
              status: "unsaved-elsewhere",
              items: [...new Set(outstanding)],
            }
          : { status: "saved" };
      },
    };
  }, [contracts]);

  return (
    <ContentQuickEditGuardRegistryContext.Provider value={registry}>
      <ContentQuickEditGuardStateContext.Provider value={state}>
        {children}
      </ContentQuickEditGuardStateContext.Provider>
    </ContentQuickEditGuardRegistryContext.Provider>
  );
}

/**
 * Small provider seam used by the signed-in application and focused component tests.
 * An omitted value means the surrounding surface is a disconnected gallery or unit
 * specimen, so the ordinary full-editor links remain available without presenting
 * controls that cannot save.
 */
export function ContentQuickActionsBoundary({
  children,
  value,
}: {
  children: ReactNode;
  value: ContentQuickActionsApi | null;
}) {
  return (
    <ContentQuickActionsContext.Provider value={value}>
      <ContentQuickEditGuardProvider>{children}</ContentQuickEditGuardProvider>
    </ContentQuickActionsContext.Provider>
  );
}

export function useContentQuickActions(): ContentQuickActionsApi | null {
  return useContext(ContentQuickActionsContext);
}

export function useContentQuickEditGuard(): ContentQuickEditGuardState {
  return useContext(ContentQuickEditGuardStateContext) ?? EMPTY_QUICK_EDIT_GUARD;
}

export function useRegisterContentQuickEditGuard(
  contract: ContentQuickEditGuardContract,
): void {
  const registry = useContext(ContentQuickEditGuardRegistryContext);
  const idRef = useRef<symbol>(Symbol("content-quick-edit"));
  const latestRef = useRef(contract);
  latestRef.current = contract;

  useEffect(() => {
    if (!registry) return;
    registry.register(idRef.current, {
      label: contract.label,
      dirty: contract.dirty,
      saving: contract.saving,
      save: () => latestRef.current.save(),
    });
  }, [contract.dirty, contract.label, contract.saving, registry]);

  useEffect(() => {
    if (!registry) return;
    const id = idRef.current;
    return () => registry.unregister(id);
  }, [registry]);
}

/**
 * Connect the client-only list disclosures to the same authenticated Function
 * boundaries the full editor uses. The provider adds no new authority: every read,
 * save, and lifecycle request still resolves the Firebase token and is authorized by
 * the server against the stored document and optimistic base version.
 */
export function ContentQuickActionsProvider({ children }: { children: ReactNode }) {
  const { getIdToken, state } = useAuth();

  const value = useMemo<ContentQuickActionsApi | null>(() => {
    if (state.status !== "signed-in") return null;

    return {
      principal: state.principal,
      loadPage: async (pageId) => {
        const idToken = await getIdToken();
        const response = await cmsGetContent(idToken, {
          collection: "cmsPages",
          id: pageId,
        });
        return response.found && response.document ? response.document : null;
      },
      savePageMetadata: async (pageId, values, baseVersion) => {
        const page = publicPage(pageId);
        if (!page) throw new Error("This page is not in the public-page registry.");
        const idToken = await getIdToken();
        const response = await cmsSaveContent(idToken, {
          collection: "cmsPages",
          id: pageId,
          document: {
            title: values.title,
            description: values.description,
            template: page.editorTemplate,
          },
          baseVersion,
        });
        return response.document;
      },
      loadRecord: async (kind, recordId) => {
        const idToken = await getIdToken();
        const response = await cmsGetContent(idToken, {
          collection: "cmsPosts",
          id: recordId,
        });
        if (!response.found || !response.document) return null;
        return response.document.type === kind ? response.document : null;
      },
      saveRecordMetadata: async (
        kind,
        recordId,
        values,
        baseVersion,
      ) => {
        const idToken = await getIdToken();
        const response = await cmsSaveContent(idToken, {
          collection: "cmsPosts",
          id: recordId,
          document: {
            title: values.title,
            summary: values.summary,
            type: kind,
          },
          baseVersion,
        });
        return response.document;
      },
      transition: async (request) => {
        const idToken = await getIdToken();
        const response = await cmsTransitionContent(idToken, request);
        return response.document;
      },
    };
  }, [getIdToken, state]);

  return (
    <ContentQuickActionsBoundary value={value}>
      {children}
    </ContentQuickActionsBoundary>
  );
}
