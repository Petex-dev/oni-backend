-- Migration 1: bonus_credits (Re-up credits that survive renewal resets)
--              + close the increment_credits privilege hole
-- Safe to run before the server.js deploy: increment_credits keeps working for the
-- backend (service role), and get_my_credits keeps returning the same "credits" key
-- (now the combined total), so the live frontend needs no change.
begin;

-- 0. SECURITY: increment_credits was executable by anon + authenticated, letting any
--    user grant themselves credits. Lock every overload to service_role only.
--    server.js calls it with the service-role key, so Re-up keeps working.
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
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- 1. New column. Existing balances stay in "credits" (we can't tell old Re-up
--    credits apart from subscription credits, so everyone starts at 0 bonus).
alter table public.profiles
  add column if not exists bonus_credits integer not null default 0
  constraint profiles_bonus_credits_nonneg check (bonus_credits >= 0);

-- 2. Re-up grants go here. Backend-only (service role), never callable by users.
create or replace function public.increment_bonus_credits(p_user_id uuid, p_amount integer)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'increment_bonus_credits: p_amount must be positive (got %)', p_amount;
  end if;

  update public.profiles
     set bonus_credits = bonus_credits + p_amount
   where id = p_user_id;

  if not found then
    raise exception 'increment_bonus_credits: no profile for user %', p_user_id;
  end if;
end;
$function$;

revoke all on function public.increment_bonus_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.increment_bonus_credits(uuid, integer) to service_role;

-- 3. Spend subscription credits first, then bonus. Same return shape as before;
--    "remaining" is now the combined total. Also rejects p_amount <= 0
--    (previously a negative amount would ADD credits).
create or replace function public.deduct_credits(p_amount integer default 5)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_credits int;
  v_bonus int;
  v_from_sub int;
  v_from_bonus int;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_signed_in');
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_amount');
  end if;

  -- Lock the row so two simultaneous exports can't both spend the same credits.
  select credits, bonus_credits into v_credits, v_bonus
    from public.profiles
   where id = v_uid
   for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  v_credits := greatest(coalesce(v_credits, 0), 0);
  v_bonus   := coalesce(v_bonus, 0);

  if v_credits + v_bonus < p_amount then
    return jsonb_build_object('allowed', false, 'reason', 'insufficient_credits', 'remaining', v_credits + v_bonus);
  end if;

  v_from_sub   := least(v_credits, p_amount);
  v_from_bonus := p_amount - v_from_sub;

  update public.profiles
     set credits       = v_credits - v_from_sub,
         bonus_credits = v_bonus - v_from_bonus
   where id = v_uid;

  return jsonb_build_object('allowed', true, 'reason', 'deducted', 'remaining', v_credits + v_bonus - p_amount);
end;
$function$;

-- 4. Display: "credits" = combined total (unchanged key, so the frontend just works);
--    the split is exposed too in case the UI wants it later.
create or replace function public.get_my_credits()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_credits int;
  v_bonus int;
  v_plan text;
  v_stripe_customer_id text;
begin
  if v_uid is null then
    return jsonb_build_object('signed_in', false);
  end if;
  select credits, bonus_credits, plan, stripe_customer_id
    into v_credits, v_bonus, v_plan, v_stripe_customer_id
    from public.profiles
   where id = v_uid;
  if not found then
    return jsonb_build_object('signed_in', true, 'credits', null);
  end if;
  return jsonb_build_object(
    'signed_in', true,
    'credits', coalesce(v_credits, 0) + coalesce(v_bonus, 0),
    'subscription_credits', v_credits,
    'bonus_credits', v_bonus,
    'plan', v_plan,
    'has_stripe_customer', v_stripe_customer_id is not null
  );
end;
$function$;

commit;
