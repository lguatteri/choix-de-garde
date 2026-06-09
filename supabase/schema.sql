-- ============================================================
-- Choix de garde — schéma Supabase
-- À exécuter dans : Supabase dashboard → SQL Editor → New query
-- Tout le bloc d'un coup. Idempotent (peut être réexécuté sans casser).
-- ============================================================

-- ----- TABLES -----------------------------------------------

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  doctor_name text not null unique,
  is_admin boolean not null default false,
  is_super_admin boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists public.doctors (
  name text primary key,
  ach_sem int not null default 0,
  ach_we  int not null default 0,
  hmn_sem int not null default 0,
  hmn_we  int not null default 0
);

create table if not exists public.assignments (
  date date not null,
  site text not null check (site in ('HMN','ACH')),
  doctor_name text not null references public.doctors(name) on update cascade,
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id),
  primary key (date, site)
);

create table if not exists public.voeux (
  user_id uuid references auth.users(id) on delete cascade,
  date date not null,
  voeu text not null check (voeu in ('wishedHMN','wishedACH','wishedBoth','blocked')),
  primary key (user_id, date)
);

create table if not exists public.session_state (
  id int primary key default 1 check (id = 1),
  first_picker text references public.doctors(name),
  picker_cursor int not null default 0,
  current_turn_pick_count int not null default 0,
  forced_next_picker text references public.doctors(name),
  period_start date not null default '2026-06-01',
  period_end   date not null default '2026-09-30',
  updated_at timestamptz default now()
);
insert into public.session_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.holidays (
  date date primary key
);

-- ----- HELPERS DE PERMISSION --------------------------------

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select is_admin or is_super_admin from public.profiles where user_id = auth.uid()),
    false
  );
$$;

create or replace function public.is_super_admin() returns boolean
  language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select is_super_admin from public.profiles where user_id = auth.uid()),
    false
  );
$$;

-- ----- TRIGGER ANTI-DÉMOTION DU SUPER_ADMIN -----------------

create or replace function public.protect_super_admin() returns trigger
  language plpgsql security definer set search_path = public
as $$
declare
  remaining int;
  any_super boolean;
