-- ============================================================
-- migration-realtime-publication.sql
-- S'assurer que les tables clés sont diffusées en TEMPS RÉEL (publication
-- supabase_realtime). Sans ça, les autres écrans ne voient pas les gardes se
-- remplir sans rafraîchir. Idempotent (ignore « already member »).
-- ============================================================

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.assignments';
  exception when duplicate_object then null; end;

  begin execute 'alter publication supabase_realtime add table public.session_state';
  exception when duplicate_object then null; end;

  begin execute 'alter publication supabase_realtime add table public.voeux';
  exception when duplicate_object then null; end;
end $$;

-- Pour que les événements DELETE renvoient bien les colonnes (date/site) :
alter table public.assignments replica identity full;

-- Vérification : liste des tables diffusées en temps réel (doit contenir les 3)
select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename;
