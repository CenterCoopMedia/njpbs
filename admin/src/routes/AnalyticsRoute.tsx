import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { AnalyticsDays, AnalyticsReport } from '../../../packages/content-core/src/analytics';
import { useAuth } from '../context/AuthContext';
import { canViewAnalytics } from '../lib/access';
import { getAnalytics } from '../lib/analytics';
import { HttpError } from '../lib/functions';
import { RequireCapability } from './RequireCapability';
import { AnalyticsDashboard } from '../components/analytics/AnalyticsDashboard';
import { downloadCsv, exportRows, parseView, type AnalyticsView } from '../components/analytics/analytics-model';
import '../components/analytics/AnalyticsDashboard.css';

// Preserve the exports used by the existing development gallery and route tests.
export type AnalyticsLoader = (days: AnalyticsDays, signal: AbortSignal) => Promise<AnalyticsReport>;
function Skeleton({ days, onDaysChange, fixedPeriod, loading }: {
  days: AnalyticsDays;
  onDaysChange: (days: AnalyticsDays) => void;
  fixedPeriod: boolean;
  loading: boolean;
}) {
  return <div className="bw-analytics"><div className="bw-toolbar"><label>Reporting period<select value={days} disabled={fixedPeriod} onChange={event=>onDaysChange(Number(event.target.value) as AnalyticsDays)}><option value={7}>Last 7 complete days</option><option value={30}>Last 30 complete days</option><option value={90}>Last 90 complete days</option></select></label>{loading&&<div className="bw-toolbar-actions"><button className="bw-button" disabled>Loading…</button><button className="bw-button bw-primary" disabled>Export report</button></div>}</div>{loading&&<><p role="status">Loading analytics…</p><div className="bw-skeleton-grid" aria-hidden="true">{Array.from({length:8},(_,i)=><div className="bw-skeleton" key={i}><span/><span/><span/></div>)}</div></>}</div>;
}
/** Keep this router-independent: existing gallery/tests can pass an injected loader. */
export function AnalyticsSurface({ load, view, compare, onViewChange, onCompareChange, initialDays = 7, fixedPeriod = false, preview = false }: {
  load: AnalyticsLoader;
  view?: AnalyticsView;
  compare?: boolean;
  onViewChange?: (view: AnalyticsView) => void;
  onCompareChange?: (compare: boolean) => void;
  initialDays?: AnalyticsDays;
  fixedPeriod?: boolean;
  preview?: boolean;
}) {
  const [days,setDays]=useState<AnalyticsDays>(initialDays);
  const [refresh,setRefresh]=useState(0);
  const [report,setReport]=useState<AnalyticsReport|null>(null);
  const [pending,setPending]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const request=useRef(0);
  useEffect(()=>{
    const generation=++request.current;
    const controller=new AbortController();
    setPending(true); setError(null);
    // Retain the previous report only for a same-window refresh. Never relabel old data.
    setReport(previous=>previous?.days===days ? previous : null);
    void load(days,controller.signal).then(value=>{
      if(controller.signal.aborted || generation!==request.current)return;
      if(value.days!==days)throw new Error('The report does not match the requested period.');
      setReport(value);
    }).catch((reason:unknown)=>{
      if(controller.signal.aborted || generation!==request.current)return;
      // Do not echo arbitrary transport errors or provider internals into the UI.
      setError(reason instanceof HttpError && [401,403].includes(reason.status)
        ? 'Analytics access and a valid session are required.'
        : 'Check your connection and try again.');
    }).finally(()=>{
      if(!controller.signal.aborted && generation===request.current)setPending(false);
    });
    return()=>controller.abort();
  },[days,refresh,load]);
  // This guard hides an old window immediately, before the request effect runs.
  const visible=report?.days===days ? report : null;
  return <>
    {error&&<div className="bw-analytics"><div role="alert" className="bw-notice"><strong>Analytics could not be loaded.</strong> {error}{visible&&<p>Showing the last successfully loaded report for this same period.</p>}<button className="bw-button" onClick={()=>setRefresh(value=>value+1)}>Retry</button></div></div>}
    {!visible&&(pending||error)&&<Skeleton days={days} onDaysChange={setDays} fixedPeriod={fixedPeriod} loading={pending}/>}
    {visible&&<AnalyticsDashboard report={visible} refreshing={pending} preview={preview} view={view} compare={compare} onViewChange={onViewChange} onCompareChange={onCompareChange}
      onDaysChange={fixedPeriod ? undefined : setDays} onRefresh={()=>setRefresh(value=>value+1)}
      onExport={()=>downloadCsv(exportRows(visible),`njpbs-analytics-${visible.generatedAt.slice(0,10)}.csv`)}/> }
  </>;
}
function ConnectedAnalytics() {
  const {getIdToken}=useAuth();
  const [params,setParams]=useSearchParams();
  const load=useCallback<AnalyticsLoader>(async(days,signal)=>getAnalytics(await getIdToken(),days,signal),[getIdToken]);
  const changeParam=(name:string,value:string)=>setParams(previous=>{const next=new URLSearchParams(previous);next.set(name,value);return next;},{replace:true});
  return <AnalyticsSurface load={load} view={parseView(params.get('view'))} compare={params.get('compare')!=='off'}
    onViewChange={view=>changeParam('view',view)} onCompareChange={compare=>changeParam('compare',compare?'on':'off')}/>;
}
export function AnalyticsRoute(){
  // Do not mount the loader before the existing role guard admits the user.
  return <RequireCapability allowed={canViewAnalytics} notice="Your account does not have access to analytics."><ConnectedAnalytics/></RequireCapability>;
}
