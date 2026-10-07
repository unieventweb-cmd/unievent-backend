-- =====================================================================
-- UniEvents PK — schema (Supabase / Postgres)
-- Run order: 001_schema.sql -> 002_rls_and_functions.sql -> seed.sql
-- =====================================================================

create type public.user_role      as enum ('student', 'organizer', 'admin');
create type public.event_status   as enum ('pending', 'approved', 'rejected', 'cancelled');
create type public.booking_status as enum ('pending_payment', 'confirmed', 'cancelled', 'refunded');
create type public.pay_provider   as enum ('jazzcash', 'easypaisa');
create type public.pay_status     as enum ('initiated', 'paid', 'failed', 'refunded');

-- ---------- profiles (1 row per auth user) ----------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  phone       text,
  university  text,
  role        public.user_role not null default 'student',
  created_at  timestamptz not null default now()
);

-- ---------- events ----------
create table public.events (
  id               uuid primary key default gen_random_uuid(),
  organizer_id     uuid references public.profiles(id) on delete set null,
  organization_name text not null,
  title            text not null check (char_length(title) between 3 and 150),
  title_ur         text,
  description      text not null default '',
  description_ur   text,
  category         text not null check (category in ('Tech Fest','Sports Gala','Cultural','Academic','Business','Other')),
  city             text not null,
  venue            text not null,
  event_date       date not null,
  start_time       time,
  end_time         time,
  poster_url       text,
  registration_url text,
  is_free          boolean not null default true,
  status           public.event_status not null default 'pending',
  rejection_reason text,
  reviewed_by      uuid references public.profiles(id),
  reviewed_at      timestamptz,
  event_code       text,
  created_at       timestamptz not null default now()
);
create index events_status_date_idx on public.events(status, event_date);
create index events_organizer_idx   on public.events(organizer_id);

-- ---------- ticket tiers ----------
create table public.ticket_tiers (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  name        text not null,
  description text,
  price_pkr   integer not null check (price_pkr >= 0),
  quantity    integer check (quantity is null or quantity > 0),  -- null = unlimited
  sold        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index ticket_tiers_event_idx on public.ticket_tiers(event_id);

-- ---------- bookings ----------
create table public.bookings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  event_id      uuid not null references public.events(id) on delete restrict,
  tier_id       uuid not null references public.ticket_tiers(id) on delete restrict,
  full_name     text not null,
  email         text not null,
  cnic          text not null,          -- visible only to the owner and admins
  roll_number   text,
  university    text,
  amount_pkr    integer not null,       -- always set server-side from the tier
  status        public.booking_status not null default 'pending_payment',
  ticket_code   text not null unique
                default ('UEP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  confirmed_at  timestamptz,
  checked_in_at timestamptz,
  created_at    timestamptz not null default now()
);
create index bookings_user_idx  on public.bookings(user_id);
create index bookings_event_idx on public.bookings(event_id);

-- ---------- payments (written ONLY by Edge Functions / service role) ----------
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references public.bookings(id) on delete cascade,
  provider        public.pay_provider not null,
  status          public.pay_status not null default 'initiated',
  amount_pkr      integer not null,
  txn_ref         text not null unique,
  provider_txn_id text,
  response_code   text,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index payments_booking_idx on public.payments(booking_id);

-- ---------- messaging (student <-> organizer, per event) ----------
create table public.conversations (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events(id) on delete cascade,
  student_id   uuid not null references public.profiles(id) on delete cascade,
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (event_id, student_id)
);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 2000),
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index messages_conv_idx on public.messages(conversation_id, created_at);

-- ---------- contact-us form ----------
create table public.contact_messages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 2 and 120),
  email      text not null check (char_length(email) between 5 and 200),
  university text,
  message    text not null check (char_length(message) between 5 and 4000),
  status     text not null default 'new' check (status in ('new','in_progress','resolved')),
  created_at timestamptz not null default now()
);
