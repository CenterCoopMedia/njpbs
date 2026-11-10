import { escapeHtml, parseBlocks, type DataHubSectionBlock, type PageBlock } from "../../../packages/content-core/src/content-model.ts";
import { DATA_HUB_SECTIONS, dataHubFigureSection, dataHubPageError, isDefaultDataHubComposition, type DataHubSectionData } from "../../../packages/content-core/src/data-hub-composition.ts";
import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout.ts";

function replaceOnce(html: string, needle: string, replacement: string): string {
  if (!html.includes(needle) || html.indexOf(needle) !== html.lastIndexOf(needle)) throw new Error("The compiled Data Hub composition slot is unavailable.");
  return html.replace(needle, () => replacement);
}
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const inheritedCopy = (data: DataHubSectionData) => ({ ...data, heading: data.heading.trim(), introduction: data.introduction.trim() });

/** Legacy and untouched migrated compositions retain the exact reviewed bytes. */
export function dataHubCompositionHtml(html: string, blocks: readonly PageBlock[], version?: 1): string {
  if (version === undefined) {
    const error = dataHubPageError("data-hub", version, blocks);
    if (error) throw new Error(error);
    return html;
  }
  if (version !== 1) throw new Error("The Data Hub composition version is unsupported.");
  const parsed = parseBlocks(blocks, { pageId: "data-hub", complete: false });
  if (!parsed.ok) throw new Error(parsed.error);
  if (isDefaultDataHubComposition(blocks)) return html;
  const sections = visibleLayoutBlocks(blocks).filter((block): block is DataHubSectionBlock => block.type === "data_hub_section").map(block => inheritedCopy(block.data));
  const payload = `const hubSections=${json(sections)};\n${COMPOSITION_READER}`;
  html = replaceOnce(html, '<div id="data-hub-content">', '<div id="data-hub-content" hidden>');
  html = replaceOnce(html, '  function allMetrics() { return seed.metrics; }', `${payload}\n  function allMetrics() { return seed.metrics; }`);
  html = replaceOnce(html, 'allMetrics().filter(m => m.status', 'allMetrics().filter(m => hubMetricIds.has(m.id)).filter(m => m.status');
  html = replaceOnce(html, "$('metric-results').addEventListener('click'", "$('data-hub-content').parentElement.addEventListener('click'");
  html = replaceOnce(html, '    v7Decorate();', '    v7Decorate();\n    applyHubComposition();');
  html = replaceOnce(html, "article.querySelector('h4')", "article.querySelector('.measure__summary [tabindex=\"-1\"]')");
  return html;
}

// This code only moves nodes emitted by the compiled reader. It never parses
// staff markup, adds a provider request, or changes the immutable source payload.
const COMPOSITION_READER = String.raw`
  const hubKnownIds=new Set(seed.metrics.map(metric=>metric.id));
  const hubMetricIds=new Set(hubSections.filter(section=>hubKnownIds.has(section.sectionId)).map(section=>section.sectionId));
  const hubSelectors={introduction:['.intro','#main-title','.intro__lead'],featured:['#featured-finding','#featured-title','.featured-finding__lead'],latest:['.latest-findings','#latest-findings-title','.latest-findings__intro'],finder:['#data-finder','#data-finder-title','.data-finder__head p'],overview:['#key-figures','#glance-title','.summary__stamp'],collection:['#browse','#browse-title','.section-lead'],methodology:['#methodology','#methodology-title','.notes__body p']};
  const hubNodes=new Map();
  function hubHeadings(node,primary,level){
    if(node.dataset.hubHeadingLevel)return;
    const original=Number(primary.tagName.slice(1));
    for(const heading of node.querySelectorAll('h1,h2,h3,h4,h5,h6')){
      const rank=heading===primary ? level : Math.min(6,Math.max(level+1,level+Number(heading.tagName.slice(1))-original));
      const replacement=document.createElement('h'+rank);
      for(const attribute of heading.attributes)replacement.setAttribute(attribute.name,attribute.value);
      replacement.append(...heading.childNodes);heading.replaceWith(replacement);
    }
    node.dataset.hubHeadingLevel=String(level);
  }
  function applyHubComposition(){
    const engine=$('data-hub-content'),results=$('metric-results');
    if(results.parentElement!==engine)engine.append(results);
    for(const section of hubSections){
      const slot=document.querySelector('[data-data-hub-section="'+section.sectionId+'"]');
      if(!slot)continue;
      const selectors=hubSelectors[section.sectionId];
      if(selectors){
        let node=hubNodes.get(section.sectionId);
        if(!node){
          node=engine.querySelector(selectors[0]);
          if(!node)continue;
          hubNodes.set(section.sectionId,node);
          if(section.sectionId==='featured')document.querySelectorAll('#featured > .editorial-front__stamp').forEach(stamp=>node.prepend(stamp));
          slot.replaceChildren(node);
          hubHeadings(node,node.querySelector(selectors[1]),section.sectionId==='introduction' ? 1 : Number(slot.dataset.dataHubHeading));
        }
        if(section.heading)node.querySelector(selectors[1]).textContent=section.heading;
        if(section.introduction)node.querySelector(selectors[2]).textContent=section.introduction;
        continue;
      }
      const card=results.querySelector('#metric-'+section.sectionId);
      slot.hidden=!card;
      const wrapper=slot.closest('.cms-block');
      if(wrapper)wrapper.hidden=!card;
      if(card){
        hubHeadings(card,card.querySelector('.measure__summary h4'),Number(slot.dataset.dataHubHeading));
        if(section.heading)card.querySelector('.measure__summary [tabindex="-1"]').textContent=section.heading;
        if(section.introduction)card.querySelector('.measure__description').textContent=section.introduction;
        slot.replaceChildren(card);
      }else slot.replaceChildren();
    }
    for(const link of document.querySelectorAll('.data-hub a[href^="#"]')){
      if(link.getAttribute('href')==='#featured')link.setAttribute('href','#featured-finding');
      const figure=link.dataset.goFigure || (link.getAttribute('href')||'').replace('#metric-','');
      const target=document.getElementById((link.getAttribute('href')||'').slice(1));
      link.hidden=Boolean((link.dataset.goFigure || link.classList.contains('quick-stat')) && !hubMetricIds.has(figure)) || !target || engine.contains(target);
    }
    for(const item of document.querySelectorAll('[data-latest-metric]'))item.hidden=!hubMetricIds.has(item.dataset.latestMetric);
  }
`;

