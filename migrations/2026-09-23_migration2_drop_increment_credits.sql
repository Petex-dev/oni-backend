-- Migration 2: drop the old increment_credits RPC.
-- Run only after backend d89ebf8 (Re-up -> increment_bonus_credits) is Active on Railway.
-- Neither server.js nor index.html calls increment_credits any more.
begin;

-- Safety check: abort if any other database function still calls increment_credits.
do $$
declare
  v_callers text;
begin
  select string_agg(p.proname, ', ') into v_callers
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname <> 'increment_credits'
     and p.prosrc ilike '%increment_credits%';
  if v_callers is not null then
    raise exception 'Not dropping increment_credits: still referenced by %', v_callers;
  end if;
end;
$$;

-- Drop every overload by name, so this works whatever its exact argument types are.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = 'increment_credits'
  loop
    execute format('drop function %s', f);
    raise notice 'dropped %', f;
  end loop;
end;
$$;

commit;
