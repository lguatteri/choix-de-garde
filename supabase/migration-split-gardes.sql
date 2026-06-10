-- ============================================================
-- Demi-gardes : un créneau 24h (dimanche/férié) peut être divisé en 2×12h
-- (Jour / Nuit) par site → 2 médecins possibles sur un même (date, site).
--   - doctor_name   : garde entière OU demi « jour »
--   - doctor_name_2 : demi « nuit » (uniquement si is_split)
--   - is_split      : true si le site est divisé
-- À exécuter dans Supabase → SQL Editor. Idempotent.
-- ============================================================

alter table public.assignments alter column doctor_name drop not null;
alter table public.assignments
  add column if not exists doctor_name_2 text references public.doctors(name) on update cascade;
alter table public.assignments
  add column if not exists is_split boolean not null default false;