begin
  -- Bootstrap : si aucun super admin n'existe encore, on autorise n'importe qui
  -- à en devenir un (utile pour l'initialisation manuelle du tout 1er admin)
  select exists (select 1 from public.profiles where is_super_admin = true) into any_super;

  -- Modification de is_super_admin → réservée aux super_admins (sauf bootstrap)
  if (OLD.is_super_admin is distinct from NEW.is_super_admin) and not public.is_super_admin() and any_super then
    raise exception 'Seul un super admin peut modifier le statut super_admin';
  end if;
  -- Garder au moins 1 super_admin
  if OLD.is_super_admin = true and NEW.is_super_admin = false then
    select count(*) into remaining from public.profiles
      where is_super_admin = true and user_id <> OLD.user_id;
    if remaining = 0 then
      raise exception 'Il doit toujours rester au moins un super admin';
    end if;
  end if;
  -- Modification de is_admin → réservée aux admins (sauf bootstrap)
  if (OLD.is_admin is distinct from NEW.is_admin) and not public.is_admin() and any_super then
    raise exception 'Seul un admin peut modifier le statut admin';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_super_admin_trigger on public.profiles;
create trigger protect_super_admin_trigger
  before update on public.profiles
  for each row execute function public.protect_super_admin();

-- ----- ROW LEVEL SECURITY -----------------------------------

alter table public.profiles      enable row level security;
alter table public.doctors       enable row level security;
alter table public.assignments   enable row level security;
alter table public.voeux         enable row level security;
alter table public.session_state enable row level security;
alter table public.holidays      enable row level security;

-- Profiles : lecture pour tous les users connectés ; insertion réservée à
-- l'utilisateur qui crée son propre profil ; update via le trigger ci-dessus
drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (user_id = auth.uid());

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin" on public.profiles
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- Doctors : lecture libre, écriture admin
drop policy if exists "doctors_select_all" on public.doctors;
create policy "doctors_select_all" on public.doctors for select using (true);
drop policy if exists "doctors_admin_write" on public.doctors;
create policy "doctors_admin_write" on public.doctors
  for all using (public.is_admin()) with check (public.is_admin());

-- Assignments : lecture libre, écriture admin
drop policy if exists "assignments_select_all" on public.assignments;
create policy "assignments_select_all" on public.assignments for select using (true);
drop policy if exists "assignments_admin_write" on public.assignments;
create policy "assignments_admin_write" on public.assignments
  for all using (public.is_admin()) with check (public.is_admin());

-- Vœux : chacun ses propres lignes
drop policy if exists "voeux_select_own" on public.voeux;
create policy "voeux_select_own" on public.voeux for select using (user_id = auth.uid());
drop policy if exists "voeux_modify_own" on public.voeux;
create policy "voeux_modify_own" on public.voeux
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- Session_state : lecture libre, écriture admin
drop policy if exists "session_select_all" on public.session_state;
create policy "session_select_all" on public.session_state for select using (true);
drop policy if exists "session_admin_write" on public.session_state;
create policy "session_admin_write" on public.session_state
  for all using (public.is_admin()) with check (public.is_admin());

-- Holidays : lecture libre, écriture admin
drop policy if exists "holidays_select_all" on public.holidays;
create policy "holidays_select_all" on public.holidays for select using (true);
drop policy if exists "holidays_admin_write" on public.holidays;
create policy "holidays_admin_write" on public.holidays
  for all using (public.is_admin()) with check (public.is_admin());

-- ----- REALTIME ---------------------------------------------
-- Activer le streaming des changements en temps réel
alter publication supabase_realtime add table public.assignments;
alter publication supabase_realtime add table public.session_state;
alter publication supabase_realtime add table public.doctors;
alter publication supabase_realtime add table public.profiles;

-- ----- DONNÉES INITIALES : médecins + objectifs + fériés ---

insert into public.doctors (name, ach_sem, ach_we, hmn_sem, hmn_we) values
  ('BELFQUIH Oumayma',     4, 2, 2, 1),
  ('BENMANSOUR Safiyah',   3, 1, 1, 2),
  ('BOUKHARI Ghassene',    3, 2, 4, 2),
  ('BOUZAABIA Zeineb',     3, 2, 4, 1),
  ('CHABERT Jonathan',     2, 1, 2, 1),
  ('FERCHIOU Aziz',        5, 0, 0, 0),
  ('GERENTES Mona',        0, 0, 6, 3),
  ('GERVOT Cyrielle',      0, 0, 4, 3),
  ('GUATTERI Laura',       3, 2, 4, 1),
  ('HOTIER Sevan',         2, 2, 2, 0),
  ('JAGARAJ Praveen',      3, 1, 2, 0),
  ('JEANNIN Juliette',     0, 0, 7, 4),
  ('KABA Zuleyha',         4, 2, 3, 2),
  ('LADEA Maria',          5, 1, 0, 0),
  ('LAIDI Charles',        3, 2, 1, 0),
  ('LANGRENNE Clémentine', 4, 2, 3, 2),
  ('LORIC Marie',          0, 0, 5, 2),
  ('MACONE Alexandre',     4, 2, 2, 1),
  ('NEU Nathan',           4, 2, 3, 2),
  ('NKAM Irène',           5, 0, 0, 0),
  ('OUCHIHA Lilia',        0, 0, 7, 4),
  ('PIGNON Baptiste',      3, 1, 2, 0),
  ('POPA Daniela',         4, 1, 2, 0),
  ('RABU Corentin',        0, 0, 3, 2),
  ('SAHNOUN Chema',        5, 1, 0, 0),
  ('SANDRONI Veronica',    4, 2, 3, 2),
  ('SAYOUS Romain',        2, 0, 5, 2),
  ('SZOKE Andrei',         5, 0, 0, 0),
  ('ZAGHBIB Karim',        0, 0, 5, 0),
  ('ZERDAZI El-Hadi',      0, 1, 5, 0)
on conflict (name) do update set
  ach_sem = excluded.ach_sem, ach_we = excluded.ach_we,
  hmn_sem = excluded.hmn_sem, hmn_we = excluded.hmn_we;

insert into public.holidays (date) values
  ('2026-07-14'), ('2026-08-15')
on conflict (date) do nothing;

-- ----- PRÉFÉRENCES RÉCURRENTES (mode Auto) ------------------
create table if not exists public.preferences (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  blocked_hmn int[] not null default '{}',
  blocked_ach int[] not null default '{}',
  prefer_sem  int[] not null default '{}',
  prefer_we   int[] not null default '{}',
  updated_at  timestamptz default now()
);
alter table public.preferences enable row level security;
drop policy if exists "preferences_select_own_or_admin" on public.preferences;
create policy "preferences_select_own_or_admin" on public.preferences
  for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "preferences_modify_own" on public.preferences;
create policy "preferences_modify_own" on public.preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- PLANNING AUTO : copie séparée par médecin --------------
-- Importée du Perso au clic sur « Déclarer » ; éditée sur l'app auto sans
-- toucher à `voeux`. La génération lit cette copie.
create table if not exists public.auto_declarations (
  user_id uuid references auth.users(id) on delete cascade,
  date    date not null,
  voeu    text not null check (voeu in ('wishedHMN','wishedACH','wishedBoth','blocked')),
  primary key (user_id, date)
);
alter table public.auto_declarations enable row level security;
drop policy if exists "auto_decl_select_own_or_admin" on public.auto_declarations;
create policy "auto_decl_select_own_or_admin" on public.auto_declarations
  for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "auto_decl_modify_own" on public.auto_declarations;
create policy "auto_decl_modify_own" on public.auto_declarations
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- Limites configurables par l'admin (dans session_state, défini plus haut)
alter table public.session_state
  add column if not exists max_wished       int not null default 5,
  add column if not exists max_indispo      int not null default 30,
  add column if not exists wished_per_gardes int not null default 3;
