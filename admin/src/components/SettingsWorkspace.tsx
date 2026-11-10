import { ControlSizingProvider, useControlSize } from "../context/ControlSizingContext";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, UNSAFE_DataRouterContext, useBeforeUnload, useBlocker, useLocation, useSearchParams } from "react-router";
import { LeaveGuardDialog } from "../routes/LeaveGuardDialog";
import { useRegisterExitGuard } from "../routes/ExitGuard";
import { EditorOverlayOwner } from "./EditorOverlayOwner";
import { adminCostsPath } from "../lib/routes";
import { Button, InlineMessage, Select, TextInput } from "./ui/Primitives";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { InspectorResizeHandle } from "./ui/InspectorResizeHandle";
import { readStoredInspectorWidth, rootFontSize, type InspectorWidthBounds } from "../lib/inspector-width";
import { useStoredState } from "../lib/use-stored-state";
import "./settings-workspace.css";

const ActiveContext = createContext(true);
export function useSettingsSectionActive() { return useContext(ActiveContext); }

type SettingsPreviewWidth = "desktop" | "mobile";
const PreviewWidthContext = createContext<readonly [SettingsPreviewWidth, (width: SettingsPreviewWidth) => void] | null>(null);
export function useSettingsPreviewWidth() {
  const shared = useContext(PreviewWidthContext);
  const local = useState<SettingsPreviewWidth>("desktop");
  return shared ?? local;
}

const DirtyContext = createContext<(source: string, dirty: boolean, pending: boolean) => void>(() => {});
// Settings can show a full horizontal banner while retaining a 32rem form.
const DETAILS_WIDTH = { min: 18, max: 80, defaultWidth: 19 };
const readDetailsWidth = (raw: string | null) => readStoredInspectorWidth(raw, DETAILS_WIDTH);
const serializeWidth = (width: number) => String(width);
const InspectorContext = createContext<{
  width: number; bounds: InspectorWidthBounds; setWidth: (width: number, persist?: boolean) => void;
} | null>(null);

/** Retain the splitter beside the scrolling contents, as in Page/Post Details. */
export function SettingsInspector({ children, label = "Preview and publication" }: { children: ReactNode; label?: string }) {
  const resize = useContext(InspectorContext);
  const contentId = useId();
  return <aside className="settings-section-inspector" aria-label={label}>
    {resize && <InspectorResizeHandle controls={contentId} label="Resize settings preview" width={resize.width} bounds={resize.bounds} onChange={resize.setWidth} />}
    <div className="settings-section-inspector-content" id={contentId}>{children}</div>
  </aside>;
}

/** Report the owner's actual draft comparison; values and saving stay with the form. */
export function useSettingsDirty(dirty: boolean, pending = false) {
  const report = useContext(DirtyContext);
  const source = useId();
  useEffect(() => { report(source, dirty, pending); }, [report, source, dirty, pending]);
  useEffect(() => () => report(source, false, false), [report, source]);
}

export interface SettingsSection {
  id: string;
  label: string;
  headingId?: string;
  group: "Public website" | "Workspace";
  content: ReactNode;
}

function SectionHost({ section, active, onDirty }: {
  section: SettingsSection; active: boolean; onDirty: (id: string, dirty: boolean, pending: boolean) => void;
}) {
  const report = useCallback((source: string, dirty: boolean, pending: boolean) => onDirty(`${section.id}:${source}`, dirty, pending), [onDirty, section.id]);
  const [overlayOwner, setOverlayOwner] = useState<HTMLElement | null>(null);
  return <DirtyContext.Provider value={report}><ActiveContext.Provider value={active}>
    <section ref={setOverlayOwner} className="settings-section-host" data-settings-section={section.id} hidden={!active} tabIndex={-1}
      {...(!active ? { inert: "" } : {})} aria-label={section.label}>
      <EditorOverlayOwner.Provider value={overlayOwner}>{section.content}</EditorOverlayOwner.Provider>
    </section>
  </ActiveContext.Provider></DirtyContext.Provider>;
}

