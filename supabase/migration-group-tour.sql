-- ============================================================
-- Migration : passage à un tour de groupe (admin contrôle l'avancement)
-- À exécuter dans le SQL Editor Supabase
-- ============================================================

alter table public.session_state
  add column if not exists current_tour int not null default 1,
  add column if not exists tour_start_idx int not null default 0,
  add column if not exists tour_direction int not null default 1;
