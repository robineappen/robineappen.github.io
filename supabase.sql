-- PREMIER PICKS — COMPLETE SUPABASE SETUP
-- Updated version:
-- 4 points = exact scoreline
-- 3 points = correct win/draw/loss
-- 0 points = wrong outcome
-- Leaderboard updates after EACH INDIVIDUAL MATCH finishes.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null unique check (char_length(display_name) between 1 and 24),
  created_at timestamptz not null default now()
);

create table if not exists public.fixtures (
  id bigint primary key,
  matchweek integer not null check (matchweek between 1 and 38),
  kickoff timestamptz not null,
  home_team text not null,
  away_team text not null,
  venue text,
  status text not null default 'SCHEDULED',
  home_score integer,
  away_score integer,
  updated_at timestamptz not null default now()
);

create table if not exists public.predictions (
  user_id uuid not null references auth.users(id) on delete cascade,
  fixture_id bigint not null references public.fixtures(id) on delete cascade,
  home_pred integer not null check (home_pred between 0 and 20),
  away_pred integer not null check (away_pred between 0 and 20),
  updated_at timestamptz not null default now(),
  primary key (user_id, fixture_id)
);

create table if not exists public.confirmations (
  user_id uuid not null references auth.users(id) on delete cascade,
  matchweek integer not null check (matchweek between 1 and 38),
  confirmed_at timestamptz not null default now(),
  primary key (user_id, matchweek)
);

alter table public.profiles enable row level security;
alter table public.fixtures enable row level security;
alter table public.predictions enable row level security;
alter table public.confirmations enable row level security;

drop policy if exists "profile read" on public.profiles;
create policy "profile read"
on public.profiles for select to authenticated using (true);

drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert"
on public.profiles for insert to authenticated with check (auth.uid() = id);

drop policy if exists "own profile update" on public.profiles;
create policy "own profile update"
on public.profiles for update to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "fixtures read" on public.fixtures;
create policy "fixtures read"
on public.fixtures for select to authenticated using (true);

drop policy if exists "own predictions read" on public.predictions;
create policy "own predictions read"
on public.predictions for select to authenticated using (auth.uid() = user_id);

drop policy if exists "own predictions insert" on public.predictions;
create policy "own predictions insert"
on public.predictions for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "own predictions update" on public.predictions;
create policy "own predictions update"
on public.predictions for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "own predictions delete" on public.predictions;
create policy "own predictions delete"
on public.predictions for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "own confirmations read" on public.confirmations;
create policy "own confirmations read"
on public.confirmations for select to authenticated using (auth.uid() = user_id);

create or replace function public.prediction_locked(
  p_user uuid,
  p_fixture bigint
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.confirmations c
    join public.fixtures f on f.matchweek = c.matchweek
    where c.user_id = p_user
      and f.id = p_fixture
  );
$$;

create or replace function public.block_locked_prediction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.prediction_locked(
    coalesce(old.user_id, new.user_id),
    coalesce(old.fixture_id, new.fixture_id)
  ) then
    raise exception 'This matchweek has already been confirmed and locked.';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists locked_prediction_guard on public.predictions;

create trigger locked_prediction_guard
before update or delete on public.predictions
for each row
execute function public.block_locked_prediction();

create or replace function public.confirm_matchweek(
  p_matchweek integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  nfixtures integer;
  npredictions integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select count(*) into nfixtures
  from public.fixtures
  where matchweek = p_matchweek;

  if nfixtures = 0 then
    raise exception 'There are no fixtures for this matchweek.';
  end if;

  select count(*) into npredictions
  from public.predictions p
  join public.fixtures f on f.id = p.fixture_id
  where p.user_id = auth.uid()
    and f.matchweek = p_matchweek;

  if npredictions <> nfixtures then
    raise exception 'Save a prediction for every fixture before confirming.';
  end if;

  insert into public.confirmations(user_id, matchweek)
  values(auth.uid(), p_matchweek)
  on conflict(user_id, matchweek) do nothing;
end;
$$;

grant execute on function public.confirm_matchweek(integer) to authenticated;

-- Every FINISHED match is scored immediately.
create or replace function public.get_leaderboard()
returns table(
  rank bigint,
  display_name text,
  total_points bigint,
  exact_scores bigint,
  correct_outcomes bigint,
  matches_scored bigint,
  completed_matchweeks bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with scored as (
    select
      p.user_id,
      f.matchweek,
      case
        when f.status <> 'FINISHED'
          or f.home_score is null
          or f.away_score is null
        then null
        when p.home_pred = f.home_score
          and p.away_pred = f.away_score
        then 4
        when sign(p.home_pred - p.away_pred)
           = sign(f.home_score - f.away_score)
        then 3
        else 0
      end as pts
    from public.predictions p
    join public.fixtures f on f.id = p.fixture_id
  ),
  agg as (
    select
      pr.id,
      pr.display_name,
      coalesce(sum(s.pts) filter (where s.pts is not null),0)::bigint as total_points,
      count(*) filter (where s.pts = 4)::bigint as exact_scores,
      count(*) filter (where s.pts = 3)::bigint as correct_outcomes,
      count(*) filter (where s.pts is not null)::bigint as matches_scored,
      count(distinct s.matchweek)
        filter (where s.pts is not null)::bigint as completed_matchweeks
    from public.profiles pr
    left join scored s on s.user_id = pr.id
    group by pr.id, pr.display_name
  )
  select
    dense_rank() over (
      order by total_points desc, exact_scores desc, correct_outcomes desc
    )::bigint as rank,
    display_name,
    total_points,
    exact_scores,
    correct_outcomes,
    matches_scored,
    completed_matchweeks
  from agg
  order by total_points desc, exact_scores desc, correct_outcomes desc, display_name;
$$;

grant execute on function public.get_leaderboard() to authenticated;

grant select on public.fixtures, public.profiles to authenticated;
grant select, insert, update, delete on public.predictions to authenticated;
grant select on public.confirmations to authenticated;
