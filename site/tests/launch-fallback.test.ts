import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderLivePlayerFrame } from "../src/lib/live-player-render";
import { resolveSiteNavigation } from "../../packages/content-core/src/site-navigation";
import {
  donateUrl,
  launchArticlePageSlugs,
  launchComplianceLinks,
  launchCompliancePageSlugs,
  launchFallbackPages,
  launchFallbackRoutePages,
  newsletterSignupUrl,
  launchPrimaryNav,
  launchUtilityLinks,
  pbsLivestreamEmbedUrl,
  pbsVideoUrl,
} from "../src/data/launch-fallback";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");
const wikiRoot = join(process.cwd(), "..", "wiki");

const listMarkdownFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listMarkdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });

const frontmatter = (source: string) => {
  if (!source.startsWith("---")) return "";
  return source.split("---", 3)[1] ?? "";
};

const publicWikiSources = () =>
  listMarkdownFiles(wikiRoot)
    .filter((path) => {
      if (path.endsWith("/log.md")) return false;
      const source = readFileSync(path, "utf8");
      return path.endsWith("/index.md") || /\npublic:\s*true\b/.test(frontmatter(source));
    })
    .map((path) => readFileSync(path, "utf8"));

describe("launchPrimaryNav", () => {
  it("keeps the June 29 launch scope in the public header", () => {
    expect(launchPrimaryNav.map((link) => link.label)).toEqual([
      "Live",
      "Watch on demand",
      "Schedule",
      "NJ Spotlight News",
      "Kids",
      "Support",
    ]);
  });

  it("does not bring retired or held pages back into the header", () => {
    const labels = launchPrimaryNav.map((link) => link.label).join(" ");

    expect(labels).not.toMatch(/events/i);
    expect(labels).not.toMatch(/education/i);
    expect(labels).not.toMatch(/passport/i);
  });

  it("points Watch on demand to PBS VOD and Live to the local livestream page", () => {
    expect(launchPrimaryNav).toContainEqual({
      label: "Live",
      href: "/live/",
    });
    // The on-demand entry is self-describing so live-intent viewers are not sent
    // to the VOD portal by a bare "Watch" that sits next to "Live" (issue #286).
    expect(launchPrimaryNav).toContainEqual({
      label: "Watch on demand",
      href: pbsVideoUrl,
      external: true,
    });
  });
});

describe("launchUtilityLinks", () => {
  it("keeps donate as the primary utility action and sends it directly to PBS", () => {
    expect(launchUtilityLinks).toContainEqual(
      expect.objectContaining({
        label: "Donate",
        href: donateUrl,
        external: true,
      }),
    );
  });

  it("keeps the public newsletter signup on the approved hosted form", () => {
    expect(newsletterSignupUrl).toBe(
      "https://njpbs.bluelena.io/f/1",
    );
  });
});

describe("public homepage section order", () => {
  it("replaces Start here with the newsletter band below the hero", () => {
    const source = readSource("../src/components/CinematicHomePage.astro");
    const newsletter = source.indexOf("renderStandardHomeNewsletter()");
    const featured = source.indexOf("{content.before_featured");

    expect(source).not.toContain("renderHomeStart");
    expect(source).not.toContain("homeStartItems");
    expect(newsletter).toBeGreaterThan(-1);
    expect(newsletter).toBeLessThan(featured);
  });
});

