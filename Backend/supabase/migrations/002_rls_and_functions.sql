-- =====================================================================
-- UniEvents PK — triggers, RLS, RPC functions, storage, realtime
-- =====================================================================

-- ---------- helpers ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- auth -> profile ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- event guards ----------
create or replace function public.events_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    -- normal users can never self-approve; SQL editor / service role (uid null) can seed
    if auth.uid() is not null and not public.is_admin() then
      new.status := 'pending';
      new.reviewed_by := null;
      new.reviewed_at := null;
      new.rejection_reason := null;
    end if;
    if new.event_code is null then
      new.event_code := '#UEP-' || to_char(new.event_date, 'DDMON');
    end if;
  else
    if auth.uid() is not null and not public.is_admin() then
      if new.status <> old.status and new.status <> 'cancelled' then
        new.status := old.status;
      end if;
      new.reviewed_by := old.reviewed_by;
      new.reviewed_at := old.reviewed_at;
      new.rejection_reason := old.rejection_reason;
      new.organizer_id := old.organizer_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists events_guard_trg on public.events;
create trigger events_guard_trg before insert or update on public.events
  for each row execute function public.events_guard();

create or replace function public.events_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_free then
    insert into public.ticket_tiers (event_id, name, price_pkr) values (new.id, 'Free Entry', 0);
  end if;
  if new.organizer_id is not null then
    update public.profiles set role = 'organizer' where id = new.organizer_id and role = 'student';
  end if;
  return new;
end $$;

drop trigger if exists events_after_insert_trg on public.events;
create trigger events_after_insert_trg after insert on public.events
  for each row execute function public.events_after_insert();

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles         enable row level security;
alter table public.events           enable row level security;
alter table public.ticket_tiers     enable row level security;
alter table public.bookings         enable row level security;
alter table public.payments         enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.contact_messages enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
revoke update on public.profiles from authenticated, anon;
grant  update (full_name, phone, university) on public.profiles to authenticated;
revoke insert, delete on public.profiles from authenticated, anon;

-- events
create policy events_select on public.events for select
  using (status = 'approved' or organizer_id = auth.uid() or public.is_admin());
create policy events_insert on public.events for insert to authenticated
  with check (organizer_id = auth.uid() or public.is_admin());
create policy events_update on public.events for update to authenticated
  using (organizer_id = auth.uid() or public.is_admin())
  with check (organizer_id = auth.uid() or public.is_admin());
create policy events_delete on public.events for delete to authenticated
  using (public.is_admin());

-- ticket tiers (visibility follows events RLS)
create policy tiers_select on public.ticket_tiers for select
  using (exists (select 1 from public.events e where e.id = event_id));
create policy tiers_insert on public.ticket_tiers for insert to authenticated
  with check (exists (select 1 from public.events e where e.id = event_id and e.organizer_id = auth.uid()) or public.is_admin());
create policy tiers_update on public.ticket_tiers for update to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.organizer_id = auth.uid()) or public.is_admin());
create policy tiers_delete on public.ticket_tiers for delete to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and e.organizer_id = auth.uid()) or public.is_admin());
revoke insert, update on public.ticket_tiers from authenticated, anon;
grant  insert (event_id, name, description, price_pkr, quantity) on public.ticket_tiers to authenticated;
grant  update (name, description, price_pkr, quantity)           on public.ticket_tiers to authenticated;

-- bookings: only owner or admin read; ALL writes via RPC
create policy bookings_select on public.bookings for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
revoke insert, update, delete on public.bookings from authenticated, anon;

-- payments: owner/admin can read non-sensitive columns; writes service role only
create policy payments_select on public.payments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and (b.user_id = auth.uid() or public.is_admin())));
revoke all on public.payments from authenticated, anon;
grant  select (id, booking_id, provider, status, amount_pkr, txn_ref, created_at) on public.payments to authenticated;

-- conversations / messages
create policy conv_select on public.conversations for select to authenticated
  using (student_id = auth.uid() or organizer_id = auth.uid() or public.is_admin());
revoke insert, update, delete on public.conversations from authenticated, anon;

create policy msg_select on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id));
create policy msg_insert on public.messages for insert to authenticated
  with check (sender_id = auth.uid()
              and exists (select 1 from public.conversations c
                          where c.id = conversation_id
                            and (c.student_id = auth.uid() or c.organizer_id = auth.uid())));
create policy msg_update on public.messages for update to authenticated
  using (sender_id <> auth.uid()
         and exists (select 1 from public.conversations c
                     where c.id = conversation_id
                       and (c.student_id = auth.uid() or c.organizer_id = auth.uid())));
