const fdToken = process.env.FOOTBALL_DATA_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
const season = process.env.SEASON_START_YEAR || "2026";
if (!fdToken || !supabaseUrl || !supabaseSecret) {
  throw new Error("Missing FOOTBALL_DATA_TOKEN, SUPABASE_URL or SUPABASE_SECRET_KEY.");
}

const fd = await fetch(`https://api.football-data.org/v4/competitions/PL/matches?season=${season}`, {
  headers: {"X-Auth-Token": fdToken}
});
if (!fd.ok) throw new Error(`football-data.org: ${fd.status} ${await fd.text()}`);
const body = await fd.json();

const rows = body.matches.map(m => ({
  id: m.id,
  matchweek: m.matchday,
  kickoff: m.utcDate,
  home_team: m.homeTeam.name,
  away_team: m.awayTeam.name,
  status: m.status,
  home_score: m.score?.fullTime?.home ?? null,
  away_score: m.score?.fullTime?.away ?? null,
  updated_at: new Date().toISOString()
})).filter(x => x.matchweek);

const res = await fetch(`${supabaseUrl}/rest/v1/fixtures?on_conflict=id`, {
  method: "POST",
  headers: {
    "apikey": supabaseSecret,
    "Authorization": `Bearer ${supabaseSecret}`,
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal"
  },
  body: JSON.stringify(rows)
});
if (!res.ok) throw new Error(`Supabase: ${res.status} ${await res.text()}`);
console.log(`Upserted ${rows.length} Premier League fixtures/results.`);
