-- ============================================================
-- À exécuter UNE FOIS, après que Laura se soit créée un compte
-- via l'app (login → "Créer un compte" → email + mdp).
--
-- Remplace 'guatteri.laura@gmail.com' par l'email exact utilisé.
-- ============================================================

update public.profiles
set is_admin = true, is_super_admin = true
where user_id = (
  select id from auth.users where email = 'guatteri.laura@gmail.com'
);

-- Vérification :
select p.doctor_name, p.is_admin, p.is_super_admin, u.email
from public.profiles p
join auth.users u on u.id = p.user_id
where p.is_super_admin = true;