revoke update, delete on public.messages from authenticated, anon;
grant  update (read_at) on public.messages to authenticated;

-- contact form: anyone may submit, only admins read/manage
create policy contact_insert on public.contact_messages for insert to anon, authenticated
  with check (status = 'new');
create policy contact_admin_select on public.contact_messages for select to authenticated using (public.is_admin());
create policy contact_admin_update on public.contact_messages for update to authenticated using (public.is_admin());
revoke update on public.contact_messages from authenticated;
grant  update (status) on public.contact_messages to authenticated;

-- =====================================================================
-- RPC functions (called from the website via supabase.rpc)
-- =====================================================================

-- Create a booking. Price always comes from the tier, never from the client.
create or replace function public.create_booking(
  p_event_id uuid, p_tier_id uuid, p_full_name text, p_email text,
  p_cnic text, p_roll text, p_university text
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ev  public.events;
  t   public.ticket_tiers;
  bk  public.bookings;
  reserved int;
begin
  if uid is null then raise exception 'Please login first'; end if;
  if char_length(trim(coalesce(p_full_name,''))) < 2 then raise exception 'Full name required'; end if;
  if char_length(trim(coalesce(p_cnic,''))) < 6 then raise exception 'CNIC / passport number required'; end if;

  select * into ev from events where id = p_event_id and status = 'approved' and event_date >= current_date;
  if not found then raise exception 'Event not available for booking'; end if;

  select * into t from ticket_tiers where id = p_tier_id and event_id = p_event_id for update;
  if not found then raise exception 'Invalid ticket type'; end if;

  if exists (select 1 from bookings where user_id = uid and event_id = p_event_id and status = 'confirmed') then
    raise exception 'You already have a ticket for this event';
  end if;

  -- drop this user's stale unpaid attempts for the same event
  update bookings set status = 'cancelled'
   where user_id = uid and event_id = p_event_id and status = 'pending_payment';

  if t.quantity is not null then
    select count(*) into reserved from bookings
     where tier_id = t.id and status = 'pending_payment' and created_at > now() - interval '30 minutes';
    if t.sold + reserved >= t.quantity then raise exception 'This ticket type is sold out'; end if;
  end if;

  insert into bookings (user_id, event_id, tier_id, full_name, email, cnic, roll_number, university, amount_pkr, status, confirmed_at)
  values (uid, p_event_id, p_tier_id, trim(p_full_name), trim(p_email), trim(p_cnic), p_roll, p_university,
          t.price_pkr,
          case when t.price_pkr = 0 then 'confirmed'::booking_status else 'pending_payment'::booking_status end,
          case when t.price_pkr = 0 then now() end)
  returning * into bk;

  if t.price_pkr = 0 then
    update ticket_tiers set sold = sold + 1 where id = t.id;
  end if;
  return bk;
end $$;

-- Called ONLY by Edge Functions (service role) after verifying the gateway response.
create or replace function public.confirm_payment(
  p_txn_ref text, p_provider_txn_id text, p_amount_pkr numeric, p_raw jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare pay public.payments; bk public.bookings;
begin
  select * into pay from payments where txn_ref = p_txn_ref for update;
  if not found then return null; end if;
  if pay.status = 'paid' then return pay.booking_id; end if;           -- idempotent

  if p_amount_pkr is not null and p_amount_pkr <> pay.amount_pkr then
    update payments set status = 'failed', response_code = 'AMOUNT_MISMATCH', raw = p_raw, updated_at = now() where id = pay.id;
    return null;
  end if;

  select * into bk from bookings where id = pay.booking_id for update;
  update payments set status = 'paid', provider_txn_id = p_provider_txn_id,
         response_code = 'OK', raw = p_raw, updated_at = now() where id = pay.id;
  -- money was received, so confirm the ticket even if the user restarted checkout meanwhile
  if bk.status in ('pending_payment', 'cancelled') then
    update bookings set status = 'confirmed', confirmed_at = now() where id = bk.id;
    update ticket_tiers set sold = sold + 1 where id = bk.tier_id;
  end if;
  return bk.id;
end $$;

create or replace function public.fail_payment(p_txn_ref text, p_code text, p_raw jsonb) returns void
language sql security definer set search_path = public as $$
  update payments set status = 'failed', response_code = p_code, raw = p_raw, updated_at = now()
   where txn_ref = p_txn_ref and status <> 'paid';
$$;

revoke execute on function public.confirm_payment(text, text, numeric, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_payment(text, text, jsonb)             from public, anon, authenticated;
grant  execute on function public.confirm_payment(text, text, numeric, jsonb) to service_role;
grant  execute on function public.fail_payment(text, text, jsonb)             to service_role;

-- Organizer / admin: attendee list WITHOUT CNIC
create or replace function public.event_attendees(p_event_id uuid)
returns table (booking_id uuid, full_name text, email text, university text, roll_number text,
               tier_name text, ticket_code text, status booking_status, checked_in_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or exists (select 1 from events where id = p_event_id and organizer_id = auth.uid())) then
    raise exception 'Not allowed';
  end if;
  return query
    select b.id, b.full_name, b.email, b.university, b.roll_number, t.name, b.ticket_code, b.status, b.checked_in_at
      from bookings b join ticket_tiers t on t.id = b.tier_id
     where b.event_id = p_event_id and b.status = 'confirmed'
     order by b.created_at;
end $$;

-- Gate check-in by QR / ticket code
create or replace function public.check_in_ticket(p_ticket_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare bk public.bookings;
begin
  select * into bk from bookings where ticket_code = upper(trim(p_ticket_code)) for update;
  if not found then raise exception 'Ticket not found'; end if;
  if not (public.is_admin() or exists (select 1 from events where id = bk.event_id and organizer_id = auth.uid())) then
    raise exception 'Not allowed';
  end if;
  if bk.status <> 'confirmed' then raise exception 'Ticket is not valid (status: %)', bk.status; end if;
  if bk.checked_in_at is not null then raise exception 'Already checked in at %', bk.checked_in_at; end if;
  update bookings set checked_in_at = now() where id = bk.id;
  return jsonb_build_object('full_name', bk.full_name, 'university', bk.university, 'roll_number', bk.roll_number);
end $$;

-- Messaging
create or replace function public.start_conversation(p_event_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare org uuid; cid uuid;
begin
  if auth.uid() is null then raise exception 'Please login first'; end if;
  select organizer_id into org from events where id = p_event_id and status = 'approved';
  if not found then raise exception 'Event not found'; end if;
  org := coalesce(org, (select id from profiles where role = 'admin' order by created_at limit 1));
  if org is null then raise exception 'No organizer available yet'; end if;
  if org = auth.uid() then raise exception 'You cannot message yourself'; end if;
  insert into conversations (event_id, student_id, organizer_id) values (p_event_id, auth.uid(), org)
  on conflict (event_id, student_id) do update set organizer_id = excluded.organizer_id
  returning id into cid;
  return cid;
end $$;

create or replace function public.my_conversations()
returns table (id uuid, event_id uuid, event_title text, other_name text, last_message text, last_at timestamptz, unread int)
language sql stable security definer set search_path = public as $$
  select c.id, c.event_id, e.title,
         coalesce(nullif(p.full_name, ''), 'User'),
         (select m.body from messages m where m.conversation_id = c.id order by m.created_at desc limit 1),
         coalesce((select max(m.created_at) from messages m where m.conversation_id = c.id), c.created_at),
         (select count(*)::int from messages m where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.read_at is null)
    from conversations c
    join events e on e.id = c.event_id
    join profiles p on p.id = case when c.student_id = auth.uid() then c.organizer_id else c.student_id end
   where c.student_id = auth.uid() or c.organizer_id = auth.uid()
   order by 6 desc;
$$;

-- Admin tools
create or replace function public.review_event(p_event_id uuid, p_approve boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update events
     set status = case when p_approve then 'approved'::event_status else 'rejected'::event_status end,
         rejection_reason = case when p_approve then null else p_reason end,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_event_id;
end $$;

create or replace function public.set_user_role(p_user_id uuid, p_role user_role) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update profiles set role = p_role where id = p_user_id;
end $$;

create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'users',            (select count(*) from profiles),
    'events_pending',   (select count(*) from events where status = 'pending'),
    'events_approved',  (select count(*) from events where status = 'approved'),
    'bookings_confirmed', (select count(*) from bookings where status = 'confirmed'),
    'revenue_pkr',      (select coalesce(sum(amount_pkr), 0) from payments where status = 'paid'),
    'unread_contact',   (select count(*) from contact_messages where status = 'new')
  );
end $$;

-- =====================================================================
-- Storage (event posters) + Realtime (chat)
-- =====================================================================
insert into storage.buckets (id, name, public) values ('posters', 'posters', true)
on conflict (id) do nothing;

create policy "posters public read" on storage.objects for select using (bucket_id = 'posters');
create policy "posters upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'posters' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "posters update own" on storage.objects for update to authenticated
  using (bucket_id = 'posters' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "posters delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'posters' and (storage.foldername(name))[1] = auth.uid()::text);

do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when others then null;
end $$;
