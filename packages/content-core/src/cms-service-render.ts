import { escapeHtml, safeHref } from "./content-model";
import { ctaVariantClass, renderResolvedImage } from "./content-render";
import type { LaunchFallbackPage, LaunchLink } from "./launch-fallback";
import type { CmsServicePageProjection } from "./cms-service-page";

const externalNotice = '<span class="sr-only"> (opens in new tab)</span>';

function link(action: LaunchLink, className?: string): string {
  const href = safeHref(action.href);
  if (href === null) return escapeHtml(action.label);
  const external = action.external === true && /^https?:\/\//i.test(href);
  return `<a href="${escapeHtml(href)}"${className ? ` class="${className}"` : ""}${external ? ' rel="noopener" target="_blank"' : ""}>${escapeHtml(action.label)}${external ? externalNotice : ""}</a>`;
}

function blockId(id: string | undefined): string {
  return id ? ` data-block-id="${escapeHtml(id)}"` : "";
}

export function renderServiceActions(service: CmsServicePageProjection, below = false): string {
  if (service.actions.length === 0) return "";
  return `<div class="public-page__actions${below ? " public-page__actions--below" : ""}"${blockId(service.blockIds.actions)}>${service.actions.map(action => link(action, `btn ${ctaVariantClass(action.variant)}`)).join("")}</div>`;
}

export function renderServiceIntroduction(service: CmsServicePageProjection, below = false): string {
  return `<p${below ? ' class="public-page__summary"' : ""}>${escapeHtml(service.summary)}</p>${renderServiceActions(service, below)}`;
}

export function renderServiceNotice(service: CmsServicePageProjection): string {
  if (!service.noticeHtml && service.noticeActions.length === 0) return "";
  const copy = service.noticeHtml ? `<div class="public-page__cms-notice"${blockId(service.blockIds.notice)}>${service.noticeHtml}</div>` : "";
  const actions = service.noticeActions.length ? `<p class="public-page__notice-link"${blockId(service.blockIds.noticeActions)}>${service.noticeActions.map(action => link(action)).join('<span aria-hidden="true"> · </span>')}</p>` : "";
  return `<aside class="public-page__notice" aria-label="Membership information"><div class="public-page__notice-inner">${copy}${actions}</div></aside>`;
}

export function renderServiceNote(service: CmsServicePageProjection): string {
  if (!service.noteHtml) return "";
  const inline = service.page.slug !== "watch" ? " public-page__cms-note--inline" : "";
  return `<div class="public-page__note public-page__cms-note${inline}"${blockId(service.blockIds.note)}>${service.noteHtml}</div>`;
}

export function renderServiceCopy(service: CmsServicePageProjection): string {
  const introduction = service.page.slug === "live" ? renderServiceIntroduction(service, true) : "";
  const body = service.bodyHtml ? `<div class="public-page__cms-copy"${blockId(service.blockIds.body)}>${service.bodyHtml}</div>` : "";
  const sections = service.sections.map(section => section.html !== undefined
    ? `<section class="public-page__section public-page__cms-section"${blockId(section.id)}>${section.html}</section>`
    : `<p class="public-page__section-links"${blockId(section.id)}>${(section.actions ?? []).map(action => link(action)).join("")}</p>`).join("");
  return `${introduction}${body}${sections}${service.page.slug !== "watch" ? renderServiceNote(service) : ""}`;
}

export function renderServiceCards(service: CmsServicePageProjection): string {
  return service.cards.map(card => {
    const image = card.image ? `<span class="public-page__card-media" aria-hidden="true">${renderResolvedImage(card.imageAssetId ?? "", "", card.image, { className: "public-page__card-image" })}</span>` : "";
    const label = card.label ? `<span class="public-page__card-label">${escapeHtml(card.label)}</span>` : "";
    const title = card.href ? link({ label: card.title, href: card.href, external: card.external }, "public-page__card-title-link") : escapeHtml(card.title);
    const body = card.bodyHtml ? `<div class="public-page__card-description">${card.bodyHtml}</div>` : "";
    return `<article class="public-page__card public-page__card--static">${image}${label}<strong>${title}</strong>${body}</article>`;
  }).join("");
}

export function servicePageClass(page: LaunchFallbackPage): string {
  return ["public-page", page.slug === "live" ? "public-page--with-player" : "",
    page.destinationCards ? "public-page--wide-cards" : ""]
    .filter(Boolean).join(" ");
}

export function renderServiceHero(service: CmsServicePageProjection): string {
  return `<section class="public-page__hero"><div><h1>${escapeHtml(service.page.title)}</h1>${service.page.slug === "live" ? "" : renderServiceIntroduction(service)}</div></section>`;
}

export function renderServiceBody(service: CmsServicePageProjection): string {
  const cardsClass = `public-page__cards${service.cards.length === 4 ? " public-page__cards--four" : ""}`;
  const destinations = service.page.destinationCards
    ? `<div class="public-page__side"><div class="${cardsClass}"${blockId(service.blockIds.cards)}>${renderServiceCards(service)}</div></div>`
    : "";
  return `<section class="public-page__body" aria-label="${escapeHtml(service.page.title)} details"><div class="public-page__copy">${renderServiceCopy(service)}</div>${destinations}${service.page.slug === "watch" ? renderServiceNote(service) : ""}</section>`;
}
