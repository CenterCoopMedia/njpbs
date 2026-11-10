import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { AsyncActionButton, Button, InlineMessage, Select, TextInput } from "../components/ui/Primitives";
import { Icon } from "../components/ui/Icon";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { useAuth } from "../context/AuthContext";
import {
  adjacentScheduleWeek,
  scheduleDaysForWeek,
  scheduleWeekForDate,
  scheduleWeekStarts,
  validateBroadcastSchedule,
  type BroadcastAiring,
  type BroadcastSchedule,
} from "../data/broadcast-schedule";
import {
  filterBroadcastAirings,
  groupEpisodeAirings,
  parseScheduleStatus,
  scheduleCoverageState,
  todayInTimeZone,
} from "../lib/schedule-workspace";
import { cmsGetBroadcastSchedule } from "../lib/functions";
import "./ScheduleRoute.css";

// Retain these exports for existing consumers and the deterministic gallery.
export { groupEpisodeAirings, todayInTimeZone } from "../lib/schedule-workspace";
export type { EpisodeAiringGroup } from "../lib/schedule-workspace";

const fullDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
});
const shortDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", month: "short", day: "numeric",
});
const sourceDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
});
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });

function formatDate(value: string, formatter: Intl.DateTimeFormat): string {
  return formatter.format(new Date(`${value}T12:00:00Z`));
}

function weekLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T12:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const startYear = start.getUTCFullYear() !== end.getUTCFullYear() ? `, ${start.getUTCFullYear()}` : "";
  return `${shortDate.format(start)}${startYear} to ${shortDate.format(end)}, ${end.getUTCFullYear()}`;
}

