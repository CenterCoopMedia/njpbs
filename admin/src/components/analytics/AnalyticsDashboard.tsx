import * as React from 'react';
import type { AnalyticsAudience, AnalyticsDays, AnalyticsEmail, AnalyticsEdge, AnalyticsReport } from '../../../../packages/content-core/src/analytics';
import {
  VIEWS, VIEW_LABELS, audienceMetrics, overviewMetrics, ready, insights, count,
  percent, duration, engagementPerUser, bytes, dateLabel, periodLabel, reportTime, pageLabel,
  filterPages, publicPageUrl, barWidth, niceMaximum, downloadCsv, exportFilteredPages,
  type AnalyticsView, type Metric, type PageKind, type PageRow, type PageSort,
} from './analytics-model';
import './AnalyticsDashboard.css';
import { RegionalAudienceMap, type StateGeometry } from './RegionalAudienceMap';

export interface AnalyticsDashboardProps {
  report: AnalyticsReport;
  refreshing?: boolean;
  view?: AnalyticsView;
  compare?: boolean;
  onViewChange?: (view: AnalyticsView) => void;
  onCompareChange?: (compare: boolean) => void;
  onDaysChange?: (days: AnalyticsDays) => void;
  onRefresh?: () => void;
  onExport?: () => void;
  /** Only provide after a real permission-checked scheduling workflow is wired. */
  onScheduleReport?: () => void;
  preview?: boolean;
  /** Optional verified geometry, never fetched from a third-party map service. */
  regionGeometry?: StateGeometry[];
}
type State = { localView: AnalyticsView; localCompare: boolean; query: string; kind: PageKind; sort: PageSort; ascending: boolean; page: number; selected: PageRow | null };
const PAGE_SIZE = 8;
let instanceCounter = 0;

