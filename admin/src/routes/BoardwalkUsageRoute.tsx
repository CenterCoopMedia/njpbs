import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button, EmptyState, InlineMessage, TableFrame } from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import type { PreviewCoverage, UsageFriction, UsageJobs, UsageReport } from "../lib/boardwalk-usage";
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
        <p>Usage analytics began {visible.firstCollectedDate}. Dates and hours use Eastern time and include today so far. Counts cover only the destinations and actions listed below. The product team is owner-level accounts; everyone else counts as newsroom.</p>
        {[...visible.daily, ...visible.weekly].some(row => row.timezone === "UTC") && <p>Rows marked UTC were collected before Eastern dates began{visible.easternFromDate ? ` on ${visible.easternFromDate}` : ""}. On those rows, work after 7 or 8 PM Eastern appears on the next day. A date or week can have both a UTC row and an Eastern row; a person can appear in each.</p>}
        <UsageSections report={visible} />
      </>}
      <ContentAndProblemSections report={visible} />
    </>}
    <p>Start with the destinations with the most visible time and the busiest actions when deciding where to focus improvements. Review low-use features only after checking access, availability and enough collection time; these counts alone do not justify removing a feature.</p>
    <p><Link to={`${ROUTE_PATHS.guide}/boardwalk-usage`}>What Boardwalk records and why</Link></p>
  </div>;
}

