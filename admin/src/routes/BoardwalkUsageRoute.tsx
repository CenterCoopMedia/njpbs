import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, EmptyState, InlineMessage, TableFrame } from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import type { UsageReport } from "../lib/boardwalk-usage";
import { postFunction } from "../lib/functions";
import { ROUTE_PATHS } from "../lib/routes";
import { useShell } from "./ShellContext";
import "./BoardwalkUsageRoute.css";

type Days = 7 | 30 | 90;
export type UsageLoader = (days: Days, signal: AbortSignal) => Promise<UsageReport>;

export function BoardwalkUsageSurface({ load }: { load: UsageLoader }) {
  const [days, setDays] = useState<Days>(30);
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setPending(true); setFailed(false);
    void load(days, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        if (value.days !== days) throw new Error("Reporting window mismatch");
        setReport(value);
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [days, refresh, load]);
  const visible = report?.days === days ? report : null;
  return <div className="boardwalk-usage">
    <div><Link to={ROUTE_PATHS.reports}>Back to problem reports</Link>
      <h2>Boardwalk usage analytics</h2>
      <p>See which destinations and tools staff rely on. These are aggregate counts; no person or content details appear here.</p>
    </div>
    <div className="boardwalk-usage-toolbar">
      <label>Reporting period <select value={days} onChange={event => setDays(Number(event.target.value) as Days)}>
        <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
      </select></label>
      <Button disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh</Button>
    </div>
    {pending && <LoadingIndicator label="Loading Boardwalk usage" />}
    {failed && <InlineMessage tone="warning">Boardwalk usage could not be loaded. Check your connection and choose Refresh to try again.</InlineMessage>}
    {visible && <>
      {!visible.analyticsEnabled && <InlineMessage tone="info">New usage analytics collection is off. Staff will receive a notice before it begins. Existing activity totals can still appear below.</InlineMessage>}
      <section aria-labelledby="usage-history"><h3 id="usage-history">Existing activity</h3>
        <p>These totals use existing activity logs for the selected period. They include retained staff accounts and exclude marked agent and test accounts, unknown accounts and system activity. They are operations, rather than destination views or time spent.</p>
        {visible.history.status === "ready" ? <TableFrame><table className="data-table"><thead><tr><th scope="col">Activity</th><th scope="col">Operations</th></tr></thead>
          <tbody>{visible.history.actions.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{row.count}</td></tr>)}</tbody></table></TableFrame>
          : <InlineMessage tone="warning">Existing activity totals are unavailable. Missing dates, an incomplete staff list or a service failure can prevent a complete count.</InlineMessage>}
      </section>
      {!visible.firstCollectedDate ? <EmptyState title="No new usage analytics collected" description="Time without analytics does not mean a tool is unused." /> : <>
        <p>Usage analytics began {visible.firstCollectedDate}. Dates use UTC and include today so far. Counts cover only the destinations and actions listed below.</p>
        <section aria-labelledby="usage-daily"><h3 id="usage-daily">Active staff per day</h3>
          <p>A staff account counts once per day. Agent and test accounts are excluded.</p>
          <TableFrame><table className="data-table"><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Active staff</th></tr></thead>
            <tbody>{visible.daily.map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{row.activeUsers}</td></tr>)}</tbody></table></TableFrame>
        </section>
        <section aria-labelledby="usage-weekly"><h3 id="usage-weekly">Active staff per calendar week</h3>
          <p>Each account counts once from Monday to Sunday (UTC). Only weeks starting within the selected period appear; this week is still in progress.</p>
          <TableFrame><table className="data-table"><thead><tr><th scope="col">Week starting</th><th scope="col">Active staff</th></tr></thead>
            <tbody>{visible.weekly.map(row => <tr key={row.week}><th scope="row">{row.week}</th><td>{row.activeUsers}</td></tr>)}</tbody></table></TableFrame>
        </section>
        <section aria-labelledby="usage-screens"><h3 id="usage-screens">Destinations, most to least used</h3>
          <p>Visible time excludes hidden tabs and may include idle time. It does not measure productivity or prove that someone was stuck. Browser closure and delivery failures can lose events.</p>
          <TableFrame><table className="data-table"><thead><tr><th scope="col">Destination</th><th scope="col">Views</th><th scope="col">Visible minutes</th></tr></thead>
            <tbody>{visible.screens.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{row.views}</td><td>{(row.visibleMs / 60_000).toFixed(1)}</td></tr>)}</tbody></table></TableFrame>
        </section>
        <section aria-labelledby="usage-actions"><h3 id="usage-actions">Actions, most to least used</h3>
          <p>Attempts include requests that fail and Previews that reuse an existing job. They do not prove completion or viewing and are not added to existing activity totals. Zero means no collected attempts in this period.</p>
          <TableFrame><table className="data-table"><thead><tr><th scope="col">Action</th><th scope="col">Uses</th></tr></thead>
            <tbody>{visible.actions.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{row.count}</td></tr>)}</tbody></table></TableFrame>
        </section>
      </>}
    </>}
    <p>Start with the destinations with the most visible time and the busiest actions when deciding where to focus improvements. Review low-use features only after checking access, availability and enough collection time; these counts alone do not justify removing a feature.</p>
    <p><Link to={`${ROUTE_PATHS.guide}/boardwalk-usage`}>What Boardwalk records and why</Link></p>
  </div>;
}

export function BoardwalkUsageRoute() {
  const { getIdToken, user } = useShell();
  const load = useCallback<UsageLoader>(async (days, signal) => {
    if (!getIdToken) throw new Error("Staff session required");
    return postFunction<UsageReport>("cmsGetBoardwalkUsage", await getIdToken(), { days }, {}, { appCheck: true, signal });
  }, [getIdToken]);
  return <BoardwalkUsageSurface key={user.uid} load={load} />;
}
