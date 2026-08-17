-- ============================================================
-- Progression du tour partagée : la liste des créneaux déjà choisis par le
-- picker courant dans le tour en cours (state.currentTurnSlots) est synchronisée
-- dans session_state, pour que les LECTEURS (non-admins) voient le même liseré
-- bleu « dates suggérées » et le même quota de tour que l'admin.
-- À exécuter dans Supabase → SQL Editor. Idempotent.
-- ⚠️ À lancer AVANT de déployer la nouvelle version (sinon la sync de
--    session_state renvoie 400 : la colonne n'existe pas encore).
-- ============================================================

alter table public.session_state
  add column if not exists current_turn_slots jsonb not null default '[]'::jsonb;