const GROUPS = [["newsroom", "Newsroom"], ["product", "Product team"]] as const;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DRAFT_AGES = { day: "Under 1 day", week: "1 to 6 days", month: "7 to 29 days", older: "30 days or more" };
const minutes = (ms: number) => (ms / 60_000).toFixed(1);
const recorded = (value: number | null) => value === null ? "Not recorded" : String(value);
const perSession = ({ sessions, visibleMs }: { sessions: number; visibleMs: number }) => sessions ? minutes(visibleMs / sessions) : "No sessions";
const rate = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}% (${part} of ${whole})` : "None";
const roleLabel = (role: string) => role === "none" ? "No access tier" : `${role[0].toUpperCase()}${role.slice(1).replace(/_/g, " ")}`;
const weekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const dateLabel = (row: { date?: string; week?: string; timezone: string }) => `${row.date ?? row.week}${row.timezone === "UTC" ? " (UTC)" : ""}`;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section aria-labelledby={`usage-${id}`}><h3 id={`usage-${id}`}>{title}</h3>{children}</section>;
}

function Unavailable({ what }: { what: string }) {
  return <InlineMessage tone="warning">{what} could not be read completely, so no count is shown. Choose Refresh to try again.</InlineMessage>;
}

function UsageSections({ report }: { report: UsageReport }) {
  const today = report.daily.filter(row => row.timezone !== "UTC").at(-1);
  const eastern = report.daily.filter(row => row.timezone !== "UTC");
  const highest = Math.max(0, ...eastern.map(row => row.newsroom ?? 0));
  const peak = Math.max(1, highest);
  const heatPeak = Math.max(1, ...report.hourMs.newsroom.flat());
  const { current, prior, jobs } = report.friction;
  const previewRate = (part: keyof UsageJobs) => (_: UsageFriction, job: UsageJobs | null, coverage: PreviewCoverage | null) =>
    !job || !coverage || coverage.status === "unavailable" ? "Unavailable"
      : coverage.status === "partial" ? `${rate(job[part], job.previews)} since ${coverage.from}` : rate(job[part], job.previews);
  const coverage = jobs.status === "ready" ? jobs.previewCoverage : null;
  const frictionRows: [string, (friction: UsageFriction, jobs: UsageJobs | null, coverage: PreviewCoverage | null) => string][] = [
    ["Publish attempts repeated within 10 minutes on the same item", friction => String(friction.publish.repeats)],
    ["Items with a repeated publish attempt", friction => `${friction.publish.repeatedItems} of ${friction.publish.items}`],
    ["Preview attempts repeated within 10 minutes on the same item", friction => String(friction.preview.repeats)],
    ["Items with a repeated Preview attempt", friction => `${friction.preview.repeatedItems} of ${friction.preview.items}`],
    ["Preview jobs that failed", previewRate("failed")],
    ["Preview jobs that expired before building", previewRate("expired")],
    ["Moves straight back to the screen before last", friction => rate(friction.backForth, friction.transitions)],
    ["Uploads started in the period and still active after a day", (_, job) => job ? String(job.stuckUploads) : "Unavailable"],
  ];
  return <>
    <div className="boardwalk-usage-tiles">
      <article className="boardwalk-usage-tile"><h3>Newsroom active this week</h3>
        <strong>{recorded(report.weekCompare.thisWeek.newsroom)}</strong>
        <span>Last week {recorded(report.weekCompare.lastWeek.newsroom)}. Product team this week {recorded(report.weekCompare.thisWeek.product)}.</span></article>
      <article className="boardwalk-usage-tile"><h3>Newsroom active today</h3>
        <strong>{recorded(today?.newsroom ?? null)}</strong>
        <span>Product team {recorded(today?.product ?? null)}. Today is still in progress.</span></article>
      <article className="boardwalk-usage-tile"><h3>Average visible minutes per session</h3>
        <strong>{perSession(report.sessions.newsroom)}</strong>
        <span>Newsroom, {report.sessions.newsroom.sessions} sessions. Product team {perSession(report.sessions.product)}.</span></article>
      <article className="boardwalk-usage-tile"><h3>Open problem reports</h3>
        <strong>{report.problemReports.status === "ready" ? report.problemReports.open : "Unavailable"}</strong>
        <span>All open reports, not only this period.</span></article>
    </div>

    <Section id="daily" title="Active newsroom staff per day">
      <p>A staff account counts once per day. Agent and test accounts are excluded. Shaded columns are Saturdays and Sundays.</p>
      <div className="boardwalk-usage-bars" role="img"
        aria-label={`Bar chart of active newsroom staff per day. The highest day had ${highest}. Daily counts below list every day.`}>
        {eastern.map(row => <span key={row.date} className={weekend(row.date) ? "is-weekend" : undefined} title={`${row.date}: ${recorded(row.newsroom)}`}>
          <span style={{ blockSize: `${(row.newsroom ?? 0) / peak * 100}%` }} /></span>)}
      </div>
      {eastern.length > 0 && <p className="boardwalk-usage-axis" aria-hidden="true"><span>{eastern[0].date}</span><span>Highest day {highest}</span><span>{eastern.at(-1)!.date}</span></p>}
      <details><summary>Daily counts</summary>
        <TableFrame><table className="data-table"><thead><tr><th scope="col">Date</th><th scope="col">All staff</th><th scope="col">Newsroom</th><th scope="col">Product team</th></tr></thead>
          <tbody>{report.daily.map(row => <tr key={`${row.date}-${row.timezone}`}><th scope="row">{dateLabel(row)}</th><td>{row.activeUsers}</td><td>{recorded(row.newsroom)}</td><td>{recorded(row.product)}</td></tr>)}</tbody></table></TableFrame>
      </details>
      <h4>Distinct people per calendar week</h4>
      <p>Each account counts once from Monday to Sunday. Only weeks starting within the selected period appear; this week is still in progress.</p>
      <TableFrame><table className="data-table"><thead><tr><th scope="col">Week starting</th><th scope="col">All staff</th><th scope="col">Newsroom</th><th scope="col">Product team</th><th scope="col">Active by role</th></tr></thead>
        <tbody>{report.weekly.map(row => <tr key={`${row.week}-${row.timezone}`}><th scope="row">{dateLabel(row)}</th><td>{row.activeUsers}</td><td>{recorded(row.newsroom)}</td><td>{recorded(row.product)}</td>
          <td>{row.byRole.length ? row.byRole.map(role => `${roleLabel(role.role)} ${role.activeUsers}`).join(", ") : "Not recorded"}</td></tr>)}</tbody></table></TableFrame>
    </Section>

    <Section id="roles" title="Activity by role">
      <p>Roster counts current staff accounts with each access level. Active counts distinct people with any activity in the period. Sessions end after 30 minutes without activity.</p>
      {report.roleActivity.status === "ready" ? <TableFrame><table className="data-table"><thead><tr><th scope="col">Role</th><th scope="col">Team</th><th scope="col">Roster</th><th scope="col">Active</th><th scope="col">Sessions</th><th scope="col">Visible minutes</th><th scope="col">Minutes per active person</th></tr></thead>
        <tbody>{report.roleActivity.rows.map(row => <tr key={row.role}><th scope="row">{roleLabel(row.role)}</th><td>{row.group === "product" ? "Product team" : "Newsroom"}</td><td>{row.roster}</td><td>{row.active}</td><td>{row.sessions}</td><td>{minutes(row.visibleMs)}</td><td>{row.active ? minutes(row.visibleMs / row.active) : "None active"}</td></tr>)}</tbody></table></TableFrame>
        : <Unavailable what="The staff roster or active people" />}
    </Section>

    <Section id="hours" title="Newsroom visible minutes by hour and weekday">
      <p>Darker cells mean more visible time. Hours are Eastern, from midnight (0) to 11 PM (23).</p>
      <TableFrame><table className="data-table boardwalk-usage-heat"><thead><tr><th scope="col">Weekday</th>
        {Array.from({ length: 24 }, (_, hour) => <th scope="col" key={hour}>{hour}</th>)}<th scope="col">Newsroom total</th><th scope="col">Product team total</th></tr></thead>
        <tbody>{WEEKDAYS.map((weekday, index) => <tr key={weekday}><th scope="row">{weekday}</th>
          {report.hourMs.newsroom[index].map((ms, hour) => {
            // Five shade steps; each step's text color is checked for 4.5:1 contrast in the stylesheet.
            const step = Math.ceil(ms / heatPeak * 5);
            return <td key={hour} className={`boardwalk-usage-heat-${step}`}>{Math.round(ms / 60_000)}</td>;
          })}
          <td>{minutes(report.hourMs.newsroom[index].reduce((sum, ms) => sum + ms, 0))}</td>
          <td>{minutes(report.hourMs.product[index].reduce((sum, ms) => sum + ms, 0))}</td></tr>)}</tbody></table></TableFrame>
    </Section>

    <Section id="screens" title="Destinations">
      <p>Person-days count each person once per destination per day. Visible time excludes hidden tabs and may include idle time. It does not measure productivity or prove that someone was stuck. Browser closure and delivery failures can lose events. All-staff views and minutes include UTC rows and older rows without a team split.</p>
      <TableFrame><table className="data-table"><thead>
        <tr><td /><th scope="colgroup" colSpan={2}>Person-days</th><th scope="colgroup" colSpan={3}>Views</th><th scope="colgroup" colSpan={3}>Visible minutes</th></tr>
        <tr><th scope="col">Destination</th><th scope="col">Newsroom</th><th scope="col">Product team</th><th scope="col">All</th><th scope="col">Newsroom</th><th scope="col">Product team</th><th scope="col">All</th><th scope="col">Newsroom</th><th scope="col">Product team</th></tr></thead>
        <tbody>{report.screens.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{row.newsroom.personDays}</td><td>{row.product.personDays}</td>
          <td>{row.views}</td><td>{row.newsroom.views}</td><td>{row.product.views}</td>
          <td>{minutes(row.visibleMs)}</td><td>{minutes(row.newsroom.visibleMs)}</td><td>{minutes(row.product.visibleMs)}</td></tr>)}</tbody></table></TableFrame>
    </Section>

    <Section id="actions" title="Features">
      <p>Attempts include requests that fail and Previews that reuse an existing job. They do not prove completion or viewing and are not added to existing activity totals. Zero means no collected attempts in this period.</p>
      <TableFrame><table className="data-table"><thead>
        <tr><td /><th scope="colgroup" colSpan={3}>Uses</th><th scope="colgroup" colSpan={2}>Person-days</th><td /></tr>
        <tr><th scope="col">Feature</th><th scope="col">All</th><th scope="col">Newsroom</th><th scope="col">Product team</th><th scope="col">Newsroom</th><th scope="col">Product team</th><th scope="col">Last use in period</th></tr></thead>
        <tbody>{report.actions.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{row.count}</td><td>{row.newsroom.count}</td><td>{row.product.count}</td>
          <td>{row.newsroom.personDays}</td><td>{row.product.personDays}</td><td>{row.lastUsed ?? "None"}</td></tr>)}</tbody></table></TableFrame>
    </Section>

    <Section id="friction" title="Friction">
      <p>Each measure compares the selected period with the same number of days before it. Repeats and moves back can be deliberate; they show where to look, not that something failed.</p>
      <TableFrame><table className="data-table"><thead>
        <tr><td />{GROUPS.map(([group, label]) => <th scope="colgroup" colSpan={2} key={group}>{label}</th>)}</tr>
        <tr><th scope="col">Measure</th>{GROUPS.map(([group]) => <Fragment key={group}><th scope="col">This period</th><th scope="col">Prior period</th></Fragment>)}</tr></thead>
        <tbody>{frictionRows.map(([label, read]) => <tr key={label}><th scope="row">{label}</th>
          {GROUPS.map(([group]) => <Fragment key={group}>
            <td>{read(current[group], jobs.status === "ready" ? jobs.current[group] : null, coverage?.current ?? null)}</td>
            <td>{read(prior[group], jobs.status === "ready" ? jobs.prior[group] : null, coverage?.prior ?? null)}</td></Fragment>)}</tr>)}</tbody></table></TableFrame>
      {jobs.status !== "ready" && <Unavailable what="Preview job and upload records" />}
      <h4>Most frequent back-and-forth pairs this period</h4>
      {GROUPS.map(([group, label]) => <p key={group}>{label}: {current[group].pairs.length
        ? current[group].pairs.map(pair => `${pair.screens.join(" and ")} (${pair.count})`).join("; ") : "None"}</p>)}
    </Section>

    <Section id="notes" title="Data notes">
      <ul>
        <li>Usage analytics began {report.firstCollectedDate}{report.easternFromDate ? `; Eastern dates began ${report.easternFromDate}` : ""}.</li>
        <li>{report.excludedAccounts === null ? "The number of excluded accounts is unavailable." : `${report.excludedAccounts} agent, test or vendor accounts are excluded.`}</li>
        <li>Team, role, person-day, session, hour and friction counts began with this version of the report. Earlier rows show Not recorded or zero for them.</li>
        {coverage && (coverage.current.status !== "full" || coverage.prior.status !== "full") && <li>Preview job records are kept for 30 days, so Preview rates count only jobs from the last 30 days. A rate marked since a date covers part of its period; a period entirely older than 30 days is unavailable.</li>}
        <li>Minutes per session is an average. A median needs individual sessions, which this report does not keep.</li>
        <li>Not tracked: whether a publish finished, whether a Preview was viewed, screens outside the listed destinations, time in hidden tabs, typing, field values and search text.</li>
      </ul>
    </Section>
  </>;
}

// Content flow and problem reports read their own records, so they appear before any usage is collected.
function ContentAndProblemSections({ report }: { report: UsageReport }) {
  const teams = report.contentFlow.status === "ready" && report.contentFlow.teams === "ready";
  const teamHeaders = <><th scope="col">Newsroom</th><th scope="col">Product team</th><th scope="col">Other accounts</th></>;
  return <>
    <Section id="content" title="Content flow">
      {report.contentFlow.status === "ready" ? <>
        <p>Median time from creating a post to first publishing it, for posts first published in this period: {report.contentFlow.medianHoursToFirstPublish === null ? "no posts" : `${report.contentFlow.medianHoursToFirstPublish} hours`}. Other accounts are agents, imports and former staff.</p>
        {!teams && <InlineMessage tone="warning">The staff roster could not be read completely, so posts are not split by team.</InlineMessage>}
        <h4>Posts first published per week</h4>
        <TableFrame><table className="data-table"><thead><tr><th scope="col">Week starting</th><th scope="col">All posts</th>{teams && teamHeaders}</tr></thead>
          <tbody>{report.contentFlow.publishedWeeks.length ? report.contentFlow.publishedWeeks.map(row => <tr key={row.week}><th scope="row">{row.week}</th><td>{row.total}</td>{teams && <><td>{row.newsroom}</td><td>{row.product}</td><td>{row.other}</td></>}</tr>)
            : <tr><td colSpan={teams ? 5 : 2}>No posts were first published in this period.</td></tr>}</tbody></table></TableFrame>
        <h4>Open post drafts by age</h4>
        <TableFrame><table className="data-table"><thead><tr><th scope="col">Age</th><th scope="col">All drafts</th>{teams && teamHeaders}</tr></thead>
          <tbody>{report.contentFlow.openDrafts.map(row => <tr key={row.bucket}><th scope="row">{DRAFT_AGES[row.bucket]}</th><td>{row.total}</td>{teams && <><td>{row.newsroom}</td><td>{row.product}</td><td>{row.other}</td></>}</tr>)}</tbody></table></TableFrame>
      </> : <Unavailable what="Post records" />}
    </Section>

    <Section id="problems" title="Problem reports">
      {report.problemReports.status === "ready" ? <>
        <p>{report.problemReports.open} open. {report.problemReports.filed} filed in this period. Median time to resolve for the {report.problemReports.resolved} resolved in this period: {report.problemReports.medianDaysToResolve === null ? "none resolved" : `${report.problemReports.medianDaysToResolve} days`}.</p>
        <TableFrame><table className="data-table"><thead><tr><th scope="col">Page reported from</th><th scope="col">Reports filed</th></tr></thead>
          <tbody>{report.problemReports.topPages.length ? report.problemReports.topPages.map(row => <tr key={row.page}><th scope="row">{row.page}</th><td>{row.count}</td></tr>)
            : <tr><td colSpan={2}>No reports were filed in this period.</td></tr>}</tbody></table></TableFrame>
      </> : <Unavailable what="Problem reports" />}
    </Section>
  </>;
}

export function BoardwalkUsageRoute() {
  const { getIdToken, user } = useShell();
  const load = useCallback<UsageLoader>(async (days, signal) => {
    if (!getIdToken) throw new Error("Staff session required");
    return postFunction<UsageReport>("cmsGetBoardwalkUsage", await getIdToken(), { days }, {}, { appCheck: true, signal });
  }, [getIdToken]);
  return <BoardwalkUsageSurface key={user.uid} load={load} />;
}
