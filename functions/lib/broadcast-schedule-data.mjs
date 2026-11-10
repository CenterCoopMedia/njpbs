export const BROADCAST_SCHEDULE_SOURCE = {
  coverageEnd: "2026-11-05",
  coverageStart: "2026-10-01",
  label: "October 2026 CEC and ACML broadcast packet",
  received: "2026-09-23",
  timezone: "America/New_York",
};

const oneOnOneWeekday = [
  { station: "NJ PBS", time: "5:30 a.m." },
  { station: "NJ PBS", time: "7 p.m." },
  { station: "NJ PBS", time: "11:30 p.m." },
  { station: "Thirteen", time: "12 a.m." },
];
const oneOnOneSaturday = [
  { station: "NJ PBS", time: "7 a.m." },
  { station: "Thirteen", time: "7:30 a.m." },
];
const oneOnOneSunday = [
  { station: "NJ PBS", time: "11 a.m." },
];

const mediaFriday = [{ station: "NJ PBS", time: "8 p.m." }];
const mediaSunday = [{ station: "NJ PBS", time: "2:30 p.m." }];
const mediaMonday = [{ station: "NJ PBS", time: "8 p.m." }];

const rememberSaturday = [{ station: "NJ PBS", time: "4 p.m." }];
const rememberSunday = [
  { station: "NJ PBS", time: "4 p.m." },
  { station: "News 12+", time: "6 p.m." },
];
const rememberTuesday = [
  { station: "NJ PBS", time: "8 p.m." },
  { station: "News 12+", time: "10 p.m." },
];

const stateSaturday = [
  { station: "NJ PBS", time: "8 a.m." },
  { station: "Thirteen", time: "8:30 a.m." },
  { station: "NJ PBS", time: "5:30 p.m." },
];
const stateSunday = [
  { station: "WQXR", time: "6 a.m." },
  { station: "NJ PBS", time: "8 a.m." },
  { station: "WHYY", time: "11:30 a.m." },
  { station: "NJ PBS", time: "12 p.m." },
];
const stateMonday = [
  { station: "NJ PBS", time: "6 a.m." },
  { station: "News 12+", time: "10 p.m." },
];
const stateThursday = [{ station: "NJ PBS", time: "6 a.m." }];

const thinkSaturday = [
  { station: "NJ PBS", time: "5:30 a.m." },
  { station: "NJ PBS", time: "8:30 a.m." },
  { station: "Thirteen", time: "12:30 p.m." },
];
const thinkSunday = [
  { station: "NJ PBS", time: "5:30 a.m." },
  { station: "NJ PBS", time: "8:30 a.m." },
  { station: "News 12+", time: "10:30 a.m." },
  { station: "NJ PBS", time: "11:30 a.m." },
];
const thinkTuesday = [{ station: "NJ PBS", time: "6 a.m." }];
const thinkWednesday = [{ station: "WHYY", time: "11:30 p.m." }];

function date(value, slots, options = {}) {
  return { date: value, slots, ...options };
}

