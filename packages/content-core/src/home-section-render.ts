import { renderHomeBandBackground } from "./home-band-background.ts";
// Home's public section markup. The editor can use these same pure renderers;
// neither function reads the CMS, selects a feed, or changes publication state.
import { escapeHtml, renderRichText, safeHref, type RichTextDoc } from "./content-model";

export const HOME_HERO_CONTENT = {
  title: "Your NJ PBS support is still needed.",
  subtitle: "If you were a regular supporter before July 1, your recurring donation was paused. PBS Passport access should have stopped too.\n\nYour gift today helps make sure this journalism and the coverage of the issues that matter most to our state keeps going.",
} as const;

export type HomeStartKind = "live" | "ondemand" | "schedule" | "kids";

export interface HomeStartItem {
  show: string;
  href: string;
  detail?: string;
  external?: boolean;
  image?: string;
  kind?: HomeStartKind;
  primary?: boolean;
}

export function homeStartItems(
  destinations: Record<HomeStartKind, string>,
  externalOnDemand: boolean,
): HomeStartItem[] {
  return [
    {
      kind: "live", primary: true, show: "LIVE",
      detail: "Stream the NJ PBS broadcast channel right now",
      href: destinations.live, image: "/brand/starthere/live.webp",
    },
    {
      kind: "ondemand", show: "Programs on demand",
      detail: "Browse full episodes and specials any time",
      href: destinations.ondemand, external: externalOnDemand,
      image: "/brand/starthere/ondemand.webp",
    },
    {
      kind: "schedule", show: "TV schedule",
      detail: "See what is airing today and all week",
      href: destinations.schedule, image: "/brand/starthere/schedule.webp",
    },
    {
      kind: "kids", show: "PBS Kids",
      detail: "Trusted, ad-free shows and games for children",
      href: destinations.kids, image: "/brand/starthere/kids.webp",
    },
  ];
}

const externalNotice = '<span class="sr-only"> (opens in new tab)</span>';

export function homeLinkAttributes(href: string, external = false, rel: "noopener" | "noopener noreferrer" = "noopener"): string {
  const safe = safeHref(href);
  if (safe === null) return "";
  return ` href="${escapeHtml(safe)}"${external ? ` rel="${rel}" target="_blank"` : ""}`;
}

// Keep the accepted vector artwork. The source kids.webp is a reference frame;
// the shared public CSS animates these shapes and honors reduced motion.
const kidsArtwork = `<svg class="sched__image sched__blocks" viewBox="0 0 800 450" preserveAspectRatio="xMidYMid slice" role="presentation" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <rect class="sched__blocks-bg" width="800" height="450" />
  <g class="blocks">
    <polygon class="b b1 b--round" points="400,88 332,158 468,158" />
    <rect class="b b2" x="326" y="166" width="150" height="44" rx="12" />
    <rect class="b b3" x="330" y="218" width="72" height="74" rx="12" />
    <polygon class="b b4 b--round b--yellow" points="410,292 478,292 478,220" />
    <polygon class="b b5 b--round" points="168,290 179.8,319.8 211.75,321.8 187,342.2 195,373.2 168,356 140.96,373.2 148.98,342.2 124.25,321.8 156.24,319.8" />
    <rect class="b b6" x="300" y="306" width="76" height="74" rx="12" />
    <path class="b b7" d="M 386 318 Q 386 306 398 306 H 468 Q 480 306 480 318 V 380 H 460 A 27 27 0 0 0 406 380 H 386 Z" />
    <circle class="b b8" cx="548" cy="349" r="30" />
  </g>
</svg>`;

function startItemMarkup(item: HomeStartItem): string {
  const classes = [
    "sched__item",
    item.kind && `sched__item--${item.kind}`,
    item.primary && "sched__item--primary",
  ].filter(Boolean).join(" ");
  const image = item.image ? safeHref(item.image) : null;
  const artwork = item.kind === "kids"
    ? kidsArtwork
    : `<img class="sched__image" src="${escapeHtml(image ?? "")}" alt="" loading="lazy" width="640" height="360" />`;
  const media = image === null ? "" : `<span class="sched__media" aria-hidden="true">${artwork}${item.kind === "live" ? '<span class="sched__pulse"></span>' : ""}</span>`;
  const detail = item.detail ? `<div class="sched__detail">${escapeHtml(item.detail)}</div>` : "";
  return `<a class="${escapeHtml(classes)}"${homeLinkAttributes(item.href, item.external)}>${media}<div class="sched__show">${escapeHtml(item.show)}</div>${detail}${item.external ? externalNotice : ""}</a>`;
}

export function renderHomeStart(
  items: readonly HomeStartItem[],
  scheduleHref: string,
  scheduleLabel = "Full schedule",
): string {
  return `<section class="sched sched--public" aria-labelledby="sched-h">
    <div class="rail__head"><h2 id="sched-h">Start here</h2><a${homeLinkAttributes(scheduleHref)}>${escapeHtml(scheduleLabel)}</a></div>
    <div class="sched__track" role="group" aria-label="Start here links" tabindex="0">${items.map(startItemMarkup).join("")}</div>
  </section>`;
}

export interface HomePassportContent {
  backgroundImage?: string;
  heading: string;
  body: RichTextDoc;
  actionLabel: string;
}

export const HOME_PASSPORT_CONTENT: HomePassportContent = {
  heading: "Stream more with PBS Passport",
  body: {
    type: "doc",
    content: [{
      type: "paragraph",
      content: [{
        type: "text",
        text: "Members unlock a library of PBS and NJ PBS programs on demand. Learn how the Passport member benefit works through PBS.",
      }],
    }],
  },
  actionLabel: "Explore Passport",
};

export function renderHomePassport(
  content: HomePassportContent,
  actionHref: string,
  external = true,
): string {
  return `<section class="passport" aria-labelledby="pass-h">
    ${renderHomeBandBackground(content.backgroundImage)}
    <div class="passport__inner">
      <div class="passport__identity">
        <img class="passport__icon" src="/brand/pbs-passport-compass.png" alt="" loading="lazy" width="500" height="500" />
        <p class="passport__mark"><span class="passport__mark-pre">NJ PBS</span><span class="passport__mark-name">Passport</span></p>
      </div>
      <div class="passport__body"><h2 id="pass-h">${escapeHtml(content.heading)}</h2>${renderRichText(content.body)}</div>
      <div class="passport__action"><a class="btn btn--primary"${homeLinkAttributes(actionHref, external)}>${escapeHtml(content.actionLabel)}${external ? externalNotice : ""}</a></div>
    </div>
  </section>`;
}
