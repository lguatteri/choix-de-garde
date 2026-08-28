-- ============================================================
-- migration-voeux-by-name.sql
-- Rattacher les vœux au MÉDECIN (doctor_name) plutôt qu'au compte (user_id),
-- afin qu'un super admin puisse éditer les vœux/indispos d'un médecin même
-- sans compte. Idempotent autant que possible.
-- ============================================================

-- 1) Nouvelle colonne doctor_name
alter table public.voeux
  add column if not exists doctor_name text references public.doctors(name) on delete cascade;

-- 2) Remplir depuis les comptes existants
update public.voeux v
   set doctor_name = p.doctor_name
  from public.profiles p
 where v.user_id = p.user_id
   and v.doctor_name is null;

-- 3) Supprimer d'éventuelles lignes orphelines (user_id sans profil correspondant)
delete from public.voeux where doctor_name is null;

-- 4) Supprimer l'ANCIENNE clé primaire (user_id, date) AVANT de toucher à user_id
--    (on ne peut pas retirer le NOT NULL d'une colonne encore dans la PK)
alter table public.voeux drop constraint if exists voeux_pkey;

-- 5) user_id devient optionnel (un médecin sans compte n'en a pas)
alter table public.voeux alter column user_id drop not null;

-- 6) Nouvelle clé primaire = (doctor_name, date)
alter table public.voeux add primary key (doctor_name, date);

-- 7) RLS : lecture de ses propres vœux OU admin ; écriture pareil.
--    (L'affichage sur le planning reste filtré côté client : chaque choisisseur
--     ne voit que les siens ; les admins peuvent lire tous les vœux pour l'édition.)
drop policy if exists "voeux_select_own" on public.voeux;
drop policy if exists "voeux_select_own_or_admin" on public.voeux;
create policy "voeux_select_own_or_admin" on public.voeux for select using (
  public.is_admin()
  or doctor_name = (select doctor_name from public.profiles where user_id = auth.uid())
);

drop policy if exists "voeux_modify_own" on public.voeux;
drop policy if exists "voeux_modify_own_or_admin" on public.voeux;
create policy "voeux_modify_own_or_admin" on public.voeux for all using (
  public.is_admin()
  or doctor_name = (select doctor_name from public.profiles where user_id = auth.uid())
) with check (
  public.is_admin()
  or doctor_name = (select doctor_name from public.profiles where user_id = auth.uid())
);