interface CompiledMetric {id: string; title: string; description?: string; display: string; period: string; source: string; sourceUrl: string; methodNote?: string; released?: string; checked?: string}
function compiledMetrics(html: string): CompiledMetric[] {
  const source = html.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!source) throw new Error("The compiled Data Hub source slot is unavailable.");
  return JSON.parse(source).metrics;
}

const COMPILED_SECTION_FRAGMENTS = {
  introduction: /<section class="intro"[\s\S]*?<\/section>/,
  featured: /<article class="featured-finding"[\s\S]*?<\/article>/,
  latest: /<aside class="latest-findings"[\s\S]*?<\/aside>/,
  finder: /<h2 id="data-finder-title"[\s\S]*?<\/h2>\s*<p>[\s\S]*?<\/p>/,
  overview: /<section class="summary container"[\s\S]*?<\/section>/,
  collection: /<h2 class="section-title" id="browse-title"[\s\S]*?<\/h2><p class="section-lead">[\s\S]*?<\/p>/,
  methodology: /<section class="notes container"[\s\S]*?<\/section>/,
} as const;

function compiledSectionFallback(html: string, data: DataHubSectionData, level: number): string {
  if (dataHubFigureSection(data.sectionId)) return "";
  let fragment = html.match(COMPILED_SECTION_FRAGMENTS[data.sectionId])?.[0];
  if (!fragment) throw new Error("The compiled Data Hub section is unavailable.");
  if (data.heading) fragment = fragment.replace(/(<h[1-6]\b[^>]*>)[\s\S]*?(<\/h[1-6]>)/, (_all, open, close) => open + escapeHtml(data.heading) + close);
  if (data.introduction) {
    const paragraph = data.sectionId === "featured" ? /(<p class="featured-finding__lead">)[\s\S]*?(<\/p>)/ : /(<p\b[^>]*>)[\s\S]*?(<\/p>)/;
    fragment = fragment.replace(paragraph, (_all, open, close) => open + escapeHtml(data.introduction) + close);
  }
  const original = Number(fragment.match(/<h([1-6])\b/)?.[1] ?? 2);
  const target = data.sectionId === "introduction" ? 1 : level;
  let first = true;
  fragment = fragment.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_all, rank, attributes, content) => {
    const next = first ? target : Math.min(6, Math.max(target + 1, target + Number(rank) - original));
    first = false;
    return `<h${next}${attributes}>${content}</h${next}>`;
  });
  return fragment.replace(/<nav\b[\s\S]*?<\/nav>|<button\b[\s\S]*?<\/button>/g, "")
    .replace(/<a\b[^>]*href="#[^"]*"[^>]*>([\s\S]*?)<\/a>/g, "$1")
    .replace(/ (?:id|aria-labelledby|aria-describedby|aria-controls)="[^"]*"/g, "");
}

/** A readable no-JavaScript fallback comes from the same immutable source. */
export function dataHubSectionHtml(html: string, input: DataHubSectionData, level: number): string {
  const data = inheritedCopy(input);
  const metric = dataHubFigureSection(data.sectionId) ? compiledMetrics(html).find(metric => metric.id === data.sectionId) : undefined;
  const heading = data.heading || metric?.title || DATA_HUB_SECTIONS[data.sectionId];
  const introduction = data.introduction || metric?.description || "";
  const fallback = metric ? `<h${level}>${escapeHtml(heading)}</h${level}>${introduction ? `<p>${escapeHtml(introduction)}</p>` : ""}` +
    `<table><caption>${escapeHtml(metric.title)}</caption><thead><tr><th scope="col">Value</th><th scope="col">Reporting period</th><th scope="col">Source</th></tr></thead><tbody><tr><td>${escapeHtml(metric.display)}</td><td>${escapeHtml(metric.period)}</td><td><a href="${escapeHtml(metric.sourceUrl)}">${escapeHtml(metric.source)}</a></td></tr></tbody></table><p>${escapeHtml(metric.methodNote || "")}</p><p>Source published: ${escapeHtml(metric.released || "")}. Checked: ${escapeHtml(metric.checked || "")}.</p>` : compiledSectionFallback(html, data, level);
  return `<section data-data-hub-section="${data.sectionId}" data-data-hub-heading="${level}" class="data-hub-composed-section"><noscript>${fallback}</noscript></section>`;
}
