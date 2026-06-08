'use strict';

// Auth simplifiée pour l'app auto (réutilise les comptes de l'app principale)
const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabaseClient = sbClient;
window.currentUser = null;
window.currentProfile = null;

async function getProfile(userId) {
  const { data } = await sbClient.from('profiles').select('*').eq('user_id', userId).maybeSingle();
  return data;
}

function showAuthScreen() {
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app-root').hidden = true;
}
function hideAuthScreen() {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-root').hidden = false;
}

// Route selon le rôle : admin → atelier de génération, médecin → page Perso
function routeAfterAuth() {
  const prof = window.currentProfile;
  const admin = prof && (prof.is_admin || prof.is_super_admin);
  document.getElementById('auth-screen').hidden = true;
  // Le bouton "Atelier admin" (sur la page médecin) n'apparaît que pour les admins
  const gotoAdmin = document.getElementById('goto-admin-btn');
  if (gotoAdmin) gotoAdmin.hidden = !admin;
  if (admin) {
    if (typeof showAdminWorkbench === 'function') showAdminWorkbench();
    if (typeof initAutoApp === 'function') initAutoApp();
  } else {
    if (typeof showPersoPage === 'function') showPersoPage();
  }
}

async function loginAuto() {
  const email = document.getElementById('auth-email').value.trim();
  const pwd = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  if (!email || !pwd) { errEl.textContent = 'Email et mot de passe requis'; return; }
  errEl.style.color = '#6b7280';
  errEl.textContent = 'Connexion…';
  const { data, error } = await sbClient.auth.signInWithPassword({ email, password: pwd });
  if (error) {
    errEl.style.color = '';
    errEl.textContent = error.message;
    return;
  }
  errEl.textContent = '';
  window.currentUser = data.user;
  window.currentProfile = await getProfile(data.user.id);
  routeAfterAuth();
}

async function logoutAuto() {
  await sbClient.auth.signOut();
  window.currentUser = null;
  window.currentProfile = null;
  location.reload();
}

(async () => {
  const { data: { session } } = await sbClient.auth.getSession();
  if (session) {
    window.currentUser = session.user;
    window.currentProfile = await getProfile(session.user.id);
    routeAfterAuth();
  } else {
    showAuthScreen();
  }
})();

function bindAutoUI() {
  document.getElementById('auth-login-btn').onclick = loginAuto;
  document.getElementById('logout-btn').onclick = logoutAuto;
  document.getElementById('auth-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') loginAuto();
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindAutoUI);
else bindAutoUI();
