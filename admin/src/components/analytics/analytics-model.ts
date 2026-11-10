import type {
  AnalyticsAudience, AnalyticsPeriod, AnalyticsReport, AnalyticsSource,
} from '../../../../packages/content-core/src/analytics';

export const VIEWS = ['overview', 'content', 'audience', 'newsletter', 'delivery'] as const;
export type AnalyticsView = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<AnalyticsView, string> = {
  overview: 'Overview', content: 'Content performance', audience: 'Audience',
  newsletter: 'Newsletters', delivery: 'Website delivery',
};
export const parseView = (value: string | null): AnalyticsView =>
  VIEWS.includes(value as AnalyticsView) ? value as AnalyticsView : 'overview';
export const ready = <T,>(source: AnalyticsSource<T>): T | null =>
  source.status === 'ready' && source.data !== null ? source.data : null;
const valid = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const percentage = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
export const count = (value: number | null | undefined): string => valid(value) ? integer.format(value) : '—';
export const percent = (value: number | null | undefined): string => valid(value) ? percentage.format(value) : '—';
export function duration(value: number | null | undefined): string {
  if (!valid(value)) return '—';
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
export function bytes(value: number | null | undefined): string {
  if (!valid(value)) return '—';
  if (value < 1000) return `${count(value)} B`;
  const exponent = Math.min(4, Math.floor(Math.log10(value) / 3));
  return `${(value / 1000 ** exponent).toFixed(2)} ${['B', 'KB', 'MB', 'GB', 'TB'][exponent]}`;
}
export function dateLabel(value: string, monthly = false): string {
  const iso = /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  const date = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', ...(monthly ? { year: 'numeric' } : { day: 'numeric', year: 'numeric' }), timeZone: 'UTC',
  }).format(date);
}
export const periodLabel = (period: AnalyticsPeriod): string =>
  `${dateLabel(period.start)} – ${dateLabel(period.end)} · ${period.timezone}`;
