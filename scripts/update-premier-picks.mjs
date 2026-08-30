const footballToken = process.env.FOOTBALL_DATA_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
const season = process.env.SEASON_START_YEAR || "2026";

if (!footballToken || !supabaseUrl || !supabaseSecret) {
  throw new Error(
    "Missing FOOTBALL_DATA_TOKEN, SUPABASE_URL or SUPABASE_SECRET_KEY."
  );
}

const endpoint =
  `https://api.football-data.org/v4/competitions/PL/matches?season=${season}`;

const response = await fetch(endpoint, {
  headers: {
    "X-Auth-Token": footballToken
  }
});

if (!response.ok) {
  throw new Error(
    `football-data.org ${response.status}: ${await response.text()}`
  );
}

const payload = await response.json();

const matches = payload.matches || [];

/* -----------------------------------------------------------
   LAST FIVE RESULTS
----------------------------------------------------------- */

function resultForTeam(match, teamId) {
  if (
    match.status !== "FINISHED" ||
    match.score?.fullTime?.home == null ||
    match.score?.fullTime?.away == null
  ) {
    return null;
  }

  const home = match.score.fullTime.home;
  const away = match.score.fullTime.away;

  const isHome = match.homeTeam.id === teamId;

  const scored = isHome ? home : away;
  const conceded = isHome ? away : home;

  if (scored > conceded) return "W";
  if (scored < conceded) return "L";
  return "D";
}

function lastFiveBefore(teamId, kickoff, currentMatchId) {
  return matches
    .filter(m =>
      m.id !== currentMatchId &&
      m.status === "FINISHED" &&
      new Date(m.utcDate) < new Date(kickoff) &&
      (m.homeTeam.id === teamId || m.awayTeam.id === teamId)
    )
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 5)
    .map(m => resultForTeam(m, teamId))
    .filter(Boolean)
    .reverse();
}

/* -----------------------------------------------------------
   BUILD DATABASE ROWS
----------------------------------------------------------- */

const rows = matches
  .filter(m => m.matchday)
  .map(m => {
    const homeForm = lastFiveBefore(
      m.homeTeam.id,
      m.utcDate,
      m.id
    );

    const awayForm = lastFiveBefore(
      m.awayTeam.id,
      m.utcDate,
      m.id
    );

    return {
      id: m.id,
      matchweek: m.matchday,
      kickoff: m.utcDate,

      home_team: m.homeTeam?.name || "",
      away_team: m.awayTeam?.name || "",

      venue: m.venue || null,

      status: m.status || "SCHEDULED",

      minute:
        m.minute == null
          ? null
          : Number(m.minute),

      injury_time:
        m.injuryTime == null
          ? null
          : Number(m.injuryTime),

      /*
       * football-data uses the score object for the
       * current/final score. Keep these populated whenever
       * the API supplies them — including while live.
       */
      home_score:
        m.score?.fullTime?.home ?? null,

      away_score:
        m.score?.fullTime?.away ?? null,

      home_form: homeForm,
      away_form: awayForm,

      updated_at: new Date().toISOString()
    };
  });

/* -----------------------------------------------------------
   UPSERT TO SUPABASE
----------------------------------------------------------- */

const upsert = await fetch(
  `${supabaseUrl}/rest/v1/fixtures?on_conflict=id`,
  {
    method: "POST",

    headers: {
      apikey: supabaseSecret,
      Authorization: `Bearer ${supabaseSecret}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },

    body: JSON.stringify(rows)
  }
);

if (!upsert.ok) {
  throw new Error(
    `Supabase ${upsert.status}: ${await upsert.text()}`
  );
}

const liveMatches = rows.filter(
  m =>
    m.status === "LIVE" ||
    m.status === "IN_PLAY" ||
    m.status === "PAUSED"
);

console.log(
  `Synced ${rows.length} Premier League matches.`
);

console.log(
  `${liveMatches.length} currently live/in-play.`
);