function SettingsRouteGuard({ dirty, pending }: { dirty: boolean; pending: boolean }) {
  const waitForAction = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname) return false;
    waitForAction.current = pending;
    return dirty || pending;
  });
  useEffect(() => {
    if (blocker.state !== "blocked" || pending || !waitForAction.current) return;
    waitForAction.current = false;
    if (!dirty) blocker.proceed();
  }, [blocker, dirty, pending]);
  if (blocker.state !== "blocked") return null;
  if (pending) return <div className="settings-workspace-notice"><InlineMessage tone="info" role="status">Finishing the settings action before leaving. <Button onClick={() => blocker.reset()}>Keep editing</Button></InlineMessage></div>;
  return <LeaveGuardDialog onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} />;
}

export function SettingsWorkspace({ sections }: { sections: readonly SettingsSection[] }) {
  const inheritedSize = useControlSize();
  const previewWidth = useState<SettingsPreviewWidth>("desktop");
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  // Existing Admin links can target a heading inside a form that has not mounted yet.
  const requested = params.get("section") ?? sections.find(({ headingId }) => headingId && hash === `#${headingId}`)?.id;
  const selected = sections.find(({ id }) => id === requested)?.id ?? sections[0].id;
  const [visited, setVisited] = useState(() => new Set([selected]));
  const [dirty, setDirty] = useState<Record<string, { dirty: boolean; pending: boolean }>>({});
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const sectionWorkspace = useRef<HTMLDivElement>(null);
  const [preferredWidth, setWidth] = useStoredState("cms.inspector.settings.width", readDetailsWidth, serializeWidth);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [remPixels, setRemPixels] = useState(rootFontSize);
  useLayoutEffect(() => {
    const element = sectionWorkspace.current;
    if (!element) return;
    const measure = () => { setAvailableWidth(element.clientWidth); setRemPixels(rootFontSize()); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  // Leave 32rem for fields. A temporary workspace limit never changes the saved preference.
  const bounds = { ...DETAILS_WIDTH, max: Math.max(DETAILS_WIDTH.min, Math.min(DETAILS_WIDTH.max,
    Math.floor((availableWidth / remPixels - 32) * 4) / 4)) };
  const width = Math.min(preferredWidth, bounds.max);
  const lastFocus = useRef(new Map<string, { element: HTMLElement; start?: number | null; end?: number | null }>());
  const keepSelectorFocus = useRef(false);
  const firstVisit = useRef(true);
  const lastNavigationFocus = useRef<HTMLElement | null>(null);
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const reportDirty = useCallback((id: string, value: boolean, pending: boolean) => {
    setDirty(current => current[id]?.dirty === value && current[id]?.pending === pending ? current : { ...current, [id]: { dirty: value, pending } });
  }, []);
  const isDirty = (id: string) => Object.entries(dirty).some(([key, value]) => value.dirty && key.startsWith(`${id}:`));
  const hasUnsavedWork = useCallback(() => Object.values(dirty).some(value => value.dirty), [dirty]);
  const pending = Object.values(dirty).some(value => value.pending);
  useRegisterExitGuard({ saving: pending, hasUnsavedWork });
  useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
    if (pending || Object.values(dirty).some(value => value.dirty)) { event.preventDefault(); event.returnValue = ""; }
  }, [dirty, pending]));
  useEffect(() => { setVisited(current => current.has(selected) ? current : new Set([...current, selected])); }, [selected]);
  useLayoutEffect(() => {
    if (firstVisit.current) { firstVisit.current = false; return; }
    if (keepSelectorFocus.current) { keepSelectorFocus.current = false; return; }
    const previous = lastFocus.current.get(selected);
    const collapsed = previous?.element.closest("details:not([open])");
    const visibleInDisclosure = !collapsed || Boolean(collapsed.querySelector("summary")?.contains(previous!.element));
    if (previous?.element.isConnected && !previous.element.matches(":disabled") && !previous.element.closest("[hidden]") && visibleInDisclosure) {
      previous.element.focus({ preventScroll: true });
      if (previous.start != null && previous.end != null && "setSelectionRange" in previous.element) {
        (previous.element as HTMLInputElement).setSelectionRange(previous.start, previous.end);
      }
    } else root.current?.querySelector<HTMLElement>(`[data-settings-section="${selected}"]`)?.focus();
  }, [selected]);
  useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const previous = lastNavigationFocus.current;
      if (!previous || previous.getClientRects().length || (document.activeElement !== document.body && document.activeElement !== previous)) return;
      const selector = node.querySelector<HTMLElement>("#settings-section-selector");
      const outlineItem = node.querySelector<HTMLElement>(".settings-outline-item[aria-current]");
      const outlineSearch = node.querySelector<HTMLElement>(".settings-outline input");
      (selector?.getClientRects().length ? selector : outlineItem ?? outlineSearch)?.focus({ preventScroll: true });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function rememberFocus(target: EventTarget) {
    if (!(target instanceof HTMLElement)) return;
    if (target.closest(".settings-outline, .settings-section-selector")) lastNavigationFocus.current = target;
    else lastNavigationFocus.current = null;
    const id = target.closest<HTMLElement>("[data-settings-section]")?.dataset.settingsSection;
    if (!id) return;
    const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
    lastFocus.current.set(id, { element: target, start: input?.selectionStart, end: input?.selectionEnd });
  }
  function choose(id: string, fromSelector = false) {
    keepSelectorFocus.current = fromSelector;
    setParams(current => { const next = new URLSearchParams(current); next.set("section", id); return next; }, { preventScrollReset: true });
  }

  return <ControlSizingProvider size={!inheritedSize || inheritedSize === "legacy" ? "standard" : inheritedSize}><PreviewWidthContext.Provider value={previewWidth}><InspectorContext.Provider value={{ width, bounds, setWidth }}><div className="settings-workspace" ref={root} style={{ "--settings-inspector-width": `${width}rem` } as CSSProperties} onFocusCapture={event => rememberFocus(event.target)} onBlurCapture={event => rememberFocus(event.target)}>
    {dataRouter && <SettingsRouteGuard dirty={Object.values(dirty).some(value => value.dirty)} pending={pending} />}
    <nav className="settings-outline" aria-label="Settings sections">
      <EditorFrameHeader scope="panel" title="Settings" />
      <label className="settings-search"><span className="sr-only">Find a setting</span>
        <TextInput type="search" placeholder="Find a setting…" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      {(["Public website", "Workspace"] as const).map(group => <div className="settings-outline-group" key={group}>
        <h3>{group}</h3>
        {sections.filter(section => section.group === group && section.label.toLowerCase().includes(query.trim().toLowerCase())).map(section =>
          <button type="button" key={section.id} aria-current={selected === section.id ? "page" : undefined}
            onClick={() => choose(section.id)} aria-label={`${section.label}${isDirty(section.id) ? " — Unsaved changes" : ""}`} className="settings-outline-item">
            <span>{section.label}</span>{isDirty(section.id) && <span className="settings-dirty" aria-hidden="true">●</span>}
          </button>)}
      </div>)}
      {query && !sections.some(section => section.label.toLowerCase().includes(query.trim().toLowerCase())) && <p className="settings-search-empty">No matching settings.</p>}
      <Link className="settings-outline-costs" to={adminCostsPath()}>Costs <span aria-hidden="true">↗</span></Link>
    </nav>
    <div className="settings-section-workspace" ref={sectionWorkspace}>
      <label className="settings-section-selector" htmlFor="settings-section-selector">Settings section
        <Select id="settings-section-selector" value={selected} onChange={event => choose(event.target.value, true)}>
          {(["Public website", "Workspace"] as const).map(group => <optgroup key={group} label={group}>
            {sections.filter(section => section.group === group).map(section => <option value={section.id} key={section.id}>{section.label}{isDirty(section.id) ? " — Unsaved changes" : ""}</option>)}
          </optgroup>)}
        </Select>
      </label>
      <Link className="settings-section-selector-costs" to={adminCostsPath()}>Open costs</Link>
      {sections.filter(section => visited.has(section.id) || section.id === selected).map(section =>
        <SectionHost key={section.id} section={section} active={section.id === selected} onDirty={reportDirty} />)}
    </div>
  </div></InspectorContext.Provider></PreviewWidthContext.Provider></ControlSizingProvider>;
}
