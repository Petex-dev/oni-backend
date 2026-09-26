-- Migration 5: credit_grants log + refund clawback + idempotent grants
--
-- 1. credit_grants records every credit grant that came from a Stripe purchase
--    (Re-up, new subscription, upgrade, renewal), keyed by the Stripe event that caused
--    it. The unique stripe_event_id makes grants idempotent: Stripe delivers events at
--    least once, and before this a re-delivered checkout.session.completed added the
--    credits a second time.
-- 2. apply_credit_grant() inserts the grant row AND changes the balance in one
--    transaction, so a grant can't be recorded without being applied (or vice versa).
-- 3. apply_credit_refund() handles charge.refunded: removes credits in proportion to the
--    amount refunded, only from the pool the purchase granted, floored at 0. Whatever
--    couldn't be taken (already spent, or expired by a later renewal reset) is recorded
--    as "uncollected" for manual review. Never touches the other pool or the plan.
--
-- Safe to run before the server.js deploy: nothing calls these functions yet, and the
-- live webhook handler keeps working exactly as it does today.
begin;

-- 1. Grants: one row per Stripe purchase that granted credits.
create table if not exists public.credit_grants (
  id                       bigint generated always as identity primary key,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  kind                     text not null check (kind in ('reup', 'subscription_start', 'upgrade', 'renewal')),
  pool                     text not null check (pool in ('credits', 'bonus_credits')),
  amount                   integer not null check (amount > 0),
  stripe_event_id          text not null unique,
  -- Whichever Stripe ID exists at grant time: Re-up has a payment intent; subscription
  -- start / renewal / (invoiced) upgrade have an invoice. The refund handler resolves a
  -- charge back to one of these. An upgrade with no invoice of its own has neither.
  stripe_payment_intent_id text,
  stripe_invoice_id        text,
  amount_paid_cents        integer,
  currency                 text,
  refunded_cents           integer not null default 0 check (refunded_cents >= 0),
  clawed_back              integer not null default 0 check (clawed_back >= 0),
  uncollected              integer not null default 0 check (uncollected >= 0),
  created_at               timestamptz not null default now(),
  check (clawed_back + uncollected <= amount)
);

