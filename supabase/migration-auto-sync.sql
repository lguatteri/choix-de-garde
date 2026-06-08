-- ============================================================
-- Planning auto : COPIE séparée par médecin.
--   - L'import Perso → auto se fait au clic sur « Déclarer » (app principale) :
--     ça copie les voeux du médecin dans auto_declarations.
--   - L'édition sur l'app auto reste dans cette copie (ne touche jamais `voeux`).
--   - preferences   : préférences récurrentes
--   - session_state : limites max_wished / max_indispo (admin)
-- À exécuter dans Supabase → SQL Editor → New query. Idempotent.
-- ============================================================

-- Anciennes tables du modèle "exclusions" abandonnées
drop table if exists public.auto_exclusions;
drop table if exists public.auto_optin;

-- Copie auto (éditable indépendamment du Perso)
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
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Préférences récurrentes
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

-- Limites configurables par l'admin
alter table public.session_state
  add column if not exists max_wished  int not null default 5,
  add column if not exists max_indispo int not null default 30;
