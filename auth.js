'use strict';

// ============================================================
// Auth UI : login / inscription / sélection du nom de médecin
// ============================================================

const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabaseClient = sbClient; // accessible depuis app.js

let currentUser = null;
let currentProfile = null; // { user_id, doctor_name, is_admin, is_super_admin }
window.currentUser = null;
window.currentProfile = null;
function syncUserGlobals() {
  window.currentUser = currentUser;
  window.currentProfile = currentProfile;
}

async function getProfile(userId) {
  const { data, error } = await sbClient
    .from('profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) console.warn('getProfile error', error);
  return data;
}

async function refreshSession() {
  const { data: { user } } = await sbClient.auth.getUser();
  currentUser = user;
  currentProfile = user ? await getProfile(user.id) : null;
  return { user, profile: currentProfile };
}

function showAuthScreen() {
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app-root').hidden = true;
}
function hideAuthScreen() {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-root').hidden = false;
}

async function showProfileSetup() {
  const sel = document.getElementById('profile-doctor-select');
  sel.innerHTML = '';
  // Charger la liste des médecins déjà attribués pour les exclure
  const { data: doctors } = await sbClient.from('doctors').select('name').order('name');
  const { data: profiles } = await sbClient.from('profiles').select('doctor_name');
  const taken = new Set((profiles || []).map(p => p.doctor_name));
  (doctors || []).forEach(d => {
    if (taken.has(d.name)) return;
    const opt = document.createElement('option');
    opt.value = d.name; opt.textContent = d.name;
    sel.appendChild(opt);
  });
  document.getElementById('profile-setup').hidden = false;
}

async function loginOrSignup(mode) {
  const email = document.getElementById('auth-email').value.trim();
  const pwd = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.style.color = '';   // reset (rouge par défaut)
  errEl.textContent = '';
  if (!email || !pwd) { errEl.textContent = 'Email et mot de passe requis'; return; }
  if (mode === 'signup' && pwd.length < 6) { errEl.textContent = 'Mot de passe : 6 caractères minimum'; return; }

  errEl.textContent = mode === 'signup' ? 'Création…' : 'Connexion…';
  errEl.style.color = '#6b7280';
  const fn = mode === 'signup' ? 'signUp' : 'signInWithPassword';
  const { data, error } = await sbClient.auth[fn]({ email, password: pwd });
  if (error) {
    errEl.style.color = '';
    errEl.textContent = error.message + ' (code ' + (error.status || '?') + ')';
    return;
  }
  errEl.textContent = '';

  // signUp : si email confirmation activée, data.user existe mais session=null
  if (mode === 'signup' && !data.session) {
    errEl.style.color = '#16a34a';
    errEl.textContent = 'Compte créé. Confirme l\'email reçu puis re-clique "Se connecter".';
    return;
  }

  currentUser = data.user;
  currentProfile = await getProfile(currentUser.id);
  syncUserGlobals();
  if (!currentProfile) {
    // 1ère connexion : choisir le médecin
    await showProfileSetup();
  } else {
    onAuthenticated();
  }
}

async function saveProfile() {
  const doc = document.getElementById('profile-doctor-select').value;
  const errEl = document.getElementById('profile-error');
  errEl.textContent = '';
  if (!doc) { errEl.textContent = 'Choisis un nom de médecin'; return; }
  const { error } = await sbClient
    .from('profiles')
    .insert({ user_id: currentUser.id, doctor_name: doc });
  if (error) { errEl.textContent = error.message; return; }
  currentProfile = await getProfile(currentUser.id);
  syncUserGlobals();
  document.getElementById('profile-setup').hidden = true;
  onAuthenticated();
}

async function logout() {
  await sbClient.auth.signOut();
  currentUser = null; currentProfile = null;
  syncUserGlobals();
  location.reload();
}

function onAuthenticated() {
  hideAuthScreen();
  // Trigger l'init de l'app principale
  if (typeof initApp === 'function') initApp();
}

// Bootstrap
(async () => {
  const { data: { session } } = await sbClient.auth.getSession();
  if (session) {
    currentUser = session.user;
    currentProfile = await getProfile(currentUser.id);
    syncUserGlobals();
    if (!currentProfile) {
      showAuthScreen();
      await showProfileSetup();
    } else {
      hideAuthScreen();
      if (typeof initApp === 'function') initApp();
    }
  } else {
    showAuthScreen();
  }
  // Réagir aux changements de session
  sbClient.auth.onAuthStateChange((_evt, sess) => {
    if (!sess) showAuthScreen();
  });
})();

// Bind UI — direct, sans attendre DOMContentLoaded
// (auth.js est chargé en fin de <body>, le DOM est déjà parsé)
function bindAuthUI() {
  const loginBtn = document.getElementById('auth-login-btn');
  const signupBtn = document.getElementById('auth-signup-btn');
  const saveBtn = document.getElementById('profile-save-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const pwdInput = document.getElementById('auth-password');
  if (!loginBtn) { console.error('Auth UI elements not found'); return; }
  loginBtn.onclick = () => loginOrSignup('login');
  signupBtn.onclick = () => loginOrSignup('signup');
  if (saveBtn) saveBtn.onclick = saveProfile;
  if (logoutBtn) logoutBtn.onclick = logout;
  if (pwdInput) pwdInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginOrSignup('login');
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindAuthUI);
} else {
  bindAuthUI();
}