function ScheduleDay({ date, airings, withinCoverage, filtered, today }: {
  date: string;
  airings: readonly BroadcastAiring[];
  withinCoverage: boolean;
  filtered: boolean;
  today: string;
}) {
  const groups = groupEpisodeAirings(airings);
  return (
    <section className="broadcast-day" aria-labelledby={`schedule-${date}`} data-today={date === today}>
      <div className="broadcast-day-heading">
        <h2 id={`schedule-${date}`}><time dateTime={date}>{formatDate(date, fullDate)}</time></h2>
        {date === today ? <span className="broadcast-today">Today</span> : null}
        <span>{withinCoverage ? `${airings.length} listed ${airings.length === 1 ? "slot" : "slots"}` : "Outside coverage"}</span>
      </div>
      {!withinCoverage ? (
        <p className="broadcast-empty">Outside this source packet's coverage.</p>
      ) : groups.length ? (
        <div className="broadcast-episode-list">
          {groups.map((group) => (
            <article className="broadcast-episode" key={JSON.stringify([group.program, group.episode, group.title])}>
              <div className="broadcast-episode-copy">
                <p className="broadcast-program">{group.program}</p>
                <h3>{group.title}</h3>
                <div className="broadcast-episode-meta">
                  <span>Episode {group.episode}</span>
                  {group.premiere ? <span className="broadcast-premiere">Premiere</span> : null}
                  {group.detailsStatus === "pending" ? <span className="broadcast-pending">Description pending</span> : null}
                </div>
              </div>
              <ul className="broadcast-slots" aria-label={`Broadcast times for ${group.program}, episode ${group.episode}`}>
                {group.slots.map((slot, index) => (
                  <li key={`${slot.station}-${slot.time}-${index}`} data-status={slot.status}>
                    <span className="broadcast-time">{slot.time}</span>
                    <span className="broadcast-station">{slot.station}</span>
                    {slot.status === "preempted" ? <strong className="broadcast-preempted">Preempted</strong> : null}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      ) : (
        <p className="broadcast-empty">{filtered ? "No broadcasts match these filters." : "No broadcast times are listed for this day."}</p>
      )}
    </section>
  );
}

export function ScheduleSurface({
  schedule, today: suppliedToday, onRefresh, refreshing = false, checkedAt, refreshError = "",
}: {
  schedule: BroadcastSchedule;
  today?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  checkedAt?: Date;
  refreshError?: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clockDate, setClockDate] = useState(() => todayInTimeZone(schedule.source.timezone));
  const today = suppliedToday ?? clockDate;
  const requestedWeek = searchParams.get("week");
  const requestedDay = searchParams.get("day");
  const weekStart = scheduleWeekForDate(schedule.source, today, requestedWeek);
  const days = useMemo(() => scheduleDaysForWeek(schedule, weekStart), [schedule, weekStart]);
  const selectedDay = days.some((day) => day.date === requestedDay) ? requestedDay : null;
  const query = searchParams.get("q") ?? "";
  const station = searchParams.get("station") ?? "";
  const program = searchParams.get("program") ?? "";
  const status = parseScheduleStatus(searchParams.get("status"));
  const filtered = Boolean(query.trim() || station || program || status !== "all");
  const filteredDays = useMemo(() => days.map((day) => ({
    ...day, airings: filterBroadcastAirings(day.airings, { query, station, program, status }),
  })), [days, query, station, program, status]);
  const visibleDays = selectedDay ? filteredDays.filter((day) => day.date === selectedDay) : filteredDays;
  const visibleAirings = visibleDays.flatMap((day) => day.airings);
  const listedDays = selectedDay ? visibleDays : visibleDays.filter((day) => day.airings.length > 0);
  const totalSlots = days.filter((day) => !selectedDay || day.date === selectedDay)
    .reduce((total, day) => total + day.airings.length, 0);
  const preemptions = visibleAirings.filter((airing) => airing.status === "preempted").length;
  const previous = adjacentScheduleWeek(schedule.source, weekStart, -1);
  const next = adjacentScheduleWeek(schedule.source, weekStart, 1);
  const weeks = useMemo(() => scheduleWeekStarts(schedule.source), [schedule.source]);
  const stations = useMemo(() => [...new Set(schedule.airings.map((airing) => airing.station))].sort(), [schedule]);
  const programs = useMemo(() => [...new Set(schedule.airings.map((airing) => airing.program))].sort(), [schedule]);
  const coverage = scheduleCoverageState(schedule.source, today);
  const timezoneLabel = schedule.source.timezone === "America/New_York" ? "Eastern time" : schedule.source.timezone;

  // Only a local clock: no background API polling. Rollover also catches a sleeping tab.
  useEffect(() => {
    if (suppliedToday) return;
    const update = () => setClockDate(todayInTimeZone(schedule.source.timezone));
    update();
    const timer = window.setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [schedule.source.timezone, suppliedToday]);

  useEffect(() => {
    if ((requestedWeek && requestedWeek !== weekStart) || (requestedDay && !selectedDay)) {
      setSearchParams((current) => {
        const updated = new URLSearchParams(current);
        if (requestedWeek && requestedWeek !== weekStart) updated.set("week", weekStart);
        if (requestedDay && !selectedDay) updated.delete("day");
        return updated;
      }, { replace: true });
    }
  }, [requestedWeek, requestedDay, selectedDay, setSearchParams, weekStart]);

  function updateParams(values: Record<string, string | null>, replace = false) {
    setSearchParams((current) => {
      const updated = new URLSearchParams(current);
      for (const [key, value] of Object.entries(values)) {
        if (value) updated.set(key, value);
        else updated.delete(key);
      }
      return updated;
    }, { replace });
  }
  function selectWeek(value: string | null) {
    if (value) updateParams({ week: value, day: null });
  }
  function clearFilters() {
    updateParams({ q: null, station: null, program: null, status: null });
  }

  return (
    <div className="broadcast-workspace">
      <section className="broadcast-source" aria-label="Schedule source and coverage">
        <div className="broadcast-source-copy">
          <p className="broadcast-source-label">Source packet · Read only</p>
          <h2>{formatDate(schedule.source.coverageStart, schedule.source.coverageStart.slice(0, 4) === schedule.source.coverageEnd.slice(0, 4) ? shortDate : sourceDate)} to {formatDate(schedule.source.coverageEnd, sourceDate)}</h2>
          <p className="broadcast-coverage" data-coverage={coverage}>
            {coverage === "upcoming" ? "Upcoming coverage — this packet does not include today."
              : coverage === "expired" ? "Coverage has ended — this packet does not include today."
                : "Today is within this packet's coverage. This is not a live feed."}
          </p>
          <details className="broadcast-source-details">
            <summary>Source details and update limits</summary>
            <p>{schedule.source.label}. Received {formatDate(schedule.source.received, sourceDate)}.</p>
            <p>Refresh checks the CMS for its available packet. It does not import new broadcasts or confirm last-minute changes.</p>
          </details>
        </div>
        <div className="broadcast-source-actions">
          <p className="broadcast-timezone"><Icon name="activity" /> All times in {timezoneLabel}.</p>
          {onRefresh ? (
            <AsyncActionButton variant="primary" label="Refresh schedule" pendingLabel="Checking schedule"
              pending={refreshing} onClick={onRefresh} pendingAnnouncement="Checking the CMS for a schedule packet" />
          ) : null}
          <p className="broadcast-checked" role="status">
            {checkedAt ? <>Last checked <time dateTime={checkedAt.toISOString()}>{new Intl.DateTimeFormat("en-US", {
              timeZone: schedule.source.timezone, month: "short", day: "numeric", year: "numeric",
              hour: "numeric", minute: "2-digit", timeZoneName: "short",
            }).format(checkedAt)}</time></> : "Source receipt date is not a live update time."}
          </p>
        </div>
      </section>
      {refreshError ? (
        <InlineMessage tone="error" title="Could not check for a newer packet">
          Showing the last successfully loaded schedule. Use Refresh schedule to try again.
        </InlineMessage>
      ) : null}

      <section className="broadcast-controls" aria-label="Browse the schedule">
        <div className="broadcast-week-controls">
          <Button aria-label="Previous schedule week" disabled={!previous} onClick={() => selectWeek(previous)}>
            <Icon name="arrow-left" /><span className="button-compact-label">Previous</span>
          </Button>
          <label className="broadcast-week-select">
            <span>Schedule week</span>
            <Select value={weekStart} onChange={(event) => selectWeek(event.target.value)}>
              {weeks.map((week) => <option key={week} value={week}>{weekLabel(week)}</option>)}
            </Select>
          </label>
          <Button aria-label="Next schedule week" disabled={!next} onClick={() => selectWeek(next)}>
            <span className="button-compact-label">Next</span><Icon name="arrow-right" />
          </Button>
          <Button className="broadcast-current-week" disabled={coverage !== "covered"}
            title={coverage !== "covered" ? "Today is outside the source packet's coverage" : "Return to the week containing today"}
            onClick={() => selectWeek(scheduleWeekForDate(schedule.source, today))}>This week</Button>
        </div>

        <div className="broadcast-filters" role="search" aria-label="Filter broadcast schedule">
          <label className="broadcast-search"><span>Search this week</span>
            <TextInput type="search" value={query} placeholder="Program, guest or episode"
              onChange={(event) => updateParams({ q: event.target.value }, true)} />
          </label>
          <label><span>Station</span><Select value={station} onChange={(event) => updateParams({ station: event.target.value })}>
            <option value="">All stations</option>
            {station && !stations.includes(station) ? <option value={station}>{station} (not in packet)</option> : null}
            {stations.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select></label>
          <label><span>Program</span><Select value={program} onChange={(event) => updateParams({ program: event.target.value })}>
            <option value="">All programs</option>
            {program && !programs.includes(program) ? <option value={program}>{program} (not in packet)</option> : null}
            {programs.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select></label>
          <label><span>Show</span><Select value={status} onChange={(event) => updateParams({ status: event.target.value === "all" ? null : event.target.value })}>
            <option value="all">All broadcasts</option><option value="premieres">Premieres</option>
            <option value="preempted">Preempted</option><option value="pending">Description pending</option>
          </Select></label>
        </div>

        <div className="broadcast-day-nav" role="group" aria-label="Choose a day">
          <button type="button" aria-label="Full week" aria-pressed={!selectedDay} onClick={() => updateParams({ day: null })}>
            <span>View</span><strong>Week</strong><span>All days</span>
          </button>
          {filteredDays.map((day) => (
            <button type="button" key={day.date} aria-pressed={selectedDay === day.date}
              aria-current={day.date === today ? "date" : undefined}
              aria-label={`${formatDate(day.date, fullDate)}: ${day.withinCoverage ? `${day.airings.length} matching broadcast slots` : "outside coverage"}`}
              data-outside={!day.withinCoverage} onClick={() => updateParams({ day: day.date })}>
              <span>{day.date === today ? "Today" : formatDate(day.date, weekday)}</span>
              <strong>{Number(day.date.slice(-2))}</strong>
              <span>{day.withinCoverage ? `${day.airings.length} ${day.airings.length === 1 ? "slot" : "slots"}` : "Not covered"}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="broadcast-results-heading">
        <p role="status" aria-atomic="true">
          <strong>{visibleAirings.length}</strong>{filtered ? ` of ${totalSlots}` : ""} listed {visibleAirings.length === 1 && !filtered ? "slot" : "slots"}
          {selectedDay ? ` on ${formatDate(selectedDay, shortDate)}` : " this week"}
          {preemptions ? ` · ${preemptions} preempted` : ""}
        </p>
        {filtered ? <Button variant="ghost" onClick={clearFilters}>Clear filters</Button> : null}
      </div>
      {filtered && visibleAirings.length === 0 && visibleDays.some((day) => day.withinCoverage) ? (
        <div className="broadcast-no-results">
          <strong>No broadcasts match these filters.</strong>
          <p>Clear the filters, choose another day, or move to a different week. Check the source coverage above.</p>
        </div>
      ) : null}
      {!filtered && !selectedDay && visibleAirings.length === 0 ? (
        <div className="broadcast-no-results">
          <strong>No broadcast times are listed for this week.</strong>
          <p>Choose a day to check its coverage, or choose a different week. Missing listings do not confirm that a station is off air.</p>
        </div>
      ) : null}
      <div className="broadcast-days">
        {listedDays.map((day) => <ScheduleDay key={day.date} {...day} filtered={filtered} today={today} />)}
      </div>
      <p className="broadcast-footer">Listed slots include preemptions. Missing listings do not confirm that a station is off air.</p>
    </div>
  );
}

export function ScheduleRoute() {
  const { getIdToken } = useAuth();
  const [loaded, setLoaded] = useState<{
    schedule: BroadcastSchedule; checkedAt: Date; tokenProvider: typeof getIdToken;
  } | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(true);
  // Provider replacement invalidates this snapshot; the authenticated shell owns session admission.
  const visible = loaded?.tokenProvider === getIdToken ? loaded : null;

  useEffect(() => {
    let active = true;
    inFlight.current = true;
    setRefreshing(true);
    setError("");
    void (async () => {
      try {
        const token = await getIdToken();
        if (!active) return;
        const response = await cmsGetBroadcastSchedule(token);
        validateBroadcastSchedule(response);
        if (active) setLoaded({ schedule: response, checkedAt: new Date(), tokenProvider: getIdToken });
      } catch (cause: unknown) {
        if (active) {
          const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : null;
          // Retain data for transient failures, not for an explicit access denial.
          if (status === 401 || status === 403) setLoaded(null);
          setError("The verified broadcast schedule could not be loaded.");
        }
      } finally {
        if (active) { inFlight.current = false; setRefreshing(false); }
      }
    })();
    return () => { active = false; };
  }, [attempt, getIdToken]);

  function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    setAttempt((value) => value + 1);
  }

  if (!visible && error && !refreshing) {
    return <InlineMessage tone="error" title="Broadcast schedule unavailable">
      <span>{error}</span><Button onClick={refresh}>Try again</Button>
    </InlineMessage>;
  }
  if (!visible) {
    return <LoadingIndicator label="Loading the broadcast schedule" stages={["Asking the CMS for the verified source packet"]} />;
  }
  return <ScheduleSurface schedule={visible.schedule} checkedAt={visible.checkedAt}
    refreshing={refreshing} onRefresh={refresh} refreshError={error} />;
}
