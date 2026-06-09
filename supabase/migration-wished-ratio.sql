-- ============================================================
-- Vœux proportionnels : max de vœux par médecin = round((sem + 2×WE) / N)
-- N = nb de gardes par vœu (réglable par l'admin), stocké dans session_state.
-- À exécuter dans Supabase → SQL Editor. Idempotent.
-- ============================================================

alter table public.session_state
  add column if not exists wished_per_gardes int not null default 3;