describe("launchFallbackPages", () => {
  it("creates only launch-safe root pages", () => {
    expect(Object.keys(launchFallbackPages).sort()).toEqual([
      "about",
      "donate",
      "give",
      "kids",
      "live",
      "passport",
      "schedule",
      "support",
      "watch",
    ]);
  });

  it("excludes dedicated routes from the catch-all fallback owner", () => {
    const catchAllRoute = readSource("../src/pages/[...slug].astro");
    const dedicatedScheduleRoute = readSource("../src/pages/schedule/[...schedule].astro");
    const fallbackRouteSlugs = launchFallbackRoutePages.map((page) => page.slug).sort();

    expect(launchFallbackPages.schedule).toBeDefined();
    expect(fallbackRouteSlugs).toEqual([
      "about",
      "donate",
      "give",
      "kids",
      "live",
      "passport",
      "support",
      "watch",
    ]);
    expect(fallbackRouteSlugs).not.toContain("schedule");
    expect(catchAllRoute).toContain("launchFallbackRoutePages");
    expect(catchAllRoute).not.toContain("Object.values(launchFallbackPages)");
    expect(dedicatedScheduleRoute).toContain("publicRootRoutesEnabled(process.env)");
    expect(dedicatedScheduleRoute).toContain("params: { schedule: undefined }");
  });

  it("keeps public wiki handoff facts in post-cutover tense", () => {
    const wikiText = publicWikiSources().join("\n\n");

    expect(wikiText).not.toContain(
      "planned, subject to contract execution and legislative review",
    );
    expect(wikiText).not.toContain(
      "subject to execution of the State–MSU contract and the Legislature's 15-day review",
    );
    expect(wikiText).not.toContain(
      "Operation starts:** July 1, 2026 — planned, and contingent",
    );
    expect(wikiText).not.toContain("set to begin operating on July 1, 2026 — subject");
    expect(wikiText).not.toContain(
      "to begin operating them on **July 1, 2026**, subject",
    );
    expect(wikiText).not.toContain("planned; subject to contract execution");
    expect(wikiText).not.toContain("set to stop operating");
    expect(wikiText).not.toContain("incoming operator");
  });

  it("uses present-tense post-cutover copy for the public About page", () => {
    const about = launchFallbackPages.about;
    const publicSubpage = readSource("../src/components/PublicSubpage.astro");

    expect(about.title).toBe("About NJ PBS");
    expect(about.description).toContain("Montclair State University's new role");
    expect(publicSubpage).toContain(
      "As of July 1, 2026, Montclair State University is the new operator of NJ PBS.",
    );
    expect(publicSubpage).toContain('heading: "Montclair\'s role"');
    expect(publicSubpage).toContain(
      "NJ PBS is housed at the College of Communication and Media at Montclair State University.",
    );
    expect(publicSubpage).toContain(
      "WNET operated NJ PBS from July 1, 2011, through June 30, 2026.",
    );
    expect(publicSubpage).not.toContain("if it is finalized");
    expect(publicSubpage).not.toContain("The change is planned for July 1, 2026");
    expect(publicSubpage).not.toContain("moving toward new operations");
  });

  it("publishes the accepted FAQ and contact pages as public root articles", () => {
    expect(launchArticlePageSlugs).toEqual([
      ...launchCompliancePageSlugs,
      "contact",
      "faq",
    ]);
  });

  it("stages local destinations for the cutover subdomain redirects", () => {
    for (const slug of ["watch", "live", "give", "donate", "passport"]) {
      expect(launchFallbackPages[slug], `${slug} page`).toBeDefined();
      expect(launchFallbackPages[slug].primaryAction.href).toBeTruthy();
    }
  });

  it("keeps Watch as on-demand video and Live as livestream", () => {
    expect(launchFallbackPages.watch.primaryAction).toEqual(
      expect.objectContaining({
        label: "Open PBS video portal",
        href: pbsVideoUrl,
        external: true,
      }),
    );
    expect(launchFallbackPages.watch.secondaryAction).toEqual(
      expect.objectContaining({
        label: "Watch live",
        href: "/live/",
      }),
    );
    expect(launchFallbackPages.live.primaryAction).toEqual(
      expect.objectContaining({
        label: "Open PBS livestream",
        href: pbsLivestreamEmbedUrl,
        external: true,
      }),
    );
    expect(launchFallbackPages.live.secondaryAction).toEqual(
      expect.objectContaining({
        label: "See the schedule",
        href: "/schedule/",
      }),
    );
    expect(launchFallbackPages.live.secondaryAction).not.toHaveProperty("external");
    expect(launchFallbackPages.video).toBeUndefined();
  });

  it("sends Donate actions directly to PBS while keeping the local giving page", () => {
    expect(launchFallbackPages.support.primaryAction).toEqual({
      label: "Donate",
      href: donateUrl,
      external: true,
    });
    expect(launchFallbackPages.give.primaryAction).toEqual(
      expect.objectContaining({
        label: "Donate through PBS",
        href: donateUrl,
        external: true,
      }),
    );
    expect(launchFallbackPages.donate.primaryAction).toEqual({
      label: "Donate",
      href: donateUrl,
      external: true,
    });
  });

  it("uses Montclair language instead of MSU shorthand in public copy", () => {
    const text = JSON.stringify({
      pages: launchFallbackPages,
      nav: launchPrimaryNav,
      utility: launchUtilityLinks,
    });

    expect(text).not.toMatch(/\bMSU\b/);
  });
});

