-- Réglage global (super admin) : masquer les éléments du « Planning auto »
-- dans l'app assistée, pour tous les utilisateurs.
-- À lancer une fois dans l'éditeur SQL Supabase.

ALTER TABLE session_state
  ADD COLUMN IF NOT EXISTS hide_auto boolean NOT NULL DEFAULT false;
