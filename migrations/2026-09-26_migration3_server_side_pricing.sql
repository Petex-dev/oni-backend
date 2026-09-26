-- Migration 3: server-side credit pricing + credit ledger
-- The browser used to call deduct_credits(p_amount) with a price it chose itself, so a
-- user could pay 1 credit for a 5-credit master. The new overload takes an OPERATION
-- ('master', 'voice_cleanup', 'stem_master') and a quantity; the database looks up the
-- price. Every successful charge is logged to credit_ledger.
--
-- Safe to run before the frontend deploy: the old deduct_credits(p_amount) is left in
-- place so the live site keeps working. PostgREST picks the overload by argument name
-- ({p_amount} -> old, {p_operation} -> new). Migration 4 drops the old one, which is
-- what actually closes the hole.
begin;

-- 1. Price list. Change a price with:  update public.credit_prices set cost = N where operation = '...';
create table if not exists public.credit_prices (
  operation text primary key,
  cost      integer not null check (cost > 0)
);

insert into public.credit_prices (operation, cost) values
  ('master',        5),
  ('voice_cleanup', 10),
  ('stem_master',   10)
on conflict (operation) do nothing;

-- Only reachable through deduct_credits (security definer). RLS on with no policies
-- = invisible to anon/authenticated via the API.
alter table public.credit_prices enable row level security;
revoke all on table public.credit_prices from public, anon, authenticated;

-- 2. Ledger: one row per successful charge. from_subscription/from_bonus record which
--    pool paid, so a future refund handler can put credits back where they came from.
create table if not exists public.credit_ledger (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  operation         text not null,
  quantity          integer not null check (quantity > 0),
  cost              integer not null check (cost > 0),
  from_subscription integer not null check (from_subscription >= 0),
  from_bonus        integer not null check (from_bonus >= 0),
  created_at        timestamptz not null default now()
);

create index if not exists credit_ledger_user_created_idx
  on public.credit_ledger (user_id, created_at desc);

alter table public.credit_ledger enable row level security;
revoke all on table public.credit_ledger from public, anon, authenticated;

-- 3. New overload. Same row lock, same spend order (subscription first, then bonus),
--    same return shape as the old function, so the frontend's result handling is unchanged.
create or replace function public.deduct_credits(p_operation text, p_quantity integer default 1)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_unit_cost int;
  v_amount int;
  v_credits int;
  v_bonus int;
  v_from_sub int;
  v_from_bonus int;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_signed_in');
  end if;

  select cost into v_unit_cost
    from public.credit_prices
   where operation = p_operation;

  if v_unit_cost is null then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_operation');
  end if;

  -- Batch export sends the track count; everything else sends 1 (the default).
  if p_quantity is null or p_quantity < 1 or p_quantity > 50 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_quantity');
  end if;

  v_amount := v_unit_cost * p_quantity;

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

  if v_credits + v_bonus < v_amount then
    return jsonb_build_object('allowed', false, 'reason', 'insufficient_credits', 'remaining', v_credits + v_bonus);
  end if;

  v_from_sub   := least(v_credits, v_amount);
  v_from_bonus := v_amount - v_from_sub;

  update public.profiles
     set credits       = v_credits - v_from_sub,
         bonus_credits = v_bonus - v_from_bonus
   where id = v_uid;

  insert into public.credit_ledger (user_id, operation, quantity, cost, from_subscription, from_bonus)
  values (v_uid, p_operation, p_quantity, v_amount, v_from_sub, v_from_bonus);

  return jsonb_build_object('allowed', true, 'reason', 'deducted', 'remaining', v_credits + v_bonus - v_amount);
end;
$function$;

revoke all on function public.deduct_credits(text, integer) from public, anon;
grant execute on function public.deduct_credits(text, integer) to authenticated;

commit;

-- Make PostgREST see the new overload immediately.
notify pgrst, 'reload schema';