describe("public launch copy", () => {
  it("does not expose internal staging labels or fallback framing", () => {
    const source = [
      readSource("../src/components/CinematicHomePage.astro"),
      readSource("../src/components/PublicSubpage.astro"),
      readSource("../src/components/PublicArticle.astro"),
      readSource("../../packages/content-core/src/launch-fallback.ts"),
      readSource("../src/layouts/PublicSiteLayout.astro"),
    ].join("\n");

    for (const phrase of [
      "NJ PBS transition",
      "Core paths",
      "Media Manager",
      "Fallback links",
      "Information</p>",
      "NJ PBS stays available",
      "Montclair is preparing the next NJ PBS website",
      "This fallback site",
      "Bento CMS launch",
    ]) {
      expect(source).not.toContain(phrase);
    }
  });

  it("uses the accepted cinematic homepage on the public apex", () => {
    const source = readSource("../src/components/CinematicHomePage.astro");
    const route = readSource("../src/pages/index.astro");

    const hero = readSource("../src/components/HomeHero.astro");
    expect(source).toContain("<HomeHero");
    expect(source).toContain("title={heroTitle}");
    expect(hero).toContain('<h1 id="hero-h">{title}</h1>');
    expect(source).not.toContain("<NJHero");
    expect(source).not.toContain('<img src="/nj-static-signal.svg"');
    expect(source).not.toContain("border-left: 8px solid");
    // Admitting a CMS home snapshot changes its metadata and can place one manual
    // content shelf, but it must not replace or append to the executable homepage
    // design with the generic block renderer.
    expect(route).toContain("<CinematicHomePage");
    expect(route).toContain("promotions={homePromotions}");
    expect(route).not.toContain("CmsBlocks");
    expect(route).not.toContain("<CmsPage");
  });

  it("preserves service-page frames and CMS route aliases", () => {
    const route = readSource("../src/pages/[...slug].astro");

    expect(route).toContain('cmsEntry?.data.family === "service"');
    expect(route).toContain("<PublicSubpage page={cmsServicePage}");
    expect(route).toContain("projectCmsServicePage");
    expect(route).toContain(
      '<div class="wrap"><CmsBlocks entry={cmsTailEntry} contained={false} /></div>',
    );
    expect(route).toMatch(
      /publicPageAliases\(\s*definition,\s*cmsEntry\.data\.path,\s*cmsEntry\.data\.previousSlugs\s*\)/,
    );
    expect(route).toContain(
      "path !== cmsEntry.data.path ? { redirectTo: cmsEntry.data.path } : {}",
    );
    expect(route).toMatch(
      /const noindex\s*=\s*[^;]*page\?\.slug === "donate"[^;]*;/,
    );
  });

  it("uses the static branded hero without the retired particle atmosphere", () => {
    const source = readSource("../src/components/CinematicHomePage.astro");
    const hero = readSource("../src/components/HomeHero.astro");
    expect(source).toContain("<HomeHero");
    expect(hero).toContain('import "../styles/branded-masthead.css"');
    expect(hero).not.toContain('class="branded-signal"');
    expect(hero).toContain("data-home-hero-background");
    for (const retired of ["<NJHero", "hero__sky", "hero__particles", "data-moon-regime", "CINEMATIC_HERO_CONFIG"]) {
      expect(source).not.toContain(retired);
      expect(hero).not.toContain(retired);
    }
  });

  it("keeps image-backed glass cards in the Start here compatibility renderer", () => {
    const source = readSource("../../packages/content-core/src/home-section-render.ts");
    const styles = readSource("../src/styles/public-site.css");

    expect(source).toContain('image: "/brand/starthere/live.webp"');
    expect(source).toContain('image: "/brand/starthere/ondemand.webp"');
    expect(source).toContain('image: "/brand/starthere/schedule.webp"');
    expect(source).toContain('image: "/brand/starthere/kids.webp"');
    // Retained set: Live / On demand / Schedule / Kids. This renderer stays
    // available for stored compatibility data and is not used by the homepage.
    expect(source).toContain('show: "LIVE"');
    expect(source).toContain('kind: "live"');
    expect(source).toContain("primary: true");
    // Per-function color-coding + primary emphasis on the live card.
    expect(styles).toContain(".sched--public .sched__item--live");
    expect(styles).toContain(".sched--public .sched__item--primary");
    expect(source).toContain('class="sched__media"');
    expect(source).toContain('class="sched__image"');
    expect(styles).toContain(".sched--public .sched__media");
    expect(styles).toContain(".sched--public .sched__media::before");
    expect(styles).toContain(".sched--public .sched__image");
    expect(styles).not.toContain(".sched--public .sched__item > * {");
    expect(styles).toContain(".sched--public .sched__item > :not(.sr-only)");
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sched--public \.sched__item:hover[\s\S]*?transform: none;/,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sched--public \.sched__item:hover \.sched__media[\s\S]*?transform: none;/,
    );
  });

  it("keeps the live compatibility card's accent glow reduced-motion safe", () => {
    const source = readSource("../../packages/content-core/src/home-section-render.ts");
    const styles = readSource("../src/styles/public-site.css");

    // The still frame stays; the neon pulse is layered on in CSS, not a GIF.
    expect(source).toContain('image: "/brand/starthere/live.webp"');
    expect(source).toContain('class="sched__pulse"');
    expect(styles).toContain(".sched--public .sched__item--live .sched__pulse");
    expect(styles).toContain("@keyframes sched-glow-pulse");
    expect(styles).toContain("@keyframes sched-glow-breathe");
    // The motion must switch off under prefers-reduced-motion.
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sched--public \.sched__item--live \.sched__pulse[\s\S]*?animation: none;/,
    );
  });

  it("keeps the kids compatibility card's SVG blocks reduced-motion safe", () => {
    const source = readSource("../../packages/content-core/src/home-section-render.ts");
    const styles = readSource("../src/styles/public-site.css");

    // The flat webp is replaced by inline vector blocks only on the kids card.
    expect(source).toContain('item.kind === "kids"');
    expect(source).toContain('class="sched__image sched__blocks"');
    // Eight blocks, each with its own tumble keyframes.
    for (let n = 1; n <= 8; n += 1) {
      expect(source).toContain(`b b${n}`);
      expect(styles).toContain(`@keyframes kids-t${n}`);
    }
    // A seamless loop: every block returns to identity at the end of the cycle.
    expect(styles).toMatch(
      /@keyframes kids-t1 \{[\s\S]*?100% \{ transform: translate\(0, 0\) rotate\(-360deg\); \}/,
    );
    // Motion switches off under prefers-reduced-motion, leaving the tower assembled.
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sched__blocks \.b \{[\s\S]*?animation: none;/,
    );
  });

  it("keeps the retired plain launch shell out of source", () => {
    const root = new URL("../src/", import.meta.url);
    const removed = [
      "components/LaunchHome.astro",
      "components/LaunchPage.astro",
      "components/LaunchArticle.astro",
      "layouts/LaunchLayout.astro",
    ];

    for (const rel of removed) {
      expect(() => readFileSync(new URL(rel, root), "utf8")).toThrow();
    }
  });

  it("uses the dark NJ PBS shell for public root subpages", () => {
    const route = readSource("../src/pages/[...slug].astro");

    expect(route).toContain('import PublicSiteLayout from "../layouts/PublicSiteLayout.astro"');
    expect(route).toContain('import PublicSubpage from "../components/PublicSubpage.astro"');
    expect(route).toContain('import PublicArticle from "../components/PublicArticle.astro"');
    expect(route).toContain(
      'const preview = cmsEntry?.data.contentMode === "draft";',
    );
    expect(route).toContain("preview={preview}");
    expect(route).not.toContain("routePrefix");
    expect(route).not.toContain("LaunchLayout");
  });

  it("fills service destination cards with Spotlight-style image media", () => {
    const source = [
      readSource("../src/components/PublicSubpage.astro"),
      readSource("../../packages/content-core/src/cms-service-render.ts"),
    ].join("\n");
    const styles = readSource("../src/styles/service-page.css");

    expect(source).toContain('image: "/brand/spotlight/watch.jpg"');
    expect(source).toContain('image: "/brand/spotlight/support.jpg"');
    expect(source).toContain('class="public-page__card-media"');
    expect(source).toContain('class="public-page__card-image"');
    expect(styles).toContain("aspect-ratio: 16 / 9;");
    expect(styles).toContain(".public-page__card-media::before");
  });

  it("stills subpage card media hover under reduced motion", () => {
    const styles = readSource("../src/styles/service-page.css");

    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.public-page__card:hover \.public-page__card-media\s*\{\s*transform: none;/,
    );
  });

  it("keeps the Watch page cards image-backed in a full-width row layout", () => {
    const source = [
      readSource("../src/components/PublicSubpage.astro"),
      readSource("../../packages/content-core/src/cms-service-render.ts"),
    ].join("\n");
    const styles = readSource("../src/styles/service-page.css");

    expect(source).toContain('title: "Programs on demand"');
    expect(source).toContain('title: "PBS Passport"');
    expect(source).toContain('title: "Livestream"');
    expect(source).toContain('title: "PBS app"');
    expect(source).toContain('image: "/brand/spotlight/watch.jpg"');
    expect(source).toContain('image: "/brand/spotlight/support.jpg"');
    expect(source).toContain('image: "/brand/spotlight/under-the-dome.jpg"');
    expect(source).toContain('image: "/brand/spotlight/about.jpg"');
    expect(source).toContain("page.destinationCards");
    expect(source).toContain("public-page--wide-cards");
    expect(source).toContain("public-page__cards--four");
    expect(styles).toMatch(
      /\.public-page--wide-cards \.public-page__body\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
    );
    expect(styles).toMatch(
      /\.public-page__cards--four\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/,
    );
    expect(styles).toMatch(
      /\.public-page__copy\s*\{[^}]*width:\s*100%;/,
    );
    expect(styles).not.toMatch(/\.public-page--wide-cards \.public-page__copy\s*\{[^}]*max-width:/);
    expect(styles).not.toMatch(/\.public-page--with-player\.public-page--wide-cards \.public-page__copy\s*\{[^}]*max-width:/);
  });

  it("gives the Kids page an on-site NJ PBS broadcast path (issue #287)", () => {
    const source = readSource("../src/components/PublicSubpage.astro");

    // A "Watch on NJ PBS" block on /kids/ links back to the live stream and the
    // native TV schedule, so the schedule<->kids cross-link runs both ways and
    // parents reach the broadcast without leaving the site. The label names the
    // full schedule, not a kids-only view, because the grid is the whole station
    // feed.
    expect(source).toContain('heading: "Watch on NJ PBS"');
    expect(source).toContain('label: "Watch NJ PBS live"');
    expect(source).toContain('href: "/live/"');
    expect(source).toContain('label: "See the NJ PBS TV schedule"');
    expect(source).toContain('href: "/schedule/"');
    expect(source).not.toContain("/schedule/#");
  });

  it("uses the external Montclair Workday careers link and no Connect footer column", () => {
    // The footer columns render from the site navigation seed or its published
    // replacement, so the seed carries the careers link.
    const layout = [
      readSource("../src/layouts/PublicSiteLayout.astro"),
      readSource("../../packages/content-core/src/cms-settings.ts"),
    ].join("\n");

    expect(layout).toContain(
      "https://montclair.wd1.myworkdayjobs.com/en-US/JobOpportunities/?q=PBS",
    );
    expect(layout).not.toContain("<h2>Connect</h2>");
    expect(layout).not.toContain('class="foot-connect"');
    expect(layout).not.toContain("Ways to give");
    expect(layout).not.toContain("Corporate sponsorship");
    expect(layout).not.toContain('label: "News"');
  });

  it("public chrome resolves service links to confirmed PBS destinations", () => {
    // The retired per-section views are gone. The public components resolve
    // service links to confirmed PBS destinations.
    const source = [
      readSource("../src/components/CinematicHomePage.astro"),
      readSource("../src/layouts/PublicSiteLayout.astro"),
      readSource("../src/components/PublicSubpage.astro"),
    ].join("\n");

    expect(source).toContain("passportLearnMoreUrl");
    expect(source).toContain("const passportHref = passportLearnMoreUrl");
    expect(source).toContain("const watchHref = pbsVideoUrl");
    expect(source).toContain("const giveHref = donateUrl");
    expect(source).toContain("const donateHref = donateUrl");
    expect(source).toContain("passportLookupUrl");
    expect(source).not.toContain("routePrefix");
    expect(source).not.toContain('pageHref("watch", "passport")');
    expect(source).not.toContain('pageHref("watch", "account")');
  });

  it("renders the official PBS livestream embed on the live page", () => {
    const source = [
      readSource("../src/components/PublicSubpage.astro"),
      readSource("../../packages/content-core/src/cms-service-render.ts"),
      renderLivePlayerFrame(),
    ].join("\n");
    const styles = readSource("../src/styles/service-page.css");

    expect(pbsLivestreamEmbedUrl).toBe(
      "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&feed_cid=4211290e-ce30-49e5-9be1-2c412c5b3278",
    );
    expect(source).toContain("public-page__player");
    expect(source).toContain("public-page__player-frame");
    expect(source).toContain("public-page--with-player");
    expect(source).toContain("public-page__player-section");
    expect(source).toContain('image: "/brand/spotlight/watch.jpg"');
    expect(source).toContain('image: "/brand/spotlight/under-the-dome.jpg"');
    expect(source).toContain('href: "/watch/"');
    expect(styles).toContain(".public-page--with-player .public-page__hero");
    expect(styles).toContain(".public-page--with-player .public-page__body");
    expect(styles).toContain(".public-page--with-player .public-page__player");
    expect(source).toContain("<iframe");
    expect(source).toContain(
      'allow="geolocation; encrypted-media"',
    );
    expect(source).toContain("pbsLivestreamEmbedUrl");
  });

  it("routes visible contact and help affordances to a local contact page", () => {
    const source = [
      readSource("../src/components/PublicSubpage.astro"),
      readSource("../../packages/content-core/src/launch-fallback.ts"),
      readSource("../src/layouts/PublicSiteLayout.astro"),
    ].join("\n");

    const footerLinks = resolveSiteNavigation(undefined, { postsIndexEnabled: true })
      .footer.flatMap(({ links }) => links);
    expect(footerLinks).toContainEqual(expect.objectContaining({
      label: "Contact",
      href: "/contact/",
      opensInNewTab: false,
    }));
    expect(source).toContain('href: "/contact/"');
    expect(source).not.toContain('{ href: "mailto:njpbs@montclair.edu", label: "Contact"');
    expect(source).not.toContain('title: "Contact NJ PBS",\\n        description: "Reach the station team with membership or site questions.",\\n        href: "mailto:njpbs@montclair.edu"');
  });
});

