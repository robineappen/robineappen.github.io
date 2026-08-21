-- Premier Picks database setup for Supabase
-- Run this once in the Supabase SQL Editor.

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

drop policy if exists "profiles readable by signed in users" on public.profiles;
create policy "profiles readable by signed in users" on public.profiles for select to authenticated using (true);
drop policy if exists "users insert own profile" on public.profiles;
create policy "users insert own profile" on public.profiles for insert to authenticated with check (auth.uid()=id);
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles for update to authenticated using (auth.uid()=id) with check (auth.uid()=id);

drop policy if exists "fixtures readable by signed in users" on public.fixtures;
create policy "fixtures readable by signed in users" on public.fixtures for select to authenticated using (true);

drop policy if exists "own predictions readable" on public.predictions;
create policy "own predictions readable" on public.predictions for select to authenticated using (auth.uid()=user_id);
drop policy if exists "own predictions insertable" on public.predictions;
create policy "own predictions insertable" on public.predictions for insert to authenticated with check (auth.uid()=user_id);
drop policy if exists "own predictions updateable" on public.predictions;
create policy "own predictions updateable" on public.predictions for update to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id);
drop policy if exists "own predictions deletable" on public.predictions;
create policy "own predictions deletable" on public.predictions for delete to authenticated using (auth.uid()=user_id);

drop policy if exists "own confirmations readable" on public.confirmations;
create policy "own confirmations readable" on public.confirmations for select to authenticated using (auth.uid()=user_id);

create or replace function public.prediction_is_locked(p_user uuid, p_fixture bigint)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.confirmations c
    join public.fixtures f on f.matchweek=c.matchweek
    where c.user_id=p_user and f.id=p_fixture
  );
$$;

create or replace function public.prevent_locked_prediction_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if public.prediction_is_locked(coalesce(old.user_id,new.user_id),coalesce(old.fixture_id,new.fixture_id)) then
    raise exception 'This matchweek is confirmed and locked.';
  end if;
  return coalesce(new,old);
end;
$$;

drop trigger if exists predictions_lock_guard on public.predictions;
create trigger predictions_lock_guard
before update or delete on public.predictions
for each row execute function public.prevent_locked_prediction_change();

create or replace function public.confirm_matchweek(p_matchweek integer)
returns void language plpgsql security definer set search_path=public as $$
declare
  fixture_count integer;
  prediction_count integer;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select count(*) into fixture_count from public.fixtures where matchweek=p_matchweek;
  if fixture_count=0 then raise exception 'No fixtures loaded for this matchweek'; end if;

  select count(*) into prediction_count
  from public.predictions p
  join public.fixtures f on f.id=p.fixture_id
  where p.user_id=auth.uid() and f.matchweek=p_matchweek;

  if prediction_count<>fixture_count then
    raise exception 'Complete every prediction before confirming';
  end if;

  insert into public.confirmations(user_id,matchweek)
  values(auth.uid(),p_matchweek)
  on conflict (user_id,matchweek) do nothing;
end;
$$;
grant execute on function public.confirm_matchweek(integer) to authenticated;

create or replace function public.get_leaderboard()
returns table (rank bigint, display_name text, total_points bigint, exact_scores bigint, correct_outcomes bigint, matches_scored bigint)
language sql stable security definer set search_path=public as $$
  with completed_weeks as (
    select matchweek from public.fixtures group by matchweek
    having count(*) > 0 and bool_and(status='FINISHED' and home_score is not null and away_score is not null)
  ), scored as (
    select p.user_id,
      case when p.home_pred=f.home_score and p.away_pred=f.away_score then 4
           when sign(p.home_pred-p.away_pred)=sign(f.home_score-f.away_score) then 3
           else 0 end as pts
    from public.predictions p join public.fixtures f on f.id=p.fixture_id
    join completed_weeks cw on cw.matchweek=f.matchweek
  ), agg as (
    select pr.id, pr.display_name, coalesce(sum(s.pts),0)::bigint total_points,
      count(*) filter(where s.pts=4)::bigint exact_scores, count(*) filter(where s.pts=3)::bigint correct_outcomes,
      count(s.pts)::bigint matches_scored
    from public.profiles pr left join scored s on s.user_id=pr.id group by pr.id,pr.display_name
  )
  select dense_rank() over(order by total_points desc,exact_scores desc,correct_outcomes desc)::bigint,
    display_name,total_points,exact_scores,correct_outcomes,matches_scored
  from agg order by total_points desc,exact_scores desc,correct_outcomes desc,display_name;
$$;
grant execute on function public.get_leaderboard() to authenticated;

-- Keep table grants minimal. The GitHub Action uses a secret key and bypasses RLS.
grant select on public.fixtures, public.profiles to authenticated;
grant select,insert,update,delete on public.predictions to authenticated;
grant select on public.confirmations to authenticated;
