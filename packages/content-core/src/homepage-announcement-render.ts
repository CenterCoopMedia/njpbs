import { escapeHtml, safeHref } from "./safe-href";

interface AnnouncementLink {
  label: string;
  href: string;
}

export interface HomepageAnnouncementOptions {
  message: string;
  link?: AnnouncementLink;
  secondLink?: AnnouncementLink;
}

function renderLink(link?: AnnouncementLink): string {
  const href = safeHref(link?.href);
  if (!href || !link?.label.trim()) return "";
  const external = /^https?:\/\//i.test(href);
  return `<a class="announcement__link" href="${escapeHtml(href)}"${external ? ' rel="noopener" target="_blank"' : ""}>${escapeHtml(link.label)}<span class="announcement__arrow" aria-hidden="true" data-pagefind-ignore>→</span>${external ? '<span class="sr-only"> (opens in new tab)</span>' : ""}</a>`;
}

export function renderHomepageAnnouncement({ message, link, secondLink }: HomepageAnnouncementOptions): string {
  const primary = renderLink(link);
  const secondary = primary ? renderLink(secondLink) : "";
  return `<aside class="announcement" aria-label="Homepage announcement">
    <div class="announcement__inner${secondary ? " announcement__inner--two-links" : ""}">
      <p class="announcement__message"><span class="announcement__eyebrow">Announcement</span> <span class="announcement__heading">${escapeHtml(message)}</span></p>
      ${primary ? `<div class="announcement__links">${primary}${secondary}</div>` : ""}
    </div>
  </aside>`;
}