describe("schedule page embeds the PBS TV schedule instead of looping out", () => {
  const publicSubpage = readSource("../src/components/PublicSubpage.astro");
  const fallbackData = readSource("../../packages/content-core/src/launch-fallback.ts");
  const servicePageStyles = readSource("../src/styles/service-page.css");

  it("never links out to the PBS station schedule router (it redirects back into a loop)", () => {
    // pbs.org/tv_schedules resolves per station and bounces back to
    // njpbs.org/schedule/, so any outbound link to it dead-ends the visitor.
    const source = `${publicSubpage}\n${fallbackData}`;
    expect(source).not.toContain("pbs.org/tv_schedules");
  });

  it("embeds the PBS JAWS TV schedule widget on the schedule page", () => {
    expect(publicSubpage).toContain('id="tvschedule"');
    // The embed config (api_key, gc.js src, single-widget rule) lives in the
    // shared, tested module; the page builds its inline config from it.
    expect(publicSubpage).toContain('from "../lib/schedule-widget"');
    expect(publicSubpage).toContain("buildScheduleWidgetConfig");
    expect(publicSubpage).toContain("SCHEDULE_WIDGET_SRC");
    expect(publicSubpage).toContain("is:inline");
  });

  it("embeds only the full week grid, not the partial JAWS widgets", () => {
    // gc.js reloads jQuery once per declared widget, and a second widget broke
    // the grid's datepicker so its table never rendered. The page embeds the full
    // grid alone (see src/lib/schedule-widget.ts and schedule-widget.test.ts).
    expect(publicSubpage).not.toContain('id="jaws_whatson"');
    expect(publicSubpage).not.toContain('id="jaws_whatsonkids"');
  });

  it("hides the PBS masthead that gc.js injects (we want listings, not chrome)", () => {
    // gc.js injects PBS's global site header as #jaws_header; leaving it visible
    // stacks a second nav bar above ours. The schedule styles must suppress it,
    // and also zero the body padding gc.js adds to clear its fixed masthead —
    // otherwise the hidden header leaves dead space above our nav.
    expect(servicePageStyles).toMatch(/(?:^|\n)#jaws_header\s*\{/);
    expect(servicePageStyles).toMatch(/(?:^|\n)html body\s*\{/);
  });

  it("ships a no-widget fallback that does not loop back to the schedule router", () => {
    expect(publicSubpage).toContain("public-page__schedule-fallback");
  });

  it("sends the live page's schedule action to the local schedule page", () => {
    expect(launchFallbackPages.live.secondaryAction?.href).toBe("/schedule/");
    expect(launchFallbackPages.schedule.primaryAction.href).not.toContain("tv_schedules");
  });
});

describe("launch compliance links", () => {
  it("keeps local compliance pages reachable from the launch shell", () => {
    expect(launchComplianceLinks).toEqual([
      { label: "Accessibility", href: "/accessibility/" },
      { label: "Closed captioning", href: "/closed-captioning/" },
      { label: "Privacy policy", href: "/privacy/" },
      { label: "Public file", href: "/public-file/" },
      { label: "EEO report", href: "/eeo/" },
      { label: "Meeting notices", href: "/meeting-notices/" },
    ]);
  });

  it("renders the same compliance pages as launch root routes", () => {
    expect(launchCompliancePageSlugs).toEqual([
      "accessibility",
      "closed-captioning",
      "privacy",
      "public-file",
      "eeo",
      "meeting-notices",
    ]);
  });
});