export function reportTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown update time';
  return new Intl.DateTimeFormat('en-US', {
    month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZone:'America/New_York', timeZoneName:'short',
  }).format(date);
}
export interface Delta { text: string; direction: 'up' | 'down' | 'flat'; tone: 'positive' | 'negative' | 'neutral' }
export function delta(current: number, previous: number, hasBaseline: boolean, rate = false): Delta {
  if (!hasBaseline || !valid(current) || !valid(previous) || (!rate && previous === 0 && current !== 0))
    return { text: 'No prior baseline', direction: 'flat', tone: 'neutral' };
  const change = rate ? (current - previous) * 100 : previous === 0 ? 0 : (current - previous) / previous * 100;
  if (Math.abs(change) < 0.05) return { text: 'No change', direction: 'flat', tone: 'neutral' };
  return {
    text: `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}${rate ? ' percentage points' : '%'}`,
    direction: change > 0 ? 'up' : 'down', tone: change > 0 ? 'positive' : 'negative',
  };
}
export interface Metric { key:string; label:string; value:string; source:string; detail:string; change?:Delta }
export function audienceMetrics(audience: AnalyticsAudience | null, compare: boolean): Metric[] {
  const t = audience?.totals;
  return [
    ['activeUsers', 'People reached', 'GA4 active users, deduplicated for the period. Not broadcast viewers.'],
    ['engagedSessions', 'Engaged visits', 'GA4 engaged sessions. A visit is not a unique person.'],
    ['engagementRate', 'Engagement rate', 'Share of GA4 sessions that were engaged. Changes are percentage points.'],
    ['views', 'Page views', 'GA4 page views, including repeat views and service pages.'],
  ].map(([key, label, detail]) => {
    const field = key as 'activeUsers' | 'engagedSessions' | 'engagementRate' | 'views';
    return { key, label, detail, source:'GA4', value: field === 'engagementRate' ? percent(t?.[field]) : count(t?.[field]),
      change: audience && compare ? delta(audience.totals[field], audience.previousTotals[field], audience.hasPreviousBaseline, field === 'engagementRate') : undefined };
  });
}
export function overviewMetrics(report: AnalyticsReport, compare: boolean): Metric[] {
  const email = ready(report.mailchimp), edge = ready(report.cloudflare);
  return [...audienceMetrics(ready(report.ga4), compare),
    {key:'subscribed', label:'Subscribed audience', value:count(email?.audience.subscribed), source:'Mailchimp', detail:'Current subscribed audience. Not the subscriber total at the end of the selected date range.'},
    {key:'clickRate', label:'Campaign click rate', value:email && email.totals.delivered > 0 ? percent(email.totals.clickRate) : '—', source:'Mailchimp', detail:'Unique clickers per delivered email, weighted by delivery. Cumulative results for selected sends; not deduplicated across campaigns.'},
    {key:'requests', label:'Website requests', value:count(edge?.totals.requests), source:'Cloudflare', detail:'Public-host edge requests, including bots and files. Not page views or people.'},
    {key:'errors', label:'Server errors', value:count(edge?.totals.errors), source:'Cloudflare', detail:'HTTP 5xx responses. No previous-period series is supplied; no change is inferred.'},
  ];
}
export interface Insight { title:string; body:string; action:string; view:AnalyticsView; tone:'neutral'|'warning' }
export function insights(report: AnalyticsReport, compare: boolean): Insight[] {
  const output:Insight[] = [], audience=ready(report.ga4), email=ready(report.mailchimp), edge=ready(report.cloudflare);
  if (audience) {
    const change = compare ? delta(audience.totals.activeUsers, audience.previousTotals.activeUsers, audience.hasPreviousBaseline) : null;
    output.push(change ? {title:change.direction === 'flat' ? 'Check audience reach' : `Audience reach ${change.direction === 'down' ? 'fell' : 'rose'} ${change.text.replace(/^[+−]/,'')}`,
      body:change.direction === 'flat' ? `${count(audience.totals.activeUsers)} active users in the selected period. ${change.text}.` : 'Compared with the prior equal-length period. Review channels before attributing the change.',
      action:'Review audience', view:'audience', tone:change.direction === 'down' ? 'warning' : 'neutral'}
      : {title:`${count(audience.totals.activeUsers)} active users`, body:'GA4 audience for the selected period. Review channels for more context.', action:'Review audience', view:'audience', tone:'neutral'});
  }
  if (email) output.push({title:`${count(email.audience.subscribed)} subscribed contacts`, body:'Current audience size. Campaign delivery and monthly audience totals use separate reporting windows.', action:'Review newsletters', view:'newsletter', tone:'neutral'});
  if (edge) {
    const missing=edge.statuses.find(row => row.name === '404');
    output.push({title:missing ? `${count(missing.requests)} not-found responses` : `${count(edge.totals.requests)} edge requests`,
      body:missing ? 'Includes automated traffic. Inspect paths and referrers before treating these as reader-facing errors.' : 'Includes files and automated traffic. Do not equate this count with readership.',
      action:'Inspect delivery', view:'delivery', tone:missing && missing.requests > 0 ? 'warning' : 'neutral'});
  }
  return output.slice(0,3);
}
export type PageRow = AnalyticsAudience['pages'][number];
export function engagementPerUser(row:PageRow):number|null {
  return valid(row.engagementSeconds) && valid(row.activeUsers) && row.activeUsers > 0 ? row.engagementSeconds / row.activeUsers : null;
}
export type PageSort = 'name' | 'views' | 'activeUsers' | 'engagementSeconds';
export type PageKind = 'all' | 'posts' | 'service';
export function isPostPath(name:string):boolean { return /^\/posts\/[^/?#]+\/?(?:[?#].*)?$/.test(name); }
export function filterPages(rows:PageRow[], query:string, kind:PageKind, sort:PageSort, ascending:boolean):PageRow[] {
  const needle=query.trim().toLocaleLowerCase('en-US');
  return rows.filter(row => (!needle || row.name.toLocaleLowerCase('en-US').includes(needle) || pageLabel(row.name).toLocaleLowerCase('en-US').includes(needle)) &&
    (kind === 'all' || (kind === 'posts' ? isPostPath(row.name) : !isPostPath(row.name))))
    .slice().sort((a,b) => {
      const aValue=sort==='engagementSeconds'?engagementPerUser(a):a[sort], bValue=sort==='engagementSeconds'?engagementPerUser(b):b[sort];
      if(aValue===null || bValue===null) return aValue===bValue?0:aValue===null?1:-1;
      const order=typeof aValue === 'number' && typeof bValue === 'number' ? aValue-bValue : String(aValue).localeCompare(String(bValue),'en');
      return (ascending ? order : -order) || a.name.localeCompare(b.name,'en');
    });
}
export function pageLabel(path:string):string {
  const known:Record<string,string> = {'/':'Homepage','/schedule/':'Broadcast schedule','/posts/':'Posts','/staff/':'Staff','/about/':'About NJ PBS','/support/':'Support NJ PBS','/give/':'Give','/faq/':'Frequently asked questions','/passport/':'Passport'};
  return known[path] || path;
}
export function publicPageUrl(path:string):string|null {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path)) return null;
  try {
    const url=new URL(path, 'https://njpbs.org');
    return url.origin === 'https://njpbs.org' ? url.href : null;
  } catch {return null;}
}
export const barWidth = (value:number, max:number):number => valid(value) && valid(max) && max > 0 ? Math.max(0,Math.min(100,value/max*100)) : 0;
export function niceMaximum(values:number[]):number {
  const max=Math.max(0,...values.filter(Number.isFinite));
  if (max <= 0) return 1;
  const scale=10 ** Math.floor(Math.log10(max));
  const factor=max/scale;
  return (factor<=1?1:factor<=2?2:factor<=2.5?2.5:factor<=5?5:10)*scale;
}
export type CsvValue=string|number;
/** All string cells are quoted. Neutralize formulas after leading whitespace/control characters. */
export function encodeCsv(rows:CsvValue[][]):string {
  return rows.map(row => row.map(value => {
    let text=String(value);
    if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) text=`'${text}`;
    return `"${text.replace(/"/g,'""')}"`;
  }).join(',')).join('\r\n');
}
/** Long-format export: scope/coverage belongs on every row, not just the browser. */
export function exportRows(report:AnalyticsReport):CsvValue[][] {
  const rows:CsvValue[][]=[['Source','Start','End','Timezone','Scope / coverage','Group','Item','Metric','Value','Generated at']];
  const add=(source:string, period:AnalyticsPeriod|null, coverage:string, group:string, item:string, metric:string, value:CsvValue) =>
    rows.push([source,period?.start??'',period?.end??'',period?.timezone??'',coverage,group,item,metric,value,report.generatedAt]);
  const ga=ready(report.ga4), cf=ready(report.cloudflare), mc=ready(report.mailchimp);
  const hosts=`Public hosts: ${report.hosts.join(', ')}`;
  for (const [name,source] of [['GA4',report.ga4],['Cloudflare',report.cloudflare],['Mailchimp',report.mailchimp]] as const)
    add(name,null,source.status,'Source','', 'status',source.status + (source.message ? `: ${source.message}` : ''));
  if(ga){
    const put=(group:string,item:string,metric:string,value:CsvValue)=>add('GA4',ga.period,`${hosts}; tagged browser activity; not broadcast audience`,group,item,metric,value);
    Object.entries(ga.totals).forEach(([key,value])=>put('Totals','',key,value));
    if(ga.hasPreviousBaseline) Object.entries(ga.previousTotals).forEach(([key,value])=>add('GA4',ga.previousPeriod,'Previous equal-length period','Previous totals','',key,value));
    for(const group of ['pages','channels','sources','landingPages','regions','countries','devices','events','daily'] as const)
      ga[group].forEach(row=>Object.entries(row).forEach(([key,value])=>{if(key!=='name'&&key!=='date') put(group,'name' in row?row.name:row.date,key,value);}));
    ga.notes.forEach(note=>put('Notes','','note',note));
  }
  if(cf){
    const scope=cf.complete?`${hosts}; available complete UTC days; estimated; includes bots and assets`:`${hosts}; PARTIAL requested window; estimated; includes bots and assets`;
    const put=(group:string,item:string,metric:string,value:CsvValue)=>add('Cloudflare',cf.period,scope,group,item,metric,value);
    Object.entries(cf.totals).forEach(([key,value])=>put('Totals','',key,value));
    cf.daily.forEach(row=>{put('Daily',row.date,'requests',row.requests); put('Daily',row.date,'bytes',row.bytes);});
    cf.statuses.forEach(row=>put('Response status',row.name,'requests',row.requests));
    cf.cache.forEach(row=>put('Cache status',row.name,'requests',row.requests));
    cf.notes.forEach(note=>put('Notes','','note',note));
  }
  if(mc){
    const coverage=`Cumulative campaign results for selected UTC send dates${mc.truncated?'; TRUNCATED latest campaigns':''}`;
    Object.entries(mc.audience).forEach(([key,value])=>add('Mailchimp',null,'CURRENT audience, not historical','Audience',mc.audienceName,key,value));
    Object.entries(mc.totals).forEach(([key,value])=>add('Mailchimp',mc.period,coverage,'Campaign totals','',key,value));
    mc.campaigns.forEach(row=>Object.entries(row).forEach(([key,value])=>{if(key!=='title')add('Mailchimp',mc.period,coverage,'Campaign',row.title,key,value);}));
    mc.growth.forEach(row=>{
      add('Mailchimp',null,'Completed calendar month; not selected campaign window','Month-end audience',row.month,'subscribed',row.subscribed);
      add('Mailchimp',null,'Departures during completed calendar month','Monthly activity',row.month,'unsubscribed',row.unsubscribed);
    });
    mc.notes.forEach(note=>add('Mailchimp',mc.period,coverage,'Notes','','note',note));
  }
  return rows;
}
export function exportFilteredPages(report:AnalyticsReport, pages:PageRow[]):CsvValue[][] {
  const audience=ready(report.ga4);
  if(!audience) return [];
  const {start,end,timezone}=audience.period;
  const scope=`Public hosts: ${report.hosts.join(', ')}; filtered returned page paths, not all site pages`;
  return [
    ['Source','Start','End','Timezone','Scope / coverage','Page path','Views','Active users','Total engagement seconds','Engagement seconds per active user','Generated at'],
    ...pages.map(page=>['GA4',start,end,timezone,scope,page.name,page.views,page.activeUsers,page.engagementSeconds,engagementPerUser(page)??'Unavailable',report.generatedAt]),
  ];
}
export function downloadCsv(rows:CsvValue[][], filename:string):void {
  const url=URL.createObjectURL(new Blob(['\uFEFF',encodeCsv(rows)],{type:'text/csv;charset=utf-8'}));
  const anchor=document.createElement('a'); anchor.href=url; anchor.download=filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