-- Each Stripe payment maps to at most one grant, so a refund can never match two.
create unique index if not exists credit_grants_payment_intent_uidx
  on public.credit_grants (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create unique index if not exists credit_grants_invoice_uidx
  on public.credit_grants (stripe_invoice_id) where stripe_invoice_id is not null;
create index if not exists credit_grants_user_created_idx
  on public.credit_grants (user_id, created_at desc);

alter table public.credit_grants enable row level security;
revoke all on table public.credit_grants from public, anon, authenticated;

-- 2. Refund log: one row per charge.refunded event, including ones that matched no
--    grant (grant_id null) — that's the manual-review list.
create table if not exists public.credit_refund_events (
  id                    bigint generated always as identity primary key,
  stripe_event_id       text not null unique,
  stripe_charge_id      text,
  grant_id              bigint references public.credit_grants(id) on delete cascade,
  refunded_cents_total  integer not null,
  charge_amount_cents   integer not null,
  removed               integer not null default 0,
  uncollected           integer not null default 0,
  reason                text not null,  -- 'clawed_back' | 'partly_spent' | 'expired' | 'nothing_due' | 'no_grant'
  created_at            timestamptz not null default now()
);

alter table public.credit_refund_events enable row level security;
revoke all on table public.credit_refund_events from public, anon, authenticated;

-- 3. Grant credits for a Stripe purchase, exactly once per Stripe event.
--    Re-up adds to bonus_credits. subscription_start / upgrade add to credits.
--    renewal RESETS credits to the plan amount (no rollover), and only if this billing
--    period hasn't been refreshed yet (p_period_start) — same guard as the old code.
--    Returns 'granted' | 'duplicate' | 'already_refreshed' | 'no_profile'.
create or replace function public.apply_credit_grant(
  p_user_id                  uuid,
  p_kind                     text,
  p_amount                   integer,
  p_stripe_event_id          text,
  p_stripe_payment_intent_id text default null,
  p_stripe_invoice_id        text default null,
  p_amount_paid_cents        integer default null,
  p_currency                 text default null,
  p_period_start             timestamptz default null
)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_pool text;
  v_refreshed_at timestamptz;
begin
  if p_kind not in ('reup', 'subscription_start', 'upgrade', 'renewal') then
    raise exception 'apply_credit_grant: unknown kind %', p_kind;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'apply_credit_grant: amount must be positive (got %)', p_amount;
  end if;
  if p_stripe_event_id is null then
    raise exception 'apply_credit_grant: stripe_event_id is required';
  end if;
  if p_kind = 'renewal' and p_period_start is null then
    raise exception 'apply_credit_grant: renewal needs p_period_start';
  end if;

  v_pool := case when p_kind = 'reup' then 'bonus_credits' else 'credits' end;

  -- Lock the profile first: serializes with deduct_credits and with other grants.
  select credits_refreshed_at into v_refreshed_at
    from public.profiles
   where id = p_user_id
   for update;

  if not found then
    return 'no_profile';
  end if;

  if exists (select 1 from public.credit_grants where stripe_event_id = p_stripe_event_id) then
    return 'duplicate';
  end if;

  -- Renewal: this period was already refreshed (e.g. two different events for the same
  -- period). Old behaviour kept, except a never-set credits_refreshed_at now counts as
  -- "not refreshed" instead of silently blocking the reset.
  if p_kind = 'renewal' and coalesce(v_refreshed_at, '-infinity'::timestamptz) >= p_period_start then
    return 'already_refreshed';
  end if;

  insert into public.credit_grants
    (user_id, kind, pool, amount, stripe_event_id, stripe_payment_intent_id,
     stripe_invoice_id, amount_paid_cents, currency)
  values
    (p_user_id, p_kind, v_pool, p_amount, p_stripe_event_id, p_stripe_payment_intent_id,
     p_stripe_invoice_id, p_amount_paid_cents, p_currency);

  if p_kind = 'reup' then
    update public.profiles
       set bonus_credits = bonus_credits + p_amount
     where id = p_user_id;
  elsif p_kind = 'renewal' then
    update public.profiles
       set credits = p_amount,
           credits_refreshed_at = now()
     where id = p_user_id;
  else -- subscription_start, upgrade: a purchase adds, never overwrites
    update public.profiles
       set credits = greatest(coalesce(credits, 0), 0) + p_amount,
           credits_refreshed_at = now()
     where id = p_user_id;
  end if;

  return 'granted';
end;
$function$;

revoke all on function public.apply_credit_grant(uuid, text, integer, text, text, text, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_credit_grant(uuid, text, integer, text, text, text, integer, text, timestamptz) to service_role;

-- 4. Claw back credits for a (full or partial) refund of a Stripe charge.
--    p_refunded_cents_total is Stripe's cumulative charge.amount_refunded, so repeated
--    partial refunds, duplicate deliveries and out-of-order deliveries all converge:
--    target = floor(grant.amount * refunded / charge amount), and only the part of the
--    target not already accounted for (clawed_back + uncollected) is acted on.
--    Takes only from the pool the purchase granted (no spill-over), floored at 0.
create or replace function public.apply_credit_refund(
  p_stripe_event_id          text,
  p_stripe_charge_id         text,
  p_stripe_payment_intent_id text,
  p_stripe_invoice_id        text,
  p_charge_amount_cents      integer,
  p_refunded_cents_total     integer
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  g public.credit_grants%rowtype;
  v_target int;
  v_due int;
  v_balance int;
  v_take int := 0;
  v_short int := 0;
  v_reason text;
begin
  if p_stripe_event_id is null then
    raise exception 'apply_credit_refund: stripe_event_id is required';
  end if;
  if p_charge_amount_cents is null or p_charge_amount_cents <= 0 or p_refunded_cents_total is null or p_refunded_cents_total < 0 then
    raise exception 'apply_credit_refund: bad amounts (charge %, refunded %)', p_charge_amount_cents, p_refunded_cents_total;
  end if;

  if exists (select 1 from public.credit_refund_events where stripe_event_id = p_stripe_event_id) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  -- Match on payment intent first (Re-up), then invoice (subscription charges).
  select * into g
    from public.credit_grants
   where (p_stripe_payment_intent_id is not null and stripe_payment_intent_id = p_stripe_payment_intent_id)
      or (p_stripe_invoice_id is not null and stripe_invoice_id = p_stripe_invoice_id)
   order by (stripe_payment_intent_id is not distinct from p_stripe_payment_intent_id) desc
   limit 1
   for update;

  if not found then
    insert into public.credit_refund_events
      (stripe_event_id, stripe_charge_id, refunded_cents_total, charge_amount_cents, reason)
    values
      (p_stripe_event_id, p_stripe_charge_id, p_refunded_cents_total, p_charge_amount_cents, 'no_grant');
    return jsonb_build_object('status', 'no_grant');
  end if;

  v_target := floor(g.amount::numeric * least(p_refunded_cents_total, p_charge_amount_cents) / p_charge_amount_cents);
  v_due    := greatest(v_target - (g.clawed_back + g.uncollected), 0);

  if v_due = 0 then
    v_reason := 'nothing_due';
  elsif g.pool = 'credits' and exists (
          select 1 from public.credit_grants r
           where r.user_id = g.user_id and r.kind = 'renewal'
             and r.created_at > g.created_at and r.id <> g.id) then
    -- A later renewal reset already wiped these subscription credits; don't take
    -- this period's paid-for credits to cover an earlier period's refund.
    v_short  := v_due;
    v_reason := 'expired';
  else
    if g.pool = 'bonus_credits' then
      select bonus_credits into v_balance from public.profiles where id = g.user_id for update;
    else
      select credits into v_balance from public.profiles where id = g.user_id for update;
    end if;
    v_balance := greatest(coalesce(v_balance, 0), 0);
    v_take    := least(v_due, v_balance);
    v_short   := v_due - v_take;
    v_reason  := case when v_short > 0 then 'partly_spent' else 'clawed_back' end;

    if g.pool = 'bonus_credits' then
      update public.profiles set bonus_credits = v_balance - v_take where id = g.user_id;
    else
      update public.profiles set credits = v_balance - v_take where id = g.user_id;
    end if;
  end if;

  update public.credit_grants
     set refunded_cents = greatest(refunded_cents, p_refunded_cents_total),
         clawed_back    = clawed_back + v_take,
         uncollected    = uncollected + v_short
   where id = g.id;

  insert into public.credit_refund_events
    (stripe_event_id, stripe_charge_id, grant_id, refunded_cents_total, charge_amount_cents, removed, uncollected, reason)
  values
    (p_stripe_event_id, p_stripe_charge_id, g.id, p_refunded_cents_total, p_charge_amount_cents, v_take, v_short, v_reason);

  return jsonb_build_object('status', v_reason, 'grant_id', g.id, 'user_id', g.user_id,
                            'pool', g.pool, 'removed', v_take, 'uncollected', v_short);
end;
$function$;

revoke all on function public.apply_credit_refund(text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.apply_credit_refund(text, text, text, text, integer, integer) to service_role;

commit;

notify pgrst, 'reload schema';