const episodes = [
  {
    program: "One-on-One with Steve Adubato",
    episode: "2951",
    title: "Joe Yaccarino; Steve Evert; Alisha Langford",
    dates: [date("2026-10-01", oneOnOneWeekday)],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2944",
    title: "Rebecca Pauline Jampol; Regina M. Egea and Bret Silver; Vincent Barba, MD",
    dates: [date("2026-10-02", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2959",
    title: "Jeremy Jordan; Cost n' Mayor",
    dates: [
      date("2026-10-03", oneOnOneSaturday, { premiere: true }),
      date("2026-10-04", oneOnOneSunday),
      date("2026-10-31", oneOnOneSaturday),
      date("2026-11-01", oneOnOneSunday),
    ],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2939",
    title: "Danielle West-Augustin; Joe Bertolino, Ed.D.; Mark Texel",
    dates: [date("2026-10-05", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2857",
    title: "Remembering the History of Latinos in New Jersey",
    dates: [date("2026-10-06", oneOnOneWeekday)],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2963",
    title: "Ryan DePersio; Holly Moscatiello",
    dates: [date("2026-10-07", oneOnOneWeekday, { premiere: true })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2940",
    title: "Howard Reid and Bridget Nkatta, DNP; Angelica Berrie; Jess Rauchberg, PhD",
    dates: [date("2026-10-08", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2958",
    title: "Darryl McDaniels",
    dates: [date("2026-10-09", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2961",
    title: "Adam Sliwinski and Jason Treuting; Hannah Corbin",
    dates: [
      date("2026-10-10", oneOnOneSaturday, {
        premiere: true,
        preemptedStations: ["Thirteen"],
      }),
      date("2026-10-11", oneOnOneSunday),
    ],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2953",
    title: "2026 New Jersey Sharing Network Celebration of Life",
    dates: [
      date("2026-10-12", oneOnOneWeekday),
      date("2026-10-29", oneOnOneWeekday, { preemptedStations: ["Thirteen"] }),
    ],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2956",
    title: "Eddie S. Glaude Jr., PhD",
    dates: [date("2026-10-13", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2960",
    title: "Isabel Klee",
    dates: [date("2026-10-14", oneOnOneWeekday, { premiere: true })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2853",
    title: "Remembering the History of Arts High School and Michael Graves",
    dates: [date("2026-10-15", oneOnOneWeekday)],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2954",
    title: "Celebrating 30 Years of the Russ Berrie Making A Difference Award",
    dates: [date("2026-10-16", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2962",
    title: "T.J. English",
    dates: [
      date("2026-10-17", oneOnOneSaturday, { premiere: true }),
      date("2026-10-18", oneOnOneSunday),
    ],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2946",
    title: "David D. Troutt",
    dates: [date("2026-10-19", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2918",
    title: "Father Edwin Leahy, O.S.B.; Kim Guadagno; Joseph Youngblood II, JD, PhD",
    dates: [date("2026-10-20", oneOnOneWeekday)],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2952",
    title: "Vanrick Vandenburg; Scott J. Mariani and Peter Hartney; Jacqueline Foley",
    dates: [date("2026-10-21", oneOnOneWeekday, { premiere: true })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2936",
    title: "Patrick F. Leahy, EdD; Bob Kendrick; Jeffrey Kanige",
    dates: [date("2026-10-22", oneOnOneWeekday)],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2926",
    title: "Remembering Mary Higgins Clark and Carol Higgins Clark",
    dates: [date("2026-10-23", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2968",
    title: "Michael Uslan; James Burke",
    dates: [
      date("2026-10-24", oneOnOneSaturday, { premiere: true }),
      date("2026-10-25", oneOnOneSunday),
    ],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2945",
    title: "George Helmy, EVP; Tom Donahue; Sarah Steward",
    dates: [date("2026-10-26", oneOnOneWeekday, { preemptedStations: ["Thirteen"] })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2922",
    title: "Remembering John F. Kennedy, Jr.",
    dates: [date("2026-10-27", oneOnOneWeekday)],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2969",
    title: "Usame Tunagur; Mike Spendley; Jess Rauchberg, PhD",
    detailsStatus: "pending",
    dates: [date("2026-10-28", oneOnOneWeekday, { premiere: true })],
  },
  {
    program: "One-on-One with Steve Adubato",
    episode: "2942",
    title: "Michael Perino",
    dates: [date("2026-10-30", oneOnOneWeekday)],
  },

  ...[
    ["101", "Jonathan Koppell, PhD", "2026-10-02", "2026-10-04", "2026-10-05"],
    ["102", "Tom Rosenstiel", "2026-10-09", "2026-10-11", "2026-10-12"],
    ["103", "Dominic Carter", "2026-10-16", "2026-10-18", "2026-10-19"],
    ["104", "Adam H. Johnson", "2026-10-23", "2026-10-25", "2026-10-26"],
  ].map(([episode, title, friday, sunday, monday]) => ({
    program: "Media Matters",
    episode,
    title,
    dates: [
      date(friday, mediaFriday, { premiere: true }),
      date(sunday, mediaSunday),
      date(monday, mediaMonday),
    ],
  })),
  {
    program: "Media Matters",
    episode: "105",
    title: "Sarabeth Berman",
    dates: [date("2026-10-30", mediaFriday, { premiere: true })],
  },

  ...[
    ["314", "Remembering George Washington", "2026-10-03", "2026-10-04", "2026-10-06"],
    ["307", "Remembering Tony Bennett", "2026-10-10", "2026-10-11", "2026-10-13"],
    ["403", "Remembering Olympia Dukakis and Bob McGrath", "2026-10-17", "2026-10-18", "2026-10-20"],
    ["401", "Remembering Luther Vandross", "2026-10-24", "2026-10-25", "2026-10-27"],
    ["303", "Remembering Toni Morrison", "2026-10-31", "2026-11-01", "2026-11-03"],
  ].map(([episode, title, saturday, sunday, tuesday]) => ({
    program: "Remember Them",
    episode,
    title,
    dates: [
      date(saturday, rememberSaturday),
      date(sunday, rememberSunday),
      date(tuesday, rememberTuesday),
    ],
  })),

  {
    program: "State of Affairs",
    episode: "1017",
    title: "Michael Goldstein, MD; Linda M. Czipo; Matthew Sarkees, PhD",
    dates: [date("2026-10-01", stateThursday)],
  },
  {
    program: "State of Affairs",
    episode: "1018",
    title: "U.S. Rep. Analilia Mejia; Sen. Michael L. Testa",
    dates: [
      date("2026-10-03", stateSaturday),
      date("2026-10-04", stateSunday),
      date("2026-10-05", stateMonday),
      date("2026-10-08", stateThursday),
    ],
  },
  {
    program: "State of Affairs",
    episode: "1019",
    title: "Sen. Holly Schepisi; Sen. Vin Gopal",
    dates: [
      date("2026-10-10", stateSaturday, { preemptedStations: ["Thirteen"] }),
      date("2026-10-11", stateSunday),
      date("2026-10-12", stateMonday),
      date("2026-10-15", stateThursday),
    ],
  },
  {
    program: "State of Affairs",
    episode: "1020",
    title: "George Helmy; Stefanie Murray",
    dates: [
      date("2026-10-17", stateSaturday),
      date("2026-10-18", stateSunday),
      date("2026-10-19", stateMonday),
    ],
  },
  {
    program: "State of Affairs",
    episode: "1021",
    title: "Lily Laux, PhD; Sen. Teresa Ruiz; Steve Beatty",
    detailsStatus: "pending",
    dates: [
      date("2026-10-24", stateSaturday),
      date("2026-10-25", stateSunday),
      date("2026-10-26", stateMonday),
      date("2026-10-29", stateThursday),
    ],
  },
  {
    program: "State of Affairs",
    episode: "1022",
    title: "Kimberly Boller, PhD; Sen. Latham Tiver; Frank Velez III",
    dates: [
      date("2026-10-31", stateSaturday),
      date("2026-11-01", stateSunday),
      date("2026-11-02", stateMonday),
      date("2026-11-05", stateThursday),
    ],
  },

  ...[
    ["820", "Lynn Hawkins; Kaitlin Van Saders; Bill Elliott", "2026-10-03", "2026-10-04", "2026-10-06", "2026-10-07"],
    ["821", "Making a Difference: The Next Generation of Environmental Advocates", "2026-10-10", "2026-10-11", "2026-10-13", "2026-10-14"],
    ["822", "Steve Heisman; Kristal Langford; Liz Graham", "2026-10-17", "2026-10-18", "2026-10-20", "2026-10-21"],
    ["824", "Todd Wolfson; Tashad Bristol", "2026-10-24", "2026-10-25", "2026-10-27", "2026-10-28"],
  ].map(([episode, title, saturday, sunday, tuesday, wednesday]) => ({
    program: "Think Tank with Steve Adubato",
    episode,
    title,
    dates: [
      date(saturday, thinkSaturday, episode === "821" ? { preemptedStations: ["Thirteen"] } : {}),
      date(sunday, thinkSunday),
      date(tuesday, thinkTuesday),
      date(wednesday, thinkWednesday),
    ],
  })),
  {
    program: "Think Tank with Steve Adubato",
    episode: "825",
    title: "Guest information pending",
    detailsStatus: "pending",
    dates: [
      date("2026-10-31", thinkSaturday),
      date("2026-11-01", thinkSunday),
      date("2026-11-03", thinkTuesday),
      date("2026-11-04", thinkWednesday),
    ],
  },
];

function timeMinutes(value) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s([ap])\.m\.$/.exec(value);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const hour = Number(match[1]) % 12;
  return hour * 60 + Number(match[2] ?? 0) + (match[3] === "p" ? 720 : 0);
}

export const BROADCAST_AIRINGS = episodes
  .flatMap((episode) =>
    episode.dates.flatMap((broadcastDate) =>
      broadcastDate.slots.map((slot) => ({
        date: broadcastDate.date,
        detailsStatus: episode.detailsStatus ?? "provided",
        episode: episode.episode,
        premiere: broadcastDate.premiere ?? false,
        program: episode.program,
        station: slot.station,
        status: broadcastDate.preemptedStations?.includes(slot.station)
          ? "preempted"
          : "scheduled",
        time: slot.time,
        title: episode.title,
      })),
    ),
  )
  .sort((left, right) =>
    left.date.localeCompare(right.date) ||
    timeMinutes(left.time) - timeMinutes(right.time) ||
    left.station.localeCompare(right.station),
  );

function dateAtNoon(value) {
  return new Date(`${value}T12:00:00Z`);
}

export function addScheduleDays(value, days) {
  const next = dateAtNoon(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function scheduleWeekStart(value) {
  const current = dateAtNoon(value);
  const day = current.getUTCDay();
  current.setUTCDate(current.getUTCDate() - (day === 0 ? 6 : day - 1));
  return current.toISOString().slice(0, 10);
}

export const BROADCAST_WEEK_STARTS = Array.from(
  new Set(BROADCAST_AIRINGS.map((airing) => scheduleWeekStart(airing.date))),
).sort();

export function scheduleWeekForDate(today, requested) {
  if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    const parsed = dateAtNoon(requested);
    if (!Number.isNaN(parsed.getTime())) {
      const requestedWeek = scheduleWeekStart(requested);
      return (
        BROADCAST_WEEK_STARTS.find((week) => week >= requestedWeek) ??
        BROADCAST_WEEK_STARTS.at(-1) ??
        requestedWeek
      );
    }
  }
  const current = scheduleWeekStart(today);
  if (BROADCAST_WEEK_STARTS.includes(current)) return current;
  return (
    BROADCAST_WEEK_STARTS.find((week) => week > current) ??
    BROADCAST_WEEK_STARTS.at(-1) ??
    current
  );
}

export function scheduleDaysForWeek(weekStart) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addScheduleDays(weekStart, index);
    return {
      date,
      airings: BROADCAST_AIRINGS.filter((airing) => airing.date === date),
      withinCoverage:
        date >= BROADCAST_SCHEDULE_SOURCE.coverageStart &&
        date <= BROADCAST_SCHEDULE_SOURCE.coverageEnd,
    };
  });
}

export function adjacentScheduleWeek(weekStart, direction) {
  const index = BROADCAST_WEEK_STARTS.indexOf(weekStart);
  if (index === -1) return null;
  return BROADCAST_WEEK_STARTS[index + direction] ?? null;
}

export function validateBroadcastSchedule(airings = BROADCAST_AIRINGS) {
  const seen = new Set();
  for (const airing of airings) {
    if (
      airing.date < BROADCAST_SCHEDULE_SOURCE.coverageStart ||
      airing.date > BROADCAST_SCHEDULE_SOURCE.coverageEnd
    ) {
      throw new Error(`Broadcast date is outside the source coverage: ${airing.date}`);
    }
    if (!airing.program || !airing.episode || !airing.station || !airing.time || !airing.title) {
      throw new Error(`Broadcast entry is incomplete: ${airing.date}`);
    }
    const key = [
      airing.date,
      airing.time,
      airing.station,
      airing.program,
      airing.episode,
    ].join("|");
    if (seen.has(key)) throw new Error(`Duplicate broadcast entry: ${key}`);
    seen.add(key);
  }
}

validateBroadcastSchedule();
