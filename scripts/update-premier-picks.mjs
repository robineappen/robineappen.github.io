const footballToken = process.env.FOOTBALL_DATA_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
const season = process.env.SEASON_START_YEAR || "2026";

if (!footballToken || !supabaseUrl || !supabaseSecret) {
  throw new Error("Missing required environment variables.");
}

const headers = { "X-Auth-Token": footballToken };
const endpoint = `https://api.football-data.org/v4/competitions/PL/matches?season=${season}`;

const response = await fetch(endpoint, { headers });
if (!response.ok) throw new Error(`football-data.org ${response.status}: ${await response.text()}`);

const payload = await response.json();
const matches = payload.matches || [];

function resultForTeam(match, teamId) {
  if (match.status !== "FINISHED" ||
      match.score?.fullTime?.home == null ||
      match.score?.fullTime?.away == null) return null;

  const home = Number(match.score.fullTime.home);
  const away = Number(match.score.fullTime.away);
  const isHome = Number(match.homeTeam.id) === Number(teamId);
  const scored = isHome ? home : away;
  const conceded = isHome ? away : home;
  return scored > conceded ? "W" : scored < conceded ? "L" : "D";
}

function lastFiveBefore(teamId, kickoff, currentId) {
  return matches
    .filter(m =>
      m.id !== currentId &&
      m.status === "FINISHED" &&
      new Date(m.utcDate) < new Date(kickoff) &&
      (Number(m.homeTeam.id) === Number(teamId) || Number(m.awayTeam.id) === Number(teamId))
    )
    .sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate))
    .slice(0,5)
    .map(m=>resultForTeam(m,teamId))
    .filter(Boolean)
    .reverse();
}

const detailedById = new Map();
const liveCandidates = matches.filter(m => ["LIVE","IN_PLAY","PAUSED"].includes(m.status));

for (const m of liveCandidates) {
  try {
    const r = await fetch(`https://api.football-data.org/v4/matches/${m.id}`, { headers });
    if (r.ok) detailedById.set(String(m.id), await r.json());
  } catch {}
}

const rows = matches.filter(m=>m.matchday).map(m=>{
  const detail = detailedById.get(String(m.id));
  const d = detail?.match || detail || m;
  const score = d.score || m.score || {};

  return {
    id:m.id,
    matchweek:m.matchday,
    kickoff:m.utcDate,
    home_team:m.homeTeam?.name || "",
    away_team:m.awayTeam?.name || "",
    venue:d.venue ?? m.venue ?? null,
    status:d.status || m.status || "SCHEDULED",
    minute:d.minute == null ? null : Number(d.minute),
    injury_time:d.injuryTime == null ? null : Number(d.injuryTime),
    home_score:score?.fullTime?.home ?? null,
    away_score:score?.fullTime?.away ?? null,
    home_form:lastFiveBefore(m.homeTeam.id,m.utcDate,m.id),
    away_form:lastFiveBefore(m.awayTeam.id,m.utcDate,m.id),
    updated_at:new Date().toISOString()
  };
});

const upsert = await fetch(`${supabaseUrl}/rest/v1/fixtures?on_conflict=id`, {
  method:"POST",
  headers:{
    apikey:supabaseSecret,
    Authorization:`Bearer ${supabaseSecret}`,
    "Content-Type":"application/json",
    Prefer:"resolution=merge-duplicates,return=minimal"
  },
  body:JSON.stringify(rows)
});

if(!upsert.ok) throw new Error(`Supabase ${upsert.status}: ${await upsert.text()}`);

console.log(`Synced ${rows.length} Premier League matches.`);
console.log(`${liveCandidates.length} live/in-play match(es).`);
