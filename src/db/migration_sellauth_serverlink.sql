-- Ninja Boost — custom field "Server Link" (SellAuth). Sans risque, relançable.
alter table public.redeem_keys add column if not exists server_link text;
alter table public.sellauth_deliveries add column if not exists server_link text;

notify pgrst, 'reload schema';
