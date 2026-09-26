-- Migration 4: drop the old client-priced deduct_credits(p_amount).
-- Run only after the frontend that calls deduct_credits(p_operation, ...) is live and
-- MD5-verified (ideally a day later, so stale open tabs have refreshed). This is the
-- step that actually closes the "pay 1 credit instead of 5" hole.
begin;

drop function if exists public.deduct_credits(integer);

-- Safety check: the new overload must still be there.
do $$
begin
  if to_regprocedure('public.deduct_credits(text, integer)') is null then
    raise exception 'deduct_credits(text, integer) missing — run Migration 3 first';
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';
