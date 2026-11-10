import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { Button } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";
import { useSettingsPreviewWidth, useSettingsSectionActive } from "./SettingsWorkspace";
import { HomePreviewFrame } from "./HomePreviewFrame";
import bandStyles from "../../../packages/content-core/src/nj-decides.css?inline";

const layoutWidths = { desktop: 1280, mobile: 390 };
const styles = `${bandStyles}\nhtml, body { background: transparent; color-scheme: light; }`;

/** Compose at the selected public breakpoint, then fit the result uniformly. */
function FittedBanner({ html, mode }: { html: string; mode: keyof typeof layoutWidths }) {
  const layoutWidth = layoutWidths[mode];
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const measureBand = useCallback((root: HTMLElement) => {
    const measure = () => setHeight(root.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, []);
  const scale = Math.min(1, width / layoutWidth);
  return <div className="settings-banner-viewport" ref={viewport} style={{ maxWidth: layoutWidth, height: height * scale }}>
      <div className="settings-banner-layout" aria-hidden="true" {...{ inert: "" }}
        style={{ width: layoutWidth, transform: `scale(${scale})` }}>
        <HomePreviewFrame html={html} styles={styles} title={`NJ Decides ${mode} banner preview`} onRender={measureBand} />
      </div>
    </div>;
}

function BannerSummary({ html }: { html: string }) {
  const summary = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The text alternative stays readable to AT without adding invisible Tab stops.
    summary.current?.querySelectorAll("a").forEach(link => { link.tabIndex = -1; });
  }, [html]);
  return <div className="sr-only" ref={summary} dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    if ((event.target as Element).closest("a")) event.preventDefault();
  }} />;
}

export function SettingsBannerPreview({ html }: { html: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useSettingsPreviewWidth();
  const active = useSettingsSectionActive();
  useLayoutEffect(() => { if (!active) setOpen(false); }, [active]);
  const widthControls = <div className="settings-banner-width" role="group" aria-label="Preview width">
    <ActionControl action="preview" label="Desktop" accessibleName="Desktop preview" tooltipLabel="Desktop preview (1280 px)"
      size="comfortable" variant="secondary" aria-pressed={mode === "desktop"} onClick={() => setMode("desktop")} />
    <ActionControl action="preview" label="Mobile" accessibleName="Mobile preview" tooltipLabel="Mobile preview (390 px)"
      graphic={<Icon name="smartphone" />} size="comfortable" variant="secondary" aria-pressed={mode === "mobile"} onClick={() => setMode("mobile")} />
  </div>;
  return <>
    {widthControls}
    <FittedBanner html={html} mode={mode} />
    <BannerSummary html={html} />
    <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>Open full-size preview</Button>
    {open && <ComponentEditorDialog open={active} onClose={() => setOpen(false)} title="Full-size banner preview"
      description="See the complete banner at a larger size." className="settings-banner-dialog"
      footerNote={null} closeLabel="Close preview" closeActionLabel="Close full-size banner preview">
      {widthControls}<FittedBanner html={html} mode={mode} /><BannerSummary html={html} />
    </ComponentEditorDialog>}
  </>;
}
