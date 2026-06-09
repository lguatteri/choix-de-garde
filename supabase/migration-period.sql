-- ============================================================
-- Changement de période : permettre à l'admin de purger les données
-- propres à une période (voeux, auto_declarations) lors d'un « Nouvelle période ».
-- (period_start / period_end existent déjà dans session_state.)
-- À exécuter dans Supabase → SQL Editor. Idempotent.
-- ============================================================

-- voeux : chacun les siennes, + l'admin peut purger (nouvelle période)
drop policy if exists "voeux_modify_own" on public.voeux;
create policy "voeux_modify_own" on public.voeux
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- auto_declarations : idem
drop policy if exists "auto_decl_modify_own" on public.auto_declarations;
create policy "auto_decl_modify_own" on public.auto_declarations
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
