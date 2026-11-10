import { DEFAULT_SITE_NAVIGATION, type SiteNavigationSettingsValues } from "../../../packages/content-core/src/cms-settings";
import { PUBLIC_PAGES } from "../../../packages/content-core/src/public-pages";
import { siteNavigationSchema, siteNavigationLinkSummary, siteNavigationHeaderNote, siteNavigationFooterNote } from "../lib/site-navigation-presentation";
import type { CSSProperties } from "react";
import { SkeletonBlock, SkeletonRegion, SkeletonText } from "./ui/Skeleton";

function ActionShape({ width = 100 }: { width?: number | string }) {
  return <SkeletonBlock className="button" style={{ "--site-nav-action-width": typeof width === "number" ? `${width}px` : width } as CSSProperties} height="var(--target-comfortable)" radius="control" />;
}

function CopyShape({ sample }: { sample: string }) {
  return <span className="site-nav-loading-copy">
    <span className="site-nav-loading-copy-measure">{sample}</span>
    <SkeletonBlock className="site-nav-loading-copy-bars" />
  </span>;
}

function LinkShapes({ links, footer = false }: { links: readonly SiteNavigationSettingsValues["header"][number][]; footer?: boolean }) {
  return (
    <ol className="site-nav-list">
      {links.map((link) => (
        <li className="site-nav-item" key={link.id}>
          <div className="site-nav-item-row">
            <p className="site-nav-item-summary">
              <strong><CopyShape sample={link.label} /></strong>
              <span className="muted"><CopyShape sample={siteNavigationLinkSummary(link, PUBLIC_PAGES)} /></span>
            </p>
            <div className="site-nav-item-actions">
              {footer ? <SkeletonBlock className="site-nav-move-column" height="var(--target-comfortable)" radius="control" /> : null}
              <ActionShape width={56} />
              <ActionShape width={88} />
              <ActionShape width={110} />
              <ActionShape width={90} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Default menu copy measures wrapping before the saved menu is known. */
export function SiteNavigationLoading() {
  const limits = siteNavigationSchema();
  return (
    <SkeletonRegion label="Loading site navigation" className="panel panel-default admin-settings-panel site-nav-loading">
      <div className="panel-heading">
        <div>
          <h2>Site navigation</h2>
          <p>The header links and footer link columns on every public page.</p>
        </div>
      </div>
      <div className="admin-settings-form site-nav-settings">
        <fieldset className="site-nav-area">
          <legend>Header links</legend>
          <p className="muted"><CopyShape sample={siteNavigationHeaderNote(DEFAULT_SITE_NAVIGATION.header.length, limits.header.maxItems)} /></p>
          <LinkShapes links={DEFAULT_SITE_NAVIGATION.header} />
          <ActionShape width="100%" />
        </fieldset>
        <fieldset className="site-nav-area">
          <legend>Footer columns</legend>
          <p className="muted"><CopyShape sample={siteNavigationFooterNote(DEFAULT_SITE_NAVIGATION.footer.length, limits.footer.maxItems, limits.footer.maxLinks)} /></p>
          <ol className="site-nav-columns">
            {DEFAULT_SITE_NAVIGATION.footer.map((column) => (
              <li className="site-nav-column" key={column.id}>
                <div className="site-nav-column-head">
                  <div className="site-nav-field">
                    <span className="editor-field-label">Column heading</span>
                    <SkeletonBlock height="var(--cms-control-height)" radius="control" />
                    <small className="muted"><SkeletonText width="35%" /></small>
                  </div>
                  <div className="site-nav-item-actions">
                    <ActionShape width={88} />
                    <ActionShape width={110} />
                    <ActionShape width={138} />
                  </div>
                </div>
                <LinkShapes links={column.links} footer />
                <ActionShape width="100%" />
              </li>
            ))}
          </ol>
          <ActionShape width="100%" />
        </fieldset>
        <section className="site-nav-required">
          <h3>Required links</h3>
          <p><SkeletonText lines={3} /></p>
          <dl>
            {["FCC public inspection file", "Legal row"].map((heading) => (
              <div key={heading}>
                <dt>{heading}</dt>
                <dd><SkeletonText width="80%" /></dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="site-nav-preview-section">
          <div className="site-nav-preview-toolbar">
            <h3>Preview</h3>
            <div><ActionShape width={100} /><ActionShape width={80} /></div>
          </div>
          <SkeletonBlock height={240} radius="panel" />
        </section>
        <dl className="public-banner-status">
          {["Edit state", "Saved draft", "Published"].map((heading) => (
            <div key={heading}>
              <dt>{heading}</dt>
              <dd><SkeletonText width={150} /></dd>
            </div>
          ))}
        </dl>
        <p className="admin-settings-save-note">
          Save draft keeps your changes as a draft. The public site does not change. Publish sends the saved draft with the next public site update, like a content change.
        </p>
        <div className="admin-settings-actions"><ActionShape /><ActionShape width={85} /></div>
      </div>
    </SkeletonRegion>
  );
}