function Glyph({ name = 'chart' }: { name?: 'chart' | 'mail' | 'arrow' | 'refresh' | 'download' | 'external' | 'close' | 'warning' | 'search' }) {
  const paths: Record<string, string> = {
    chart:'M4 19V11M10 19V5M16 19V9M3 21h18', mail:'M3 5h18v14H3zM3 6l9 7 9-7', arrow:'M5 12h14M13 6l6 6-6 6',
    refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2',
    download:'M12 3v12M7 10l5 5 5-5M4 17v4h16v-4', external:'M14 3h7v7M21 3L10 14M10 4H4v16h16v-6',
    close:'M6 6l12 12M18 6L6 18', warning:'M12 3L2 21h20L12 3zM12 9v5M12 17v1', search:'M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  };
  return <svg className="bw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="bw-info" onKeyDown={event=>{
    if(event.key!=='Escape' || !event.currentTarget.open)return;
    event.preventDefault();
    event.currentTarget.open=false;
    event.currentTarget.querySelector('summary')?.focus();
  }}><summary aria-label={`About ${label}`}>i</summary><div className="bw-info-content">{children}</div></details>;
}
function Card({ title, subtitle, source, action, className = '', children }: { title: string; subtitle?: string; source?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <section className={`bw-card ${className}`} aria-label={title}><header className="bw-card-heading"><div><h3>{title}{source && <span className="bw-provider">{source}</span>}</h3>{subtitle && <p>{subtitle}</p>}</div>{action}</header>{children}</section>;
}
function MetricCard({ metric }: { metric: Metric }) {
  return <article className="bw-metric"><div className="bw-metric-source">{metric.source}</div><div className="bw-metric-label"><span>{metric.label}</span><Info label={metric.label}>{metric.detail}</Info></div><strong className="bw-value">{metric.value}</strong>{metric.change ? <div className={`bw-change bw-${metric.change.tone}`}><span aria-hidden="true">{metric.change.direction === 'up' ? '↗' : metric.change.direction === 'down' ? '↘' : '–'}</span> {metric.change.text}<span className="bw-change-context">vs. previous period</span></div> : <span className="bw-change-context">{metric.source === 'Mailchimp' && metric.key === 'subscribed' ? 'Current audience' : metric.value === '—' ? 'Not available' : 'Source period shown below'}</span>}</article>;
}
function MetricGrid({ metrics }: { metrics: Metric[] }) { return <div className={`bw-kpis ${metrics.length > 4 ? 'bw-kpis-wide' : ''}`}>{metrics.map(metric => <MetricCard key={metric.key} metric={metric} />)}</div>; }
function Empty({ children = 'No data was reported for this period.' }: { children?: React.ReactNode }) { return <div className="bw-empty">{children}</div>; }
function Notes({ notes, children }: { notes?: string[]; children?: React.ReactNode }) {
  return <details className="bw-notes"><summary>Definitions and measurement notes</summary><div>{children}{notes?.length ? <ul>{notes.map((note, index)=><li key={`${index}-${note}`}>{note}</li>)}</ul> : null}</div></details>;
}
function RowsTable({ title, headings, rows }: { title:string; headings:string[]; rows:React.ReactNode[][] }) {
  return rows.length ? <div className="bw-table-scroll" role="region" aria-label={title} tabIndex={0}><table><caption className="bw-sr-only">{title}</caption><thead><tr>{headings.map(heading=><th scope="col" key={heading}>{heading}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{row.map((cell,column)=>column===0 ? <th scope="row" key={column}>{cell}</th> : <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div> : <Empty />;
}
export function RankedBars({ rows, unit='visits', engaged=false }: { rows:{ name:string; value:number; secondary?:number }[]; unit?:string; engaged?:boolean }) {
  const sorted=rows.slice().sort((a,b)=>b.value-a.value), maximum=Math.max(0,...sorted.map(row=>row.value));
  return sorted.length ? <><ol className="bw-bars">{sorted.map((row,index)=><li key={`${index}-${row.name}`}><div className="bw-bar-label"><span>{row.name}</span><strong>{count(row.value)} <small>{unit}</small></strong></div><div className="bw-bar-track" aria-hidden="true"><span style={{width:`${barWidth(row.value,maximum)}%`}} />{engaged && row.secondary!==undefined && <span className="bw-bar-engaged" style={{width:`${barWidth(row.secondary,maximum)}%`}} />}</div>{engaged && <small className="bw-muted">{count(row.secondary)} engaged visits · {row.value > 0 && row.secondary !== undefined ? percent(row.secondary/row.value) : 'No visits'}</small>}</li>)}</ol>{engaged && <p className="bw-bar-key"><i /> All visits <i className="bw-key-engaged" /> Engaged visits</p>}</> : <Empty />;
}
export interface ChartSeries { label:string; values:Array<number|null> }
interface ChartProps { id:string; dates:string[]; series:ChartSeries[]; unit:string; monthly?:boolean; bars?:boolean }
/** SVG chart with pointer/keyboard inspection and an equivalent HTML table.
 * Date-proportional x positions preserve missing-month spacing. Null values break lines. */
export class TimeChart extends React.PureComponent<ChartProps,{index:number|null}> {
  state:{index:number|null}={index:null};
  private inspectPointer=(event:React.PointerEvent<SVGSVGElement>, dates:string[], x:(index:number)=>number, width:number)=>{
    const rect=event.currentTarget.getBoundingClientRect(), local=(event.clientX-rect.left)/rect.width*width;
    if(!Number.isFinite(local))return;
    let closest=0;
    dates.forEach((_,index)=>{if(Math.abs(x(index)-local)<Math.abs(x(closest)-local))closest=index;});
    this.setState({index:closest});
  };
  render(){
    const {id,dates,series,unit,monthly=false,bars=false}=this.props;
    if(!dates.length || !series.length) return <Empty />;
    const width=720, height=220, left=55, right=18, top=22, bottom=34;
    const max=niceMaximum(series.flatMap(s=>s.values.filter((value):value is number=>value!==null)));
    const stamps=dates.map(date=>new Date(`${date.length===7?`${date}-01`:date}T12:00:00Z`).getTime());
    const minimum=Math.min(...stamps), span=Math.max(...stamps)-minimum;
    const inset=bars?22:0;
    const x=(index:number)=>left+inset+(span > 0 ? (stamps[index]-minimum)/span : .5)*(width-left-right-2*inset);
    const y=(value:number)=>height-bottom-(Math.max(0,value)/max)*(height-top-bottom);
    const segments=(values:Array<number|null>)=>{
      const groups:string[]=[]; let group:string[]=[];
      values.forEach((value,index)=>{if(value===null || !Number.isFinite(value)){if(group.length)groups.push(group.join(' '));group=[];}else group.push(`${x(index)},${y(value)}`);});
      if(group.length)groups.push(group.join(' '));return groups;
    };
    const selected=Math.min(dates.length-1,Math.max(0,this.state.index??0));
    const readout=`${dateLabel(dates[selected],monthly)}: ${series.map(s=>`${s.label} ${s.values[selected]===null?'not reported':count(s.values[selected])}`).join('; ')}`;
    const labels=dates.length<=7 ? dates.map((_,i)=>i) : [...new Set([0,Math.round((dates.length-1)/4),Math.round((dates.length-1)/2),Math.round((dates.length-1)*3/4),dates.length-1])];
    return <div className="bw-chart">
      <div className="bw-legend">{series.map((s,i)=><span key={s.label}><i className={`bw-series-${i}`} />{s.label}</span>)}<small>{unit}</small></div>
      <div className="bw-chart-interaction" tabIndex={0} role="group" aria-label={`Interactive ${unit} chart. Use left and right arrows to inspect dates.`} aria-describedby={`${id}-readout`} onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();this.setState({index:event.key==='Home'?0:event.key==='End'?dates.length-1:Math.min(dates.length-1,Math.max(0,(this.state.index??0)+(event.key==='ArrowLeft'?-1:1)))});
      }}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title`} onPointerMove={event=>this.inspectPointer(event,dates,x,width)} onPointerDown={event=>this.inspectPointer(event,dates,x,width)}><title id={`${id}-title`}>{unit} by {monthly?'month':'day'}. Figures are also in the table below.</title>
          {[0,1,2,3,4].map(tick=><g key={tick}><line x1={left} x2={width-right} y1={y(max*tick/4)} y2={y(max*tick/4)} className="bw-grid-line" /><text x={left-12} y={y(max*tick/4)+4} textAnchor="end" className="bw-axis-text">{max>=10000 ? `${Math.round(max*tick/4/1000)}k` : new Intl.NumberFormat('en',{maximumFractionDigits:max<4?2:0}).format(max*tick/4)}</text></g>)}
          {series.map((s,si)=><g key={s.label} className={`bw-plot-series bw-series-${si}`}>
            {!bars && segments(s.values).map((points,i)=><polyline key={i} points={points} fill="none" className="bw-plot-line" />)}
            {s.values.map((value,index)=>value===null || !Number.isFinite(value)?null:bars ? <rect key={dates[index]} x={x(index)-Math.max(3,Math.min(18,240/dates.length))} y={y(value)} width={Math.max(6,Math.min(36,480/dates.length))} height={height-bottom-y(value)} rx={2}><title>{dateLabel(dates[index],monthly)}: {count(value)} {unit}</title></rect> : si===1 ? <rect key={dates[index]} x={x(index)-2.6} y={y(value)-2.6} width={5.2} height={5.2}><title>{dateLabel(dates[index],monthly)}: {s.label} {count(value)}</title></rect> : <circle key={dates[index]} cx={x(index)} cy={y(value)} r={dates.length<15?3.7:2}><title>{dateLabel(dates[index],monthly)}: {s.label} {count(value)}</title></circle>)}
          </g>)}
          {labels.map(index=><text key={index} x={x(index)} y={height-8} textAnchor={index===0?'start':index===dates.length-1?'end':'middle'} className="bw-axis-text">{new Intl.DateTimeFormat('en-US',{month:'short',...(monthly?{}:{day:'numeric'}),timeZone:'UTC'}).format(new Date(stamps[index]))}</text>)}
          {this.state.index!==null && <line x1={x(selected)} x2={x(selected)} y1={top} y2={height-bottom} className="bw-crosshair" />}
        </svg>
        <p id={`${id}-readout`} className="bw-chart-readout" aria-live="polite">{this.state.index===null?'Hover, focus, or use arrow keys to inspect the chart.':readout}</p>
      </div>
      <details className="bw-chart-table"><summary>View {monthly?'monthly':'daily'} figures</summary><RowsTable title={`${unit} figures`} headings={['Date',...series.map(s=>s.label)]} rows={dates.map((date,index)=>[dateLabel(date,monthly),...series.map(s=>s.values[index]===null?'Not reported':count(s.values[index]))])} /></details>
    </div>;
  }
}
function SourceStatus({ report, go }: { report:AnalyticsReport; go:(view:AnalyticsView)=>void }) {
  const sources=[['GA4',report.ga4,'audience'],['Mailchimp',report.mailchimp,'newsletter'],['Cloudflare',report.cloudflare,'delivery']] as const;
  return <div className="bw-sources" role="group" aria-label="Report source status">{sources.map(([name,source,view])=>{
    const data=ready(source as {status:'ready'|'not_configured'|'unavailable';message:string;data:{period:{start:string;end:string;timezone:string}}|null});
    const status=data?'Connected':source.status==='not_configured'?'Not configured':'Unavailable';
    return <button key={name} className="bw-source" onClick={()=>go(view)} title={data?periodLabel(data.period):source.message}><i className={data?'bw-dot-ready':'bw-dot-warning'} aria-hidden="true" /><b>{name}</b><span>{status}</span></button>;
  })}</div>;
}
function SourceWarnings({ report }: { report:AnalyticsReport }) {
  return <div className="bw-source-notices">{(['ga4','mailchimp','cloudflare'] as const).map(key=>ready(report[key] as {status:'ready'|'not_configured'|'unavailable';message:string;data:unknown})?null:<p className="bw-notice" key={key}><strong>{{ga4:'GA4',mailchimp:'Mailchimp',cloudflare:'Cloudflare'}[key]} {report[key].status==='not_configured'?'is not configured':'is unavailable'}.</strong> {report[key].message || 'This source returned no report. Other available sources remain visible.'}</p>)}{ready(report.ga4)?.notes.slice(2).map(note=><p className="bw-notice" key={note}><strong>GA4 data note.</strong> {note}</p>)}{ready(report.cloudflare) && !report.cloudflare.data!.complete && <p className="bw-notice"><strong>Partial delivery period.</strong> Cloudflare returned {periodLabel(report.cloudflare.data!.period)}, not the full requested {report.days}-day window.</p>}{ready(report.mailchimp)?.truncated && <p className="bw-notice"><strong>Campaign results are limited.</strong> Showing {report.mailchimp.data!.campaigns.length} of {count(report.mailchimp.data!.totalCampaigns)} matching campaigns. Totals describe the included campaigns.</p>}</div>;
}
function AudienceTrend({ audience,id }: { audience:AnalyticsAudience; id:string }) {
  return <Card title="Audience trend" subtitle={periodLabel(audience.period)} source="GA4"><TimeChart id={id} dates={audience.daily.map(r=>r.date)} series={[{label:'Active users',values:audience.daily.map(r=>r.activeUsers)},{label:'Visits',values:audience.daily.map(r=>r.sessions)},{label:'Page views',values:audience.daily.map(r=>r.views)}]} unit="Daily counts" /><p className="bw-footnote">Daily active users are not additive. One person can appear on several days.</p></Card>;
}
function DeliveryTrend({ edge,id }: { edge:AnalyticsEdge; id:string }) {
  return <Card title="Website requests" subtitle={periodLabel(edge.period)} source="Cloudflare"><TimeChart id={id} dates={edge.daily.map(r=>r.date)} series={[{label:'Edge requests',values:edge.daily.map(r=>r.requests)}]} unit="Requests" bars /><p className="bw-footnote">Includes bots and files. No daily cache-rate or previous-period series is supplied.</p></Card>;
}
function NewsletterSummary({ email, targetId, go }: { email:AnalyticsEmail } & ({ targetId:string; go?:undefined } | { go:()=>void; targetId?:undefined })) {
  const action = targetId
    ? <a className="bw-text-button" href={`#${targetId}`} onClick={event=>{const target=document.getElementById(targetId);if(!(target instanceof HTMLElement))return;event.preventDefault();if(typeof target.scrollIntoView==='function')target.scrollIntoView({block:'start'});target.focus();}}>View campaigns <Glyph name="arrow" /></a>
    : <button className="bw-text-button" onClick={go}>View campaigns <Glyph name="arrow" /></button>;
  return <Card title="Newsletter performance" subtitle={`Campaigns sent ${periodLabel(email.period)}`} source="Mailchimp" action={action}><div className="bw-mini-metrics"><div><small>Delivered</small><strong>{count(email.totals.delivered)}</strong></div><div><small>Click rate</small><strong>{email.totals.delivered > 0 ? percent(email.totals.clickRate) : '—'}</strong></div><div><small>Unsubscribes</small><strong>{count(email.totals.unsubscribes)}</strong></div></div>{email.campaigns.length ? <div className="bw-campaign-highlight"><Glyph name="mail" /><div><small>Most recent campaign</small><strong>{email.campaigns.slice().sort((a,b)=>b.sentAt.localeCompare(a.sentAt))[0].title}</strong></div></div> : <Empty>No campaigns were sent in this period.</Empty>}<p className="bw-footnote">Cumulative results for selected sends. Audience size is current, not historical.</p></Card>;
}
function DeliveryHealth({ edge, go }: { edge:AnalyticsEdge; go:()=>void }) {
  return <Card title="Website delivery health" subtitle="Keep infrastructure counts separate from readership." source="Cloudflare" action={<button className="bw-text-button" onClick={go}>View delivery <Glyph name="arrow" /></button>}><div className="bw-mini-metrics"><div><small>Cache hit rate</small><strong>{edge.totals.requests > 0 ? percent(edge.totals.cacheHitRate) : '—'}</strong></div><div><small>Server errors</small><strong>{count(edge.totals.errors)}</strong></div><div><small>Data delivered</small><strong>{bytes(edge.totals.bytes)}</strong></div></div><div className="bw-rate-track" aria-hidden="true"><span style={{width:`${barWidth(edge.totals.cacheHitRate,1)}%`}} /></div><p className="bw-footnote">Adaptive estimates may differ across grouped queries. Cache misses can be expected for dynamic content.</p></Card>;
}
function Coverage(){return <details className="bw-coverage"><summary>Measurement coverage <span>Some outcomes need verified tracking</span></summary><div><p>Returning-reader loyalty, recirculation, story-to-newsletter conversion, completed donations, on-site search terms, and video completion are not established by this report contract.</p><p>Recorded events are counts, not a sequential funnel. A donation click is not a completed donation. Do not infer those outcomes from page views or campaign clicks.</p></div></details>;}

/** Content surface only: keep the real ShellLayout, sidebar, authentication and navigation. */
export class AnalyticsDashboard extends React.Component<AnalyticsDashboardProps,State> {
  state:State={localView:'overview',localCompare:true,query:'',kind:'all',sort:'views',ascending:false,page:0,selected:null};
  private readonly uid=`bw-analytics-${++instanceCounter}`;
  private trigger:HTMLElement|null=null;
  private dialog:HTMLDialogElement|null=null;
  private tabs:Partial<Record<AnalyticsView,HTMLButtonElement|null>>={};
  componentDidUpdate(previous:AnalyticsDashboardProps,previousState:State){
    if(previous.report!==this.props.report){ this.setState({page:0,selected:null}); }
    if(!previousState.selected && this.state.selected) this.dialog?.showModal();
    if(previousState.selected && !this.state.selected && this.trigger?.isConnected) this.trigger.focus();
  }
  private go=(view:AnalyticsView)=>{this.props.onViewChange?.(view);this.setState({localView:view,page:0,selected:null},()=>this.tabs[view]?.focus());};
  private setSort=(sort:PageSort)=>this.setState(state=>({sort,ascending:state.sort===sort?!state.ascending:sort==='name',page:0}));
  private openPage=(row:PageRow,trigger:HTMLElement)=>{this.trigger=trigger;this.setState({selected:row});};
  private pages(audience:AnalyticsAudience,compact=false){
    const {query,kind,sort,ascending,page}=this.state;
    const all=filterPages(audience.pages,query,kind,sort,ascending), last=Math.max(0,Math.ceil(all.length/PAGE_SIZE)-1), activePage=Math.min(page,last);
    const rows=compact ? filterPages(audience.pages,'','all','views',false).slice(0,5) : all.slice(activePage*PAGE_SIZE,(activePage+1)*PAGE_SIZE);
    const start=all.length===0?0:activePage*PAGE_SIZE+1;
    const end=Math.min(all.length,(activePage+1)*PAGE_SIZE);
    const pageStatus=`${count(all.length)} matching rows. ${all.length===0?'No rows on this page.':`Showing rows ${start} through ${end}.`} Page ${activePage+1} of ${last+1}. Post filter uses /posts/<slug> paths.`;
    const columns:[PageSort,string][]=[['name','Page'],['views','Views'],['activeUsers','Active users'],['engagementSeconds','Engagement / user']];
    return <Card title="Story and page performance" subtitle="Reported page rows · GA4" className={compact?'bw-overview-pages':''} action={compact?<button className="bw-text-button" onClick={()=>this.go('content')}>View all pages <Glyph name="arrow" /></button>:<button className="bw-text-button" disabled={!all.length} onClick={()=>downloadCsv(exportFilteredPages(this.props.report,all),'njpbs-analytics-filtered-pages.csv')}>Export filtered rows <Glyph name="download" /></button>}>
      {!compact && <div className="bw-table-tools"><label className="bw-search"><span className="bw-sr-only">Search reported pages</span><Glyph name="search" /><input type="search" placeholder="Find a page or URL…" value={query} onChange={event=>this.setState({query:event.target.value,page:0})} /></label><label className="bw-inline-label">Show <select value={kind} onChange={event=>this.setState({kind:event.target.value as PageKind,page:0})}><option value="all">All reported pages</option><option value="posts">Post paths</option><option value="service">Other page paths</option></select></label></div>}
      {rows.length ? <div className="bw-table-scroll" role="region" aria-label="Story and page performance" tabIndex={0}><table><caption className="bw-sr-only">Page performance. Engagement is per active user, not session duration.</caption><thead><tr>{columns.map(([key,label])=><th key={key} scope="col" aria-sort={!compact&&key===sort?(ascending?'ascending':'descending'):undefined}>{compact?label:<button className="bw-sort" onClick={()=>this.setSort(key)}>{label}{key===sort&&<span aria-hidden="true"> {ascending?'↑':'↓'}</span>}</button>}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row.name}><th scope="row"><button className="bw-page-button" onClick={event=>this.openPage(row,event.currentTarget)}><span>{pageLabel(row.name)}</span>{pageLabel(row.name)!==row.name&&<small>{row.name}</small>}</button></th><td>{count(row.views)}</td><td>{count(row.activeUsers)}</td><td>{duration(engagementPerUser(row))}</td></tr>)}</tbody></table></div>:<Empty>No reported pages match these filters.</Empty>}
      {!compact && <footer className="bw-pagination"><span aria-live="polite">{pageStatus}</span><div><button className="bw-button" disabled={activePage===0} onClick={()=>this.setState({page:activePage-1})}>Previous</button><span>{activePage+1} / {last+1}</span><button className="bw-button" disabled={activePage===last} onClick={()=>this.setState({page:activePage+1})}>Next</button></div></footer>}
    </Card>;
  }
  private overview(audience:AnalyticsAudience|null,email:AnalyticsEmail|null,edge:AnalyticsEdge|null){
    return <><div className="bw-grid bw-two">{audience?<AudienceTrend id={`${this.uid}-audience`} audience={audience}/>:<Card title="Audience trend"><Empty>GA4 data is unavailable.</Empty></Card>}{edge?<DeliveryTrend id={`${this.uid}-delivery`} edge={edge}/>:<Card title="Website requests"><Empty>Cloudflare data is unavailable.</Empty></Card>}</div>
      {audience&&<div className="bw-grid bw-editorial-grid">{this.pages(audience,true)}<Card title="Channel engagement" subtitle="Visits, with engaged visits highlighted" source="GA4"><RankedBars rows={audience.channels.slice().sort((a,b)=>b.sessions-a.sessions).slice(0,5).map(r=>({name:r.name,value:r.sessions,secondary:r.engagedSessions}))} engaged /></Card></div>}
      <div className="bw-grid bw-two">{email&&<NewsletterSummary email={email} go={()=>this.go('newsletter')}/ >}{edge&&<DeliveryHealth edge={edge} go={()=>this.go('delivery')}/>}</div><Coverage /></>;
  }
  private audience(audience:AnalyticsAudience){
    return <><AudienceTrend id={`${this.uid}-audience-detail`} audience={audience}/><div className="bw-grid bw-three"><Card title="Regional audience" subtitle="Approximate location · counts, not broadcast reach"><RegionalAudienceMap features={this.props.regionGeometry??[]} rows={audience.regions}/><RankedBars rows={audience.regions.map(r=>({name:r.name,value:r.activeUsers}))} unit="users" /></Card><Card title="Device mix" subtitle="Active users by device; categories need not deduplicate people"><RankedBars rows={audience.devices.map(r=>({name:r.name,value:r.activeUsers}))} unit="users" /></Card><Card title="Channel engagement" subtitle="Reported channel groups"><RankedBars rows={audience.channels.map(r=>({name:r.name,value:r.sessions,secondary:r.engagedSessions}))} engaged /></Card></div><div className="bw-grid bw-two"><Card title="Countries" subtitle="Approximate user location"><RowsTable title="Countries" headings={['Country','Active users']} rows={audience.countries.map(r=>[r.name,count(r.activeUsers)])}/></Card><Card title="Referral sources" subtitle="Source / medium"><RankedBars rows={audience.sources.map(r=>({name:r.name,value:r.sessions,secondary:r.engagedSessions}))} engaged /></Card></div><Notes notes={audience.notes}><p>GA4 reflects tagged browser traffic. Consent choices, blockers, processing, and privacy thresholds affect these counts. Region and device rows can overlap; do not divide them into a whole-audience pie without checking the dimensions.</p></Notes><Coverage /></>;
  }
  private content(audience:AnalyticsAudience){
    return <>{this.pages(audience)}<div className="bw-grid bw-two"><Card title="Entry pages" subtitle="Where reported visits began"><RowsTable title="Entry pages" headings={['Page','Visits','Engaged visits']} rows={audience.landingPages.map(r=>[pageLabel(r.name),count(r.sessions),count(r.engagedSessions)])}/></Card><Card title="Recorded actions" subtitle="Event counts, not a conversion funnel"><RowsTable title="Recorded actions" headings={['Event','Count']} rows={audience.events.map(r=>[r.name,count(r.count)])}/><p className="bw-footnote">Do not combine these rows into a sequential journey or label donation clicks as donations.</p></Card></div><Notes notes={audience.notes}><p>Page engagement is reported per active user. Site average session duration is a separate metric. Page rows are a bounded report, not a complete inventory.</p></Notes><Coverage /></>;
  }
  private newsletter(email:AnalyticsEmail){
    return <><div className="bw-grid bw-two"><Card title="Newsletter audience growth" subtitle="Available completed calendar months · month-end totals"><TimeChart id={`${this.uid}-growth`} dates={email.growth.map(r=>r.month)} series={[{label:'Subscribed at month end',values:email.growth.map(r=>r.subscribed)}]} unit="Subscribers" monthly/><p className="bw-footnote">This is audience size, not new signups. Missing months are not filled with zero.</p></Card><NewsletterSummary email={email} targetId={`${this.uid}-campaigns`}/></div><div id={`${this.uid}-campaigns`} tabIndex={-1} className="bw-campaign-target"><Card title="Campaign results" subtitle={`Campaigns sent ${periodLabel(email.period)} · cumulative activity`}><RowsTable title="Campaign results" headings={['Campaign','Sent (UTC)','Delivered','Click rate','Clickers','Opens (est.)','Bounces','Unsubscribes']} rows={email.campaigns.map(r=>[r.title,r.sentAt.slice(0,10),count(r.delivered),r.delivered>0?percent(r.clickRate):'—',count(r.uniqueClicks),r.delivered>0?percent(r.openRate):'—',count(r.bounces),count(r.unsubscribes)])}/></Card></div><Notes notes={email.notes}><p>{count(email.audience.unsubscribed)} currently unsubscribed contacts; {count(email.audience.cleaned)} cleaned contacts. Audience size is current. Opens are estimates. Privacy proxies and security scans can inflate reported engagement. Clickers are unique within each campaign, not across sends.</p></Notes></>;
  }
  private delivery(edge:AnalyticsEdge){
    return <><DeliveryTrend id={`${this.uid}-requests-detail`} edge={edge}/><div className="bw-grid bw-two"><Card title="Response status" subtitle="Estimated request counts · shown categories only"><RankedBars rows={edge.statuses.map(r=>({name:r.name,value:r.requests}))} unit="requests" /></Card><Card title="Cache performance" subtitle="Estimated request counts · shown statuses only"><RankedBars rows={edge.cache.map(r=>({name:r.name,value:r.requests}))} unit="requests" /></Card></div><Notes notes={edge.notes}><p>Public website hosts only. Edge requests include bots and assets and cannot be combined with GA4 audience counts. Independently estimated groups can differ from the reported total. Cache hits include hit, stale, updating, and revalidated responses. No per-path error breakdown or verified bot classification is supplied by this contract.</p></Notes></>;
  }
  render(){
    const {report,refreshing=false,preview=false}=this.props, view=this.props.view??this.state.localView, compare=this.props.compare??this.state.localCompare;
    const audience=ready(report.ga4), email=ready(report.mailchimp), edge=ready(report.cloudflare);
    let metrics=overviewMetrics(report,compare);
    if(view==='content'||view==='audience')metrics=audienceMetrics(audience,compare);
    if(view==='newsletter')metrics=[
      {key:'subscribed',label:'Subscribed audience',value:count(email?.audience.subscribed),source:'Mailchimp',detail:'Current audience size, not historical.'},
      {key:'delivered',label:'Emails delivered',value:count(email?.totals.delivered),source:'Mailchimp',detail:'Sent minus hard and soft bounces; selected campaign sends.'},
      {key:'clickRate',label:'Campaign click rate',value:email&&email.totals.delivered>0?percent(email.totals.clickRate):'—',source:'Mailchimp',detail:'Unique clickers per delivered message, weighted by deliveries. Not deduplicated across campaigns.'},
      {key:'unsubscribes',label:'Unsubscribes',value:count(email?.totals.unsubscribes),source:'Mailchimp',detail:'Across the included campaigns.'},
    ];
    if(view==='delivery')metrics=[
      {key:'requests',label:'Website requests',value:count(edge?.totals.requests),source:'Cloudflare',detail:'Public-host edge requests, including bots and assets.'},
      {key:'cacheRate',label:'Cache hit rate',value:edge&&edge.totals.requests>0?percent(edge.totals.cacheHitRate):'—',source:'Cloudflare',detail:'Share served from cache. Use the provider aggregate; do not reconstruct from top statuses.'},
      {key:'errors',label:'Server errors',value:count(edge?.totals.errors),source:'Cloudflare',detail:'HTTP 5xx responses; not 404s.'},
      {key:'bytes',label:'Data delivered',value:bytes(edge?.totals.bytes),source:'Cloudflare',detail:'Response bytes, not a bill or cost estimate.'},
    ];
    const selected=this.state.selected, selectedUrl=selected?publicPageUrl(selected.name):null;
    return <div className="bw-analytics" data-testid="analytics-dashboard">
      <div className="bw-page-intro"><div><p className="bw-eyebrow">Audience, content, and operations</p><h2>{{overview:'Your audience at a glance',content:'What people are reading',audience:'Who is visiting',newsletter:'How newsletters are performing',delivery:'How the site is being delivered'}[view]}</h2><p>{{overview:'Review audience, distribution, and delivery from their source systems.',content:'Inspect reported page paths, entry pages, and recorded actions.',audience:'Compare visits, engaged visits, and approximate location.',newsletter:'Review the current audience and results for selected campaign sends.',delivery:'Review edge requests, errors, cache, and reporting coverage.'}[view]}</p></div>{preview&&<span className="bw-preview-badge">Design preview · sample data</span>}</div>
      <div className="bw-toolbar"><label>Reporting period<select aria-label="Reporting period" value={report.days} disabled={!this.props.onDaysChange} onChange={event=>this.props.onDaysChange?.(Number(event.target.value) as AnalyticsDays)}><option value={7}>Last 7 complete days</option><option value={30}>Last 30 complete days</option><option value={90}>Last 90 complete days</option></select></label>{(view==='overview'||view==='content'||view==='audience')&&<label className="bw-compare"><input type="checkbox" checked={compare} onChange={event=>{this.setState({localCompare:event.target.checked});this.props.onCompareChange?.(event.target.checked);}}/><span>Compare GA4 totals</span></label>}<div className="bw-toolbar-actions">{this.props.onRefresh&&<button className="bw-button" disabled={refreshing} onClick={this.props.onRefresh}><Glyph name="refresh" />{refreshing?'Refreshing…':'Refresh'}</button>}{this.props.onExport&&<button className="bw-button bw-primary" disabled={refreshing||(!audience&&!email&&!edge)} onClick={this.props.onExport}><Glyph name="download"/>Export report</button>}{this.props.onScheduleReport&&<button className="bw-button" onClick={this.props.onScheduleReport}>Schedule report</button>}</div></div>
      <div className="bw-meta"><SourceStatus report={report} go={this.go}/><p role="status">{refreshing?'Refreshing · showing the last loaded report':`Updated ${reportTime(report.generatedAt)}`}</p></div>
      <div className="bw-tabs" role="tablist" aria-label="Analytics reports">{VIEWS.map(tab=><button key={tab} ref={element=>{this.tabs[tab]=element;}} id={`${this.uid}-tab-${tab}`} type="button" role="tab" aria-selected={tab===view} aria-controls={`${this.uid}-panel-${tab}`} tabIndex={tab===view?0:-1} onClick={()=>this.go(tab)} onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
        const index=VIEWS.indexOf(tab), next=event.key==='Home'?0:event.key==='End'?VIEWS.length-1:(index+(event.key==='ArrowRight'?1:-1)+VIEWS.length)%VIEWS.length;
        this.go(VIEWS[next]);this.tabs[VIEWS[next]]?.focus();
      }}>{VIEW_LABELS[tab]}</button>)}</div>
      <SourceWarnings report={report}/>
      {VIEWS.map(tab=><div key={tab} id={`${this.uid}-panel-${tab}`} role="tabpanel" aria-labelledby={`${this.uid}-tab-${tab}`} hidden={view!==tab} className="bw-tab-panel">{view===tab&&<>
        {view==='overview'&&<div className="bw-insights">{insights(report,compare).map(item=><article key={item.title} className={`bw-insight bw-insight-${item.tone}`}><span className="bw-insight-icon"><Glyph name={item.tone==='warning'?'warning':'chart'}/></span><div><strong>{item.title}</strong><p>{item.body}</p><button className="bw-text-button" onClick={()=>this.go(item.view)}>{item.action} <Glyph name="arrow"/></button></div></article>)}</div>}
        <MetricGrid metrics={metrics}/>
        {(view==='content'||view==='audience'||view==='overview')&&audience&&<div className="bw-period-caption"><span>GA4: {periodLabel(audience.period)} · {count(audience.totals.sessions)} visits · {count(audience.totals.newUsers)} new users · {duration(audience.totals.averageSessionDuration)} avg. session</span>{compare&&<span>{audience.hasPreviousBaseline?`Compared with ${periodLabel(audience.previousPeriod)}`:'No prior baseline; no trend is inferred.'}</span>}</div>}
        {view==='overview'?this.overview(audience,email,edge):view==='content'?(audience?this.content(audience):<Empty>GA4 data is unavailable. Check the source notice above.</Empty>):view==='audience'?(audience?this.audience(audience):<Empty>GA4 data is unavailable. Check the source notice above.</Empty>):view==='newsletter'?(email?this.newsletter(email):<Empty>Mailchimp data is unavailable. Check the source notice above.</Empty>):edge?this.delivery(edge):<Empty>Cloudflare data is unavailable. Check the source notice above.</Empty>}
      </>}</div>)}
      <footer className="bw-report-footer"><span>Hosts: {report.hosts.join(', ')}</span><span>Server cache expires {reportTime(report.expiresAt)} · Refresh respects the server cache.</span><Info label="report boundaries">Traffic alone does not measure public-service value or broadcast ratings. Each provider uses its own reporting window. The compare control applies to GA4 totals only.</Info></footer>
      {selected&&<dialog className="bw-detail-dialog" ref={element=>{this.dialog=element;}} aria-labelledby={`${this.uid}-detail-title`} onCancel={()=>this.setState({selected:null})} onClose={()=>this.setState({selected:null})}><header><div><p className="bw-eyebrow">Reported page</p><h3 id={`${this.uid}-detail-title`}>{pageLabel(selected.name)}</h3></div><button className="bw-button" autoFocus aria-label="Close page details" onClick={()=>this.setState({selected:null})}><Glyph name="close"/></button></header><p className="bw-detail-path">{selected.name}</p><div className="bw-mini-metrics"><div><small>Views</small><strong>{count(selected.views)}</strong></div><div><small>Active users</small><strong>{count(selected.activeUsers)}</strong></div><div><small>Engagement / user</small><strong>{duration(engagementPerUser(selected))}</strong></div></div>{audience&&<p className="bw-footnote">{periodLabel(audience.period)}</p>}<p className="bw-footnote">Reach and time spent do not establish a complete read. No per-page trend or conversion rate is supplied.</p>{selectedUrl&&<a href={selectedUrl} target="_blank" rel="noopener noreferrer" className="bw-button bw-primary">Open public page <Glyph name="external"/></a>}</dialog>}
    </div>;
  }
}
