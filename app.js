'use strict';

// ============================================================
// État (en mémoire — la persistance se fait via Supabase)
// ============================================================
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function defaultState() {
  return {
    assignments: {},          // dateStr -> { HMN: {doctor}, ACH: {doctor} }
    history: [],              // pour undo en mémoire (snapshots)
    voeux: {},                // dateStr -> 'wishedHMN' | 'wishedACH' | 'wishedBoth' | 'blocked'
    myName: null,             // = currentProfile.doctor_name après login
    firstPicker: null,
    pickerCursor: 0,
    currentTour: 1,           // tour de groupe (admin contrôle son avancement)
    tourStartIdx: 0,          // index du 1er picker du tour courant dans state.doctors
    tourDirection: 1,         // 1 = alphabétique avant, -1 = arrière
    currentTurnPickCount: 0,
    currentTurnSlots: [],     // ['date:site', ...] des picks faits dans le tour courant — local
    returnCursor: null,       // local : front à retrouver après un retour manuel en arrière (correction)
    forcedNextPicker: null,
    allVoeux: {},             // doctorName -> { date -> voeu }, chargé depuis Supabase
    neutralView: false,       // local : masque la coloration liée au picker courant
    maxWished: 2,             // calculé selon mes gardes (proportionnel, réglé par l'admin)
    wishedPerGardes: 3,
    maxIndispo: 30,
    doctors: deepClone(DOCTORS),
    holidays: HOLIDAYS.slice(),
  };
}

let state = defaultState();
const sb = () => window.supabaseClient; // raccourci

// ============================================================
// Chargement initial depuis Supabase
// ============================================================
async function loadAllFromSupabase() {
  const [doctors, holidays, assignments, sess, voeux, profile] = await Promise.all([
    sb().from('doctors').select('*').order('name'),
    sb().from('holidays').select('date'),
    sb().from('assignments').select('*'),
    sb().from('session_state').select('*').eq('id', 1).maybeSingle(),
    sb().from('voeux').select('*'),
    sb().from('profiles').select('*'),
  ]);

  if (doctors.data) {
    state.doctors = doctors.data.map(d => ({
      name: d.name,
      ACH: { sem: d.ach_sem, we: d.ach_we },
      HMN: { sem: d.hmn_sem, we: d.hmn_we },
    })).sort((a,b) => a.name.localeCompare(b.name, 'fr'));
  }
  if (holidays.data) state.holidays = holidays.data.map(h => h.date);

  // Établir d'abord la période courante (sert à filtrer ci-dessous).
  if (sess.data) {
    state.firstPicker = sess.data.first_picker;
    state.pickerCursor = sess.data.picker_cursor;
    state.currentTurnPickCount = sess.data.current_turn_pick_count;
    state.forcedNextPicker = null;   // fonctionnalité « forcer un choix » retirée (on ignore toute valeur résiduelle en base)
    state.currentTour = sess.data.current_tour ?? 1;
    state.tourStartIdx = sess.data.tour_start_idx ?? 0;
    state.tourDirection = sess.data.tour_direction ?? 1;
    state.wishedPerGardes = sess.data.wished_per_gardes ?? 3;
    state.maxIndispo = sess.data.max_indispo ?? 30;
    if (sess.data.period_start) PERIOD_START = sess.data.period_start;
    if (sess.data.period_end)   PERIOD_END   = sess.data.period_end;
  }

  // Ne charger que les assignations du quadrimestre courant : celles d'un
  // quadrimestre précédent ne doivent pas compter dans les nouveaux objectifs.
  state.assignments = {};
  (assignments.data || []).forEach(row => {
    if (!inPeriod(row.date)) return;
    if (!state.assignments[row.date]) state.assignments[row.date] = {};
    state.assignments[row.date][row.site] = rowToSite(row);
  });

  state.allProfiles = profile.data || [];
  if (window.currentProfile) state.myName = window.currentProfile.doctor_name;

  // Construire allVoeux : { doctorName -> { date -> voeu } }
  const profByUid = Object.fromEntries(state.allProfiles.map(p => [p.user_id, p.doctor_name]));
  state.allVoeux = {};
  (voeux.data || []).forEach(row => {
    const dn = profByUid[row.user_id];
    if (!dn) return;
    if (!inPeriod(row.date)) return;   // vœux/indispos hors quadrimestre courant ignorés
    if (!state.allVoeux[dn]) state.allVoeux[dn] = {};
    state.allVoeux[dn][row.date] = row.voeu;
  });
  state.voeux = state.allVoeux[state.myName] || {};
  computeMyMaxWished();
}

// Max de vœux pour MOI = round((sem + 2×WE) / N), minimum 2
function computeMyMaxWished() {
  const me = findDoctor(state.myName);
  if (!me) { state.maxWished = 2; return; }
  const w = (me.ACH.sem + me.HMN.sem) + 2 * (me.ACH.we + me.HMN.we);
  state.maxWished = Math.max(2, Math.round(w / (state.wishedPerGardes || 3)));
}

// ============================================================
// Sync vers Supabase (par table) — idempotent
// ============================================================
// Reconstruit l'objet site (plein ou divisé jour/nuit) depuis une ligne DB
function rowToSite(row) {
  if (row.is_split) return { split: true, jour: row.doctor_name || null, nuit: row.doctor_name_2 || null };
  return { doctor: row.doctor_name };
}
function siteIsEmpty(s) {
  return !s || (s.split ? (!s.jour && !s.nuit) : !s.doctor);
}
function siteFull(s) {            // plus de place dispo sur ce site
  if (!s) return false;
  return s.split ? (!!s.jour && !!s.nuit) : !!s.doctor;
}
// Pousse l'état complet d'un site (date,site) vers Supabase, ou le supprime si vide
async function syncSite(date, site) {
  const s = (state.assignments[date] || {})[site];
  if (siteIsEmpty(s)) {
    return sb().from('assignments').delete().eq('date', date).eq('site', site);
  }
  return sb().from('assignments').upsert({
    date, site,
    is_split: !!s.split,
    doctor_name: s.split ? (s.jour || null) : s.doctor,
    doctor_name_2: s.split ? (s.nuit || null) : null,
    updated_at: new Date().toISOString(),
    updated_by: window.currentUser ? window.currentUser.id : null,
  });
}
async function syncVoeu(date, voeu) {
  if (voeu) {
    return sb().from('voeux').upsert({
      user_id: window.currentUser.id,
      date, voeu,
    });
  }
  return sb().from('voeux').delete().eq('user_id', window.currentUser.id).eq('date', date);
}
async function syncSession() {
  const { error } = await sb().from('session_state').update({
    first_picker: state.firstPicker,
    picker_cursor: state.pickerCursor,
    current_turn_pick_count: state.currentTurnPickCount || 0,
    forced_next_picker: state.forcedNextPicker,
    current_tour: state.currentTour,
    tour_start_idx: state.tourStartIdx,
    tour_direction: state.tourDirection,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (error) {
    console.error('syncSession error:', error);
    alert('Erreur sync session : ' + error.message);
  }
}
async function syncDoctor(d) {
  return sb().from('doctors').update({
    ach_sem: d.ACH.sem, ach_we: d.ACH.we,
    hmn_sem: d.HMN.sem, hmn_we: d.HMN.we,
  }).eq('name', d.name);
}

// Compat : dans le code existant on appelle saveState() après les changements
// d'état. On la garde comme no-op (les sync sont faits explicitement).
function saveState() { /* no-op : sync explicite via syncXxx */ }

// ============================================================
// Dates
// ============================================================
const MONTHS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const WEEKDAYS_FR = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
const WEEKDAYS_HEADER = ['L','M','M','J','V','S','D']; // lundi en premier

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()); }
function parseYMD(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function formatLong(dateStr) {
  const d = parseYMD(dateStr);
  return `${WEEKDAYS_FR[d.getDay()]} ${d.getDate()} ${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}`;
}

function* iterDates(startStr, endStr) {
  const s = parseYMD(startStr), e = parseYMD(endStr);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate()+1)) yield ymd(d);
}

function isHoliday(dateStr) { return state.holidays.includes(dateStr); }
function dayType(dateStr) {
  if (isHoliday(dateStr)) return 'holiday';
  const dow = parseYMD(dateStr).getDay();
  if (dow === 0) return 'sunday';
  if (dow === 6) return 'saturday';
  if (dow === 5) return 'friday';
  return 'weekday';
}
function is24h(dateStr) {
  // Dimanche + jour férié = garde 24h ; sinon 12h. Mais TOUJOURS 2 sites séparés (HMN + ACH).
  const t = dayType(dateStr);
  return t === 'sunday' || t === 'holiday';
}
function isWE(dateStr) {
  const t = dayType(dateStr);
  return t === 'sunday' || t === 'saturday' || t === 'holiday';
}
function tourSlotType(dateStr) {
  if (isWE(dateStr)) return 'we';
  if (dayType(dateStr) === 'friday') return 'vendredi';
  return 'semaine';
}
function objectiveBucket(dateStr) { return isWE(dateStr) ? 'we' : 'sem'; }
// inPeriod(dateStr) est défini dans doctors.js (partagé avec l'app auto).

// ============================================================
// Médecins
// ============================================================
function findDoctor(name) { return state.doctors.find(d => d.name === name); }
function totalWE(d) { return (d.ACH.we|0) + (d.HMN.we|0); }
function totalObjective(d) { return (d.ACH.sem|0) + (d.ACH.we|0) + (d.HMN.sem|0) + (d.HMN.we|0); }
function siteTotal(d, site) { return (d[site].sem|0) + (d[site].we|0); }
function eligibleAt(d, site) { return siteTotal(d, site) > 0; }
function eligibleSites(d) {
  const out = [];
  if (eligibleAt(d, 'HMN')) out.push('HMN');
  if (eligibleAt(d, 'ACH')) out.push('ACH');
  return out;
}
function slotEligible(d, slotKey) {
  if (slotKey === 'HMN') return eligibleAt(d, 'HMN');
  if (slotKey === 'ACH') return eligibleAt(d, 'ACH');
  return true;
}

function category(d) {
  const t = totalWE(d);
  if (t >= 4) return 'ge4';
  if (t === 3) return 'eq3';
  if (t > 0) return 'lt3';
  return 'no';
}

const TOUR_RULES = {
  ge4: { 1: { semaine: 1, vendredi: 1, we: 2 }, 2: { semaine: 1, we: 1 } },
  eq3: { 1: { semaine: 1, vendredi: 1, we: 1 }, 2: { semaine: 1, we: 1 } },
  lt3: { 1: { semaine: 1, vendredi: 1 },        2: { semaine: 1, we: 1 } },
  no:  { 1: { semaine: 1, vendredi: 1 },        2: { semaine: 1 } },
};
function tourQuota(d, tour) {
  const rules = TOUR_RULES[category(d)];
  const q = rules[tour] ? Object.assign({}, rules[tour]) : { libre: 1 };
  // Filtrage dynamique : retirer les types d'objectifs que le médecin n'a pas
  const totalSem = (d.ACH.sem|0) + (d.HMN.sem|0);
  const totalWE  = (d.ACH.we|0)  + (d.HMN.we|0);
  if (totalWE === 0) delete q.we;
  if (totalSem === 0) { delete q.semaine; delete q.vendredi; }
  return q;
}

// ============================================================
// Comptabilisation des picks par médecin
// ============================================================
function picksByDoctor(name) {
  const out = [];
  Object.entries(state.assignments).forEach(([date, slots]) => {
    ['HMN', 'ACH'].forEach(site => {
      const s = slots[site];
      if (!s) return;
      if (s.split) {
        // demi-gardes : chacune vaut 0,5 mais est un choix (1 tour) distinct
        if (s.jour === name) out.push({ date, site, slot: site, half: 'jour', weight: 0.5 });
        if (s.nuit === name) out.push({ date, site, slot: site, half: 'nuit', weight: 0.5 });
      } else if (s.doctor === name) {
        out.push({ date, site, slot: site, weight: 1 });
      }
    });
  });
  return out;
}

// Formatage des demis : 2 → "2", 2.5 → "2,5"
function fmtHalf(n) {
  return (Math.round(n * 2) / 2).toString().replace('.', ',');
}

// Migration : convertir les anciens slots full24 en HMN/ACH directs
function migrateFull24() {
  let changed = false;
  Object.keys(state.assignments).forEach(date => {
    const a = state.assignments[date];
    if (!a.full24 || !a.full24.length) return;
    a.full24.forEach(p => {
      if (!p || !p.doctor) return;
      const site = (p.site === 'ACH') ? 'ACH' : 'HMN';
      if (!a[site]) a[site] = { doctor: p.doctor };
      else {
        const other = site === 'HMN' ? 'ACH' : 'HMN';
        if (!a[other]) a[other] = { doctor: p.doctor };
      }
    });
    delete a.full24;
    changed = true;
  });
  if (changed) saveState();
}
migrateFull24();

function objectivesRemaining(d) {
  const picks = picksByDoctor(d.name);
  const c = { ACH: { sem:0, we:0 }, HMN: { sem:0, we:0 } };
  let totalW = 0;
  picks.forEach(p => {
    const b = objectiveBucket(p.date);
    if (c[p.site]) c[p.site][b] += p.weight;
    totalW += p.weight;
  });
  return {
    ACH: { sem: d.ACH.sem - c.ACH.sem, we: d.ACH.we - c.ACH.we },
    HMN: { sem: d.HMN.sem - c.HMN.sem, we: d.HMN.we - c.HMN.we },
    total: totalObjective(d) - totalW,
  };
}

// ============================================================
// Ordre des choisisseurs : tour de groupe contrôlé par l'admin
// ============================================================
function pickerAt(tourCursor) {
  const N = state.doctors.length;
  if (!N || tourCursor < 0 || tourCursor >= N) return null;
  const idx = ((state.tourStartIdx + tourCursor * state.tourDirection) % N + N) % N;
  return state.doctors[idx];
}
function lastPickerOfTour() {
  return pickerAt(state.doctors.length - 1);
}

// ============================================================
// Tour & quota du picker courant
// ============================================================
function currentTurnPicks(name, tour) {
  // Picks chronologiques de ce médecin classés en tours via remplissage de quota.
  // On reconstitue depuis history (assignments) en triant par ts.
  const events = state.history
    .filter(h => h.action === 'assign' && h.doctor === name)
    .sort((a,b) => a.ts - b.ts);
  let curTour = 1;
  let consumed = {};
  let quota = tourQuota(findDoctor(name), curTour);
  const turnsUntil = []; // picks made in tour `tour`
  for (const e of events) {
    if (curTour === tour) turnsUntil.push(e);
    const t = tourSlotType(e.date);
    let key = (quota[t] && (consumed[t]||0) < quota[t]) ? t :
              (quota.libre && (consumed.libre||0) < quota.libre ? 'libre' : null);
    if (!key) {
      // tour rempli, passer au suivant
      curTour++;
      consumed = {};
      quota = tourQuota(findDoctor(name), curTour);
      key = (quota[t] && (consumed[t]||0) < quota[t]) ? t :
            (quota.libre && (consumed.libre||0) < quota.libre ? 'libre' : null);
    }
    if (key) consumed[key] = (consumed[key]||0) + 1;
  }
  if (curTour === tour) {
    return { picks: turnsUntil, consumed, quota };
  }
  // Si le picker a déjà dépassé le tour demandé, retourner quota vide
  return { picks: turnsUntil, consumed: {}, quota };
}

function tourComplete(name, tour) {
  const { consumed, quota } = currentTurnPicks(name, tour);
  return Object.keys(quota).every(k => (consumed[k] || 0) >= quota[k]);
}

// ============================================================
// Curseur courant
// ============================================================
function currentPickerInfo() {
  if (state.forcedNextPicker) {
    const d = findDoctor(state.forcedNextPicker);
    if (d) return { name: d.name, tour: state.currentTour, forced: true, cursor: state.pickerCursor };
  }
  const N = state.doctors.length;
  let c = state.pickerCursor;
  while (c < N) {
    const d = pickerAt(c);
    if (!d) { c++; continue; }
    if (objectivesRemaining(d).total <= 0) { c++; continue; } // doctor a fini ses objectifs
    return { name: d.name, tour: state.currentTour, cursor: c, forced: false };
  }
  return null; // tout le monde a joué dans ce tour → admin doit cliquer "Tour suivant"
}

function nextPickerInfo() {
  const N = state.doctors.length;
  const cur = currentPickerInfo();
  let start = (cur ? cur.cursor : state.pickerCursor) + 1;
  while (start < N) {
    const d = pickerAt(start);
    if (d && objectivesRemaining(d).total > 0) {
      return { name: d.name, tour: state.currentTour };
    }
    start++;
  }
  // Tour terminé → suivant = première personne du tour suivant
  // (= la dernière personne du tour actuel, back-to-back, en sens inverse)
  const last = lastPickerOfTour();
  if (last && objectivesRemaining(last).total > 0) {
    return { name: last.name, tour: state.currentTour + 1, isNextTour: true };
  }
  return null;
}

// Recale le curseur sur la position de `name` dans le tour de groupe courant.
// Garde le tour inchangé (pas de saut au prochain tour automatique).
// Reconstitue les slots NETS choisis par `name` pendant le tour de GROUPE
// courant, en rejouant l'historique tagué par tour (assign = ajoute,
// clear/réattribution = retire). Sert à repositionner le suivi de tour quand
// l'admin re-sélectionne un choisisseur, SANS jamais remettre sa progression
// à zéro (et donc sans lui laisser re-choisir au-delà de son quota).
function currentTurnSlotsFor(name) {
  const held = new Set();
  const evs = state.history
    .filter(h => h.tour === state.currentTour && h.date && h.slot)
    .sort((a, b) => a.ts - b.ts);
  for (const e of evs) {
    const key = e.half ? `${e.date}:${e.slot}:${e.half}` : `${e.date}:${e.slot}`;
    if (e.action === 'assign' && e.doctor === name) held.add(key);
    else if (e.action === 'assign') held.delete(key);              // réattribué à un autre
    else if (e.action === 'clear' && e.prevDoctor === name) held.delete(key);
  }
  return [...held];
}

function setCurrentPickerManually(name) {
  if (!name) return;
  snapshotForUndo();
  const N = state.doctors.length;
  const docIdx = state.doctors.findIndex(d => d.name === name);
  if (docIdx < 0) return;
  // Position dans le tour : (docIdx - tourStartIdx) * direction mod N
  const cursor = ((docIdx - state.tourStartIdx) * state.tourDirection % N + N) % N;
  // Retour EN ARRIÈRE (quelqu'un veut corriger son choix) → on mémorise le front
  // du groupe pour y revenir automatiquement une fois la correction faite.
  if (cursor < state.pickerCursor) {
    state.returnCursor = Math.max(state.pickerCursor, state.returnCursor || 0);
  } else if (state.returnCursor != null && cursor >= state.returnCursor) {
    state.returnCursor = null; // on a rejoint/dépassé le front → plus rien à retrouver
  }
  state.pickerCursor = cursor;
  // Restaure la progression de tour DÉJÀ faite par ce médecin dans le tour
  // courant (au lieu de la remettre à zéro).
  state.currentTurnSlots = currentTurnSlotsFor(name);
  state.currentTurnPickCount = state.currentTurnSlots.length;
  state.forcedNextPicker = null;
  syncSession();
  render();
}

function quotaSum(d, tour) {
  return Object.values(tourQuota(d, tour)).reduce((a,b)=>a+b, 0);
}

// ============================================================
// Helpers : adjacence + suggestion de dates pour le picker courant
// ============================================================
function dateAdd(dateStr, n) {
  const d = parseYMD(dateStr);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function siteHasDoctor(s, name) {
  if (!s) return false;
  return s.split ? (s.jour === name || s.nuit === name) : (s.doctor === name);
}
function pickerOnDay(name, dateStr) {
  const a = state.assignments[dateStr];
  if (!a) return false;
  return siteHasDoctor(a.HMN, name) || siteHasDoctor(a.ACH, name);
}
function hasGardeOnOrNearby(name, dateStr) {
  return pickerOnDay(name, dateStr) ||
         pickerOnDay(name, dateAdd(dateStr, -1)) ||
         pickerOnDay(name, dateAdd(dateStr, 1));
}

// Reconstruit le quota déjà consommé dans le tour courant (par les picks listés
// dans state.currentTurnSlots), pour savoir quels types restent à faire.
function getRemainingTurnQuota(name) {
  const d = findDoctor(name);
  if (!d) return { quota: {}, remaining: {} };
  const quota = tourQuota(d, state.currentTour);
  const consumed = {};
  for (const slot of (state.currentTurnSlots || [])) {
    const [date] = slot.split(':');
    const t = tourSlotType(date);
    let key = (quota[t] && (consumed[t] || 0) < quota[t]) ? t :
              (quota.libre && (consumed.libre || 0) < quota.libre ? 'libre' : null);
    if (key) consumed[key] = (consumed[key] || 0) + 1;
  }
  const remaining = {};
  for (const k of Object.keys(quota)) remaining[k] = quota[k] - (consumed[k] || 0);
  return { quota, remaining };
}

// Une date est "suggérée" pour le picker courant si :
// - au moins un site éligible et LIBRE ce jour-là où il a encore un objectif
// - le quota du tour courant a encore une place compatible avec ce type de jour
// - le picker n'est pas déjà de garde ce jour-là, la veille ou le lendemain
function isDateSuggestedFor(name, dateStr) {
  const d = findDoctor(name);
  if (!d) return false;
  // Indispo perso de ce médecin → ne jamais suggérer
  const v = (state.allVoeux[name] || {})[dateStr];
  if (v === 'blocked') return false;
  const a = state.assignments[dateStr] || {};
  const elig = eligibleSites(d);
  const r = objectivesRemaining(d);
  const bucket = objectiveBucket(dateStr);
  let sitesOK = elig.filter(s => !a[s] && r[s][bucket] > 0);
  // Si le médecin a un vœu spécifique HMN ou ACH, ne pas filtrer plus
  // (le vœu n'EXCLUT pas l'autre site, c'est juste une préférence visuelle)
  if (sitesOK.length === 0) return false;
  const { remaining } = getRemainingTurnQuota(name);
  const t = tourSlotType(dateStr);
  const fits = (remaining[t] || 0) > 0 || (remaining.libre || 0) > 0;
  if (!fits) return false;
  if (hasGardeOnOrNearby(name, dateStr)) return false;
  return true;
}

function advanceCursorIfNeeded() {
  if (state.forcedNextPicker) return;
  const N = state.doctors.length;
  let safety = N + 5;
  while (state.pickerCursor < N && safety-- > 0) {
    const d = pickerAt(state.pickerCursor);
    if (!d) { state.pickerCursor++; continue; }
    const objDone = objectivesRemaining(d).total <= 0;
    const q = quotaSum(d, state.currentTour);
    // Avance si le tour est rempli OU si tous les objectifs totaux sont atteints
    if ((state.currentTurnPickCount || 0) >= q || objDone) {
      let nextCursor = state.pickerCursor + 1;
      // Après une correction en arrière, sauter directement au front mémorisé
      // (les personnes intermédiaires ont déjà fait leur tour).
      if (state.returnCursor != null && nextCursor < state.returnCursor) nextCursor = state.returnCursor;
      if (state.returnCursor != null && nextCursor >= state.returnCursor) state.returnCursor = null;
      state.pickerCursor = nextCursor;
      state.currentTurnPickCount = 0;
      state.currentTurnSlots = [];
      continue;
    }
    // Ce picker doit encore choisir → caler le suivi sur SA progression réelle
    // du tour (utile en revenant sur le front après une correction). Si
    // l'historique est vide (ex. après un reload), on garde le compteur courant.
    const slots = currentTurnSlotsFor(d.name);
    if (slots.length) { state.currentTurnSlots = slots; state.currentTurnPickCount = slots.length; }
    break;
  }
}

// Avancement explicite du tour de groupe (bouton admin)
function advanceTour() {
  if (!isAdmin()) return alert('Admin uniquement');
  snapshotForUndo();
  const N = state.doctors.length;
  // Le 1er picker du nouveau tour = la dernière personne du tour actuel (back-to-back)
  // Cette personne est à l'index (tourStartIdx + (N-1)*direction) % N
  const lastIdx = ((state.tourStartIdx + (N - 1) * state.tourDirection) % N + N) % N;
  state.tourStartIdx = lastIdx;
  state.tourDirection = -state.tourDirection;
  state.currentTour += 1;
  state.pickerCursor = 0;
  state.currentTurnPickCount = 0;
  state.currentTurnSlots = [];
  state.returnCursor = null;
  state.forcedNextPicker = null;
  syncSession();
  render();
}

// ============================================================
// Assignations
// ============================================================
// Undo via snapshots : on garde state avant chaque modification
const UNDO_STACK = [];
const UNDO_MAX = 50;
function snapshotForUndo() {
  UNDO_STACK.push(JSON.stringify({
    assignments: state.assignments,
    history: state.history,
    pickerCursor: state.pickerCursor,
    currentTurnPickCount: state.currentTurnPickCount || 0,
    currentTurnSlots: state.currentTurnSlots || [],
    returnCursor: state.returnCursor,
    forcedNextPicker: state.forcedNextPicker,
  }));
  if (UNDO_STACK.length > UNDO_MAX) UNDO_STACK.shift();
}

// half : undefined/'full' = garde entière ; 'jour' / 'nuit' = demi-garde (24h divisé)
function setAssignment(date, site, doctorName, half) {
  snapshotForUndo();
  const curBefore = currentPickerInfo();

  if (!state.assignments[date]) state.assignments[date] = {};
  const a = state.assignments[date];
  const isHalf = (half === 'jour' || half === 'nuit');

  let prevDoctor = null;
  if (isHalf) {
    if (!a[site] || !a[site].split) a[site] = { split: true, jour: null, nuit: null };
    prevDoctor = a[site][half] || null;
    a[site][half] = doctorName || null;
    if (!a[site].jour && !a[site].nuit) delete a[site];
  } else {
    const prev = a[site] || null;
    prevDoctor = (prev && !prev.split) ? prev.doctor : null;
    if (doctorName) a[site] = { doctor: doctorName };
    else delete a[site];
  }

  if (Object.keys(a).length === 0) delete state.assignments[date];

  state.history.push({
    ts: Date.now(),
    action: doctorName ? 'assign' : 'clear',
    date, slot: site, half: half || null,
    doctor: doctorName || prevDoctor || null,
    prevDoctor,
    tour: state.currentTour,   // tour de groupe où ce choix a été fait
  });

  // Tracker les picks du tour en cours (chaque demi-garde = un pick distinct)
  if (curBefore && !curBefore.forced) {
    state.currentTurnSlots = state.currentTurnSlots || [];
    const slotKey2 = isHalf ? `${date}:${site}:${half}` : `${date}:${site}`;
    if (doctorName && doctorName === curBefore.name) {
      if (!state.currentTurnSlots.includes(slotKey2)) state.currentTurnSlots.push(slotKey2);
    } else if (!doctorName && prevDoctor === curBefore.name) {
      const i = state.currentTurnSlots.indexOf(slotKey2);
      if (i >= 0) state.currentTurnSlots.splice(i, 1);
    }
    state.currentTurnPickCount = state.currentTurnSlots.length;
  }

  if (state.forcedNextPicker && doctorName === state.forcedNextPicker) {
    state.forcedNextPicker = null;
  }
  advanceCursorIfNeeded();
  syncSite(date, site);
  syncSession();
  render();
}

// Diviser un site 24h en 2 demi-gardes (jour/nuit)
function divideSite(date, site) {
  if (!isAdmin()) return alert('Admin uniquement');
  if (!is24h(date)) return;
  if (!state.assignments[date]) state.assignments[date] = {};
  const a = state.assignments[date];
  const prev = a[site];
  // si une garde entière existait, on la repositionne sur la demi "jour"
  const jour = (prev && !prev.split) ? prev.doctor : (prev && prev.split ? prev.jour : null);
  const nuit = (prev && prev.split) ? prev.nuit : null;
  a[site] = { split: true, jour: jour || null, nuit: nuit || null };
  if (!a[site].jour && !a[site].nuit) {
    // rien à persister encore : on garde l'état divisé localement
  } else {
    syncSite(date, site);
  }
  render();
}

// Re-fusionner un site divisé en garde entière (vide les demi-gardes)
function mergeSite(date, site) {
  if (!isAdmin()) return alert('Admin uniquement');
  const a = state.assignments[date];
  if (!a || !a[site] || !a[site].split) return;
  const had = a[site].jour || a[site].nuit;
  if (had && !confirm('Re-fusionner en une seule garde 24h ? Les deux demi-gardes seront vidées.')) return;
  snapshotForUndo();
  delete a[site];
  if (Object.keys(a).length === 0) delete state.assignments[date];
  syncSite(date, site);
  syncSession();
  render();
}

// ============================================================
// UI : tabs
// ============================================================
document.querySelectorAll('.tab').forEach(t => {
  if (!t.dataset.tab) return;   // liens/boutons sans onglet (Mode auto, déconnexion)
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.tab).classList.add('active');
    render();
  };
});

// ============================================================
// Render — calendar
// ============================================================
function renderCalendar(containerId, mode /* 'planning' | 'voeux' */) {
  const c = document.getElementById(containerId);
  c.innerHTML = '';
  const months = [];
  // découper par mois
  let curMonthKey = null, curMonthDays = [];
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    const dt = parseYMD(d);
    const key = dt.getFullYear() + '-' + dt.getMonth();
    if (key !== curMonthKey) {
      if (curMonthKey) months.push({ key: curMonthKey, days: curMonthDays });
      curMonthKey = key;
      curMonthDays = [];
    }
    curMonthDays.push(d);
  }
  if (curMonthKey) months.push({ key: curMonthKey, days: curMonthDays });

  months.forEach(m => {
    const monthEl = document.createElement('div');
    monthEl.className = 'month';
    const firstDate = parseYMD(m.days[0]);
    const h2 = document.createElement('h2');
    h2.textContent = MONTHS_FR[firstDate.getMonth()];
    monthEl.appendChild(h2);

    const contentEl = document.createElement('div');
    contentEl.className = 'month-content';

    const wkEl = document.createElement('div');
    wkEl.className = 'weekdays';
    WEEKDAYS_HEADER.forEach(w => { const s = document.createElement('div'); s.textContent = w; wkEl.appendChild(s); });
    contentEl.appendChild(wkEl);

    const daysEl = document.createElement('div');
    daysEl.className = 'days';
    const firstDow = (firstDate.getDay() + 6) % 7; // 0=lundi
    for (let i = 0; i < firstDow; i++) {
      const e = document.createElement('div'); e.className = 'day empty'; daysEl.appendChild(e);
    }
    m.days.forEach(d => daysEl.appendChild(buildDayCell(d, mode)));
    contentEl.appendChild(daysEl);

    monthEl.appendChild(contentEl);
    c.appendChild(monthEl);
  });
}

function buildDayCell(dateStr, mode) {
  const el = document.createElement('div');
  el.className = 'day';
  const t = dayType(dateStr);
  if (t === 'holiday') el.classList.add('holiday');
  else if (t === 'sunday' || t === 'saturday') el.classList.add('weekend');
  else if (t === 'friday') el.classList.add('friday');
  if (dateStr === ymd(new Date())) el.classList.add('today');

  // Migration: ancien 'wished' devient 'wishedBoth'
  if (state.voeux[dateStr] === 'wished') state.voeux[dateStr] = 'wishedBoth';

  const num = document.createElement('div');
  num.className = 'num';
  const d = parseYMD(dateStr);
  num.textContent = d.getDate() + (t === 'holiday' ? ' 🎉' : '');
  el.appendChild(num);

  const a = state.assignments[dateStr] || {};
  const slotEls = []; // pour brancher le clic en mode planning

  // Picker courant + sites éligibles (mode planning, sauf mode libre)
  let curName = null, curEligible = ['HMN','ACH'];
  if (mode === 'planning' && !state.neutralView) {
    const cur = currentPickerInfo();
    if (cur) {
      curName = cur.name;
      const cd = findDoctor(curName);
      if (cd) curEligible = eligibleSites(cd);
      if (curEligible.length === 0) curEligible = ['HMN','ACH']; // fallback
    }
  }

  // Vœux/indispos visibles : sur l'onglet Perso (toujours), ET sur le Planning
  // quand c'est MON tour. Sur le Planning on adapte le marqueur selon les slots
  // déjà pris : un vœu sur un site déjà pris disparaît, un vœu "les 2" se réduit
  // au site restant, une indispo disparaît si la journée est full.
  const showVoeux = (mode !== 'planning') || (curName === state.myName);
  let voeu = state.voeux[dateStr];
  if (showVoeux && voeu && mode === 'planning') {
    const HMNt = siteFull(a.HMN), ACHt = siteFull(a.ACH);
    if (voeu === 'wishedHMN' && HMNt) voeu = null;
    else if (voeu === 'wishedACH' && ACHt) voeu = null;
    else if (voeu === 'wishedBoth') {
      if (HMNt && ACHt) voeu = null;
      else if (HMNt) voeu = 'wishedACH';
      else if (ACHt) voeu = 'wishedHMN';
    }
    else if (voeu === 'blocked' && HMNt && ACHt) voeu = null;
  }
  if (showVoeux && voeu) el.dataset.voeu = voeu;

  const longShift = is24h(dateStr);
  const curPicker = (mode === 'planning' && curName) ? findDoctor(curName) : null;
  const curRem = curPicker ? objectivesRemaining(curPicker) : null;
  const bucket = objectiveBucket(dateStr);
  const canSplit = (mode === 'planning') && isAdmin();
  // Quota de tour restant : si le type de jour (we/vendredi/semaine) est déjà
  // fait pour ce tour, on grise (une demi-garde WE suffit à "faire" le WE du tour).
  const turnRem = (mode === 'planning' && curName && !state.forcedNextPicker) ? getRemainingTurnQuota(curName).remaining : null;
  const slotType = tourSlotType(dateStr);
  const tourTypeDone = !!(turnRem && (turnRem[slotType] || 0) <= 0 && (turnRem.libre || 0) <= 0);
  ['HMN','ACH'].forEach(site => {
    // Si le picker est mono-site, masquer l'autre site (mode planning seulement)
    if (mode === 'planning' && curName && !curEligible.includes(site)) return;
    const occ = a[site];
    const greyed = !!((curRem && curRem[site][bucket] <= 0) || tourTypeDone);

    // Jour 24h divisé (mode planning) → 2 demi-gardes Jour / Nuit
    if (mode === 'planning' && longShift && occ && occ.split) {
      ['jour','nuit'].forEach(half => {
        const who = occ[half];
        const s = document.createElement('div');
        s.className = 'slot ' + site + (who ? '' : ' empty-slot');
        if (who && who === curName) s.classList.add('mine-current');
        if (greyed) s.classList.add('slot-greyed');
        s.textContent = `${site} ${half === 'jour' ? 'Jour' : 'Nuit'}${who ? ' ' + shortName(who) : ''}`;
        s.dataset.slotKey = site; s.dataset.half = half;
        el.appendChild(s); slotEls.push(s);
      });
      if (canSplit) {
        const mb = document.createElement('button');
        mb.textContent = '↩ fusionner';
        mb.title = 'Re-fusionner en garde 24h';
        mb.style.cssText = 'font-size:9px;padding:1px 6px;margin:2px 0;cursor:pointer;border:1px solid #cbd5e1;border-radius:4px;background:#f1f5f9;color:#475569;align-self:flex-start';
        mb.onclick = (e) => { e.stopPropagation(); mergeSite(dateStr, site); };
        el.appendChild(mb);
      }
      return;
    }

    // Rendu plein (12h, ou 24h non divisé)
    const s = document.createElement('div');
    if (!siteIsEmpty(occ)) {
      const who = occ.split ? (occ.jour || occ.nuit) : occ.doctor;
      s.className = 'slot ' + site;
      if (mode !== 'planning' && siteHasDoctor(occ, state.myName)) s.classList.add('mine');
      if (siteHasDoctor(occ, curName)) s.classList.add('mine-current');
      s.textContent = `${site}${longShift?' 24h':''} ${shortName(who)}`;
    } else {
      s.className = 'slot empty-slot ' + site;
      s.textContent = `${site}${longShift?' 24h':''}`;
    }
    if (greyed) s.classList.add('slot-greyed');
    s.dataset.slotKey = site;
    slotEls.push(s);

    // Bouton « diviser en 2 » compact, sur la même ligne que le site (planning, 24h, admin)
    if (canSplit && longShift) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px';
      s.style.flex = '1';
      row.appendChild(s);
      const db = document.createElement('button');
      db.textContent = '✂ 2';
      db.title = 'Diviser en 2 (Jour / Nuit)';
      db.style.cssText = 'font-size:10px;padding:2px 6px;cursor:pointer;border:1px solid #cbd5e1;border-radius:4px;background:#f1f5f9;color:#475569;white-space:nowrap';
      db.onclick = (e) => { e.stopPropagation(); divideSite(dateStr, site); };
      row.appendChild(db);
      el.appendChild(row);
    } else {
      el.appendChild(s);
    }
  });

  // "Mine" : au moins un créneau pris par le picker courant (planning) ou par moi (perso)
  const refDoctor = (mode === 'planning') ? curName : state.myName;
  const hasMine = refDoctor && ['HMN','ACH'].some(site => siteHasDoctor(a[site], refDoctor));

  if (curName) {
    const allTaken = curEligible.every(site => siteFull(a[site]));
    if (allTaken) {
      el.classList.add('day-unavailable');
      if (hasMine) el.classList.add('day-unavailable-mine');
    } else if (hasMine) {
      el.classList.add('day-mine');
    }
  } else {
    if (siteFull(a.HMN) && siteFull(a.ACH)) {
      el.classList.add('day-unavailable');
      if (hasMine) el.classList.add('day-unavailable-mine');
    } else if (hasMine) {
      el.classList.add('day-mine');
    }
  }

  // Suggestion bleue : le picker courant pourrait prendre ce jour
  if (mode === 'planning' && curName && !el.classList.contains('day-mine')
      && !el.classList.contains('day-unavailable')
      && isDateSuggestedFor(curName, dateStr)) {
    el.classList.add('day-suggested');
  }

  if (mode === 'planning') {
    slotEls.forEach(s => {
      s.style.cursor = 'pointer';
      s.onclick = (e) => { e.stopPropagation(); openAssignModal(dateStr, s.dataset.slotKey, s.dataset.half || null); };
    });
    el.onclick = () => openAssignModal(dateStr, slotEls[0]?.dataset.slotKey, slotEls[0]?.dataset.half || null);
  } else {
    // Onglet perso :
    //  - clic sur la date / fond = toggle indispo
    //  - clic sur un slot HMN/ACH = toggle vœu sur ce site
    slotEls.forEach(s => {
      s.style.cursor = 'pointer';
      s.onclick = (e) => { e.stopPropagation(); toggleWishSite(dateStr, s.dataset.slotKey); };
    });
    el.onclick = () => toggleBlocked(dateStr);
  }
  return el;
}

function shortName(name) {
  if (!name) return '';
  const parts = name.split(' ');
  const last = parts[0];
  const first = parts.slice(1).join(' ');
  return last.slice(0,4) + '.' + (first ? first[0] : '');
}

// ============================================================
// Vœux
// ============================================================
function setMyVoeu(dateStr, next) {
  if (next) state.voeux[dateStr] = next; else delete state.voeux[dateStr];
  if (!state.allVoeux[state.myName]) state.allVoeux[state.myName] = {};
  if (next) state.allVoeux[state.myName][dateStr] = next;
  else delete state.allVoeux[state.myName][dateStr];
  syncVoeu(dateStr, next);
  render();
}

function toggleBlocked(dateStr) {
  const next = state.voeux[dateStr] === 'blocked' ? null : 'blocked';
  setMyVoeu(dateStr, next);
}
function toggleWishSite(dateStr, site) {
  const cur = state.voeux[dateStr];
  let hasHMN = (cur === 'wishedHMN' || cur === 'wishedBoth');
  let hasACH = (cur === 'wishedACH' || cur === 'wishedBoth');
  if (cur === 'blocked') { hasHMN = false; hasACH = false; }
  if (site === 'HMN') hasHMN = !hasHMN;
  else if (site === 'ACH') hasACH = !hasACH;
  let next = null;
  if (hasHMN && hasACH) next = 'wishedBoth';
  else if (hasHMN) next = 'wishedHMN';
  else if (hasACH) next = 'wishedACH';
  setMyVoeu(dateStr, next);
}

// ============================================================
// Render — picker info
// ============================================================
function renderPickerInfo() {
  const cur = currentPickerInfo();
  const next = nextPickerInfo();
  const nameSel = document.getElementById('current-name-select');
  const tourEl = document.getElementById('tour-info');
  const objEl = document.getElementById('obj-remaining');
  const nextEl = document.getElementById('next-picker');

  // (re)remplir la liste déroulante
  nameSel.innerHTML = '';
  state.doctors.forEach(d => {
    const o = document.createElement('option');
    o.value = d.name; o.textContent = d.name;
    nameSel.appendChild(o);
  });

  if (!cur) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = `Tour ${state.currentTour} terminé — clique "Tour suivant"`;
    nameSel.insertBefore(o, nameSel.firstChild);
    nameSel.value = '';
    tourEl.innerHTML = `<em>Toutes les personnes du tour ${state.currentTour} ont joué.</em>`;
    objEl.textContent = '';
    nextEl.innerHTML = '';
    return;
  }

  nameSel.value = cur.name;
  nameSel.onchange = () => setCurrentPickerManually(nameSel.value);

  const d = findDoctor(cur.name);

  if (cur.forced) {
    tourEl.innerHTML = '<em>Choix manuel — règles de tour ignorées</em>';
  } else {
    const quota = tourQuota(d, cur.tour);
    const totalNeeded = Object.values(quota).reduce((a,b)=>a+b, 0);
    const done = state.currentTurnPickCount || 0;
    const progress = `${cur.cursor + 1}/${state.doctors.length}`;
    let html = `<strong>Tour ${cur.tour}</strong> <span style="color:var(--ink-soft);font-size:11px">(${progress} ont joué)</span> — <span class="quota-item ${done>=totalNeeded?'done':'todo'}">${done}/${totalNeeded} choisies</span> `;
    const { remaining: turnRem } = getRemainingTurnQuota(cur.name);
    Object.keys(quota).forEach(k => {
      const label = ({libre:'libre', vendredi:'vendredi', we:'WE/f', semaine:'semaine'})[k] || k;
      const rem = (turnRem[k] != null) ? turnRem[k] : quota[k];
      const isDone = rem <= 0;
      html += `<span class="quota-item ${isDone ? 'done' : 'todo'}">${quota[k]} ${label}${isDone ? ' ✓' : ''}</span>`;
    });
    tourEl.innerHTML = html;
  }

  const r = objectivesRemaining(d);
  const totSem = r.ACH.sem + r.HMN.sem;
  const totWE  = r.ACH.we + r.HMN.we;
  objEl.innerHTML =
    `Objectifs : <strong>${fmtHalf(totSem)} sem / ${fmtHalf(totWE)} WE+f</strong><br>` +
    `<span style="opacity:0.8">ACH ${fmtHalf(r.ACH.sem)}/${fmtHalf(r.ACH.we)} · HMN ${fmtHalf(r.HMN.sem)}/${fmtHalf(r.HMN.we)}</span>`;

  if (!next) {
    nextEl.innerHTML = '<em>— fin de la séquence —</em>';
  } else {
    const nd = findDoctor(next.name);
    const nq = tourQuota(nd, next.tour);
    const labels = { libre: 'libre', vendredi: 'vendredi', we: 'WE/f', semaine: 'semaine' };
    let quotaHtml = '';
    Object.keys(nq).forEach(k => { quotaHtml += `<span class="quota-item">${nq[k]} ${labels[k]||k}</span>`; });
    const nr = objectivesRemaining(nd);
    const nTotSem = nr.ACH.sem + nr.HMN.sem;
    const nTotWE = nr.ACH.we + nr.HMN.we;
    nextEl.innerHTML =
      `<div class="next-line1"><span class="next-label">Suivant :</span> <span class="next-name">${next.name}</span></div>` +
      `<div class="next-line2"><span class="next-tour">Tour ${next.tour}</span> — <span class="next-quota">${quotaHtml}</span></div>` +
      `<div class="next-line3">Objectifs : <strong>${fmtHalf(nTotSem)} sem / ${fmtHalf(nTotWE)} WE+f</strong> &nbsp;(ACH ${fmtHalf(nr.ACH.sem)}/${fmtHalf(nr.ACH.we)} · HMN ${fmtHalf(nr.HMN.sem)}/${fmtHalf(nr.HMN.we)})</div>`;
  }
}

function renderMeBadge() {
  const el = $('me-badge');
  if (!el) return;
  const me = findDoctor(state.myName);
  if (!me) { el.innerHTML = ''; return; }
  const r = objectivesRemaining(me);
  const totSem = r.ACH.sem + r.HMN.sem;
  const totWE = r.ACH.we + r.HMN.we;
  el.innerHTML =
    `<div class="me-head"><span class="me-label">Mes objectifs restants</span><span class="me-name">${state.myName}</span></div>` +
    `<div class="me-metrics">` +
      `<span><strong>Semaine</strong> : ${fmtHalf(totSem)}</span>` +
      `<span><strong>WE + fériés</strong> : ${fmtHalf(totWE)}</span>` +
      `<span><strong>ACH</strong> ${fmtHalf(r.ACH.sem)}/${fmtHalf(r.ACH.we)}</span>` +
      `<span><strong>HMN</strong> ${fmtHalf(r.HMN.sem)}/${fmtHalf(r.HMN.we)}</span>` +
    `</div>`;
}

function renderMyNextTurn() {
  const el = $('my-next-turn');
  if (!el) return;
  const me = findDoctor(state.myName);
  if (!me) { el.innerHTML = ''; return; }
  const N = state.doctors.length;
  const myIdx = state.doctors.findIndex(d => d.name === state.myName);
  if (myIdx < 0) { el.innerHTML = ''; return; }
  // Position dans le tour courant : 0 = premier à choisir, N-1 = dernier
  const myPosInTour = ((myIdx - state.tourStartIdx) * state.tourDirection % N + N) % N;
  // Si déjà passé dans ce tour → next turn = tour suivant
  const myNextTour = myPosInTour < state.pickerCursor ? state.currentTour + 1 : state.currentTour;
  const isUpcoming = myPosInTour >= state.pickerCursor;
  const quota = tourQuota(me, myNextTour);
  const labels = { libre: 'date libre', vendredi: 'vendredi', we: 'WE/férié', semaine: 'semaine' };
  let qHtml = '';
  Object.keys(quota).forEach(k => { qHtml += `<span class="quota-item">${quota[k]} ${labels[k]||k}</span>`; });
  if (Object.keys(quota).length === 0) qHtml = '<span class="my-turn-empty">aucun objectif restant</span>';
  const intro = isUpcoming
    ? `À ton tour (tour ${myNextTour}) tu choisiras :`
    : `À ton prochain tour (tour ${myNextTour}) tu choisiras :`;
  el.innerHTML = `<div class="my-turn-label">${intro}</div><div class="my-turn-quota">${qHtml}</div>`;
}

function periodLabel() {
  const s = parseYMD(PERIOD_START), e = parseYMD(PERIOD_END);
  const sy = s.getFullYear(), ey = e.getFullYear();
  if (sy === ey) return `${MONTHS_FR[s.getMonth()]} – ${MONTHS_FR[e.getMonth()]} ${ey}`;
  return `${MONTHS_FR[s.getMonth()]} ${sy} – ${MONTHS_FR[e.getMonth()]} ${ey}`;
}

function render() {
  const pl = $('period-label');
  if (pl) pl.textContent = periodLabel();
  renderMeBadge();
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  if (activeTab === 'planning') {
    renderCalendar('planning-calendar', 'planning');
    renderPickerInfo();
  } else if (activeTab === 'voeux') {
    renderMyNextTurn();
    renderCalendar('voeux-calendar', 'voeux');
  } else if (activeTab === 'setup') {
    renderSetup();
  }
}

// ============================================================
// Modale d'assignation
// ============================================================
const modalState = { dateStr: null, slotKey: null, half: null };
const $ = id => document.getElementById(id);

function openAssignModal(dateStr, slotKey = null, half = null) {
  modalState.dateStr = dateStr;
  modalState.half = half || null;
  const halfLabel = half ? ` — ${slotKey} ${half === 'jour' ? 'Jour' : 'Nuit'} (½ 12h)` : '';
  $('modal-day').textContent = formatLong(dateStr) + halfLabel;
  const t = dayType(dateStr);
  const labelMap = { holiday:'Jour férié — garde 24h combinée HMN+ACH',
                     sunday:'Dimanche — garde 24h combinée HMN+ACH',
                     saturday:'Samedi — 1 garde par site (compte WE)',
                     friday:'Vendredi — 1 garde par site (compte semaine pour les objectifs)',
                     weekday:'Semaine — 1 garde par site' };
  $('modal-day-info').textContent = half ? 'Demi-garde de 12h (compte 0,5 dans les objectifs).' : (labelMap[t] || '');

  const a = state.assignments[dateStr] || {};
  const slotsEl = $('modal-slots');
  slotsEl.innerHTML = '';
  $('modal-split-wrapper').hidden = true;
  const longShift = is24h(dateStr);
  if (half) {
    // Édition d'une demi-garde précise → pas de bascule de site
    modalState.slotKey = slotKey;
    slotsEl.style.display = 'none';
  } else {
    slotsEl.style.display = '';
    ['HMN','ACH'].forEach(s => {
      const b = document.createElement('button');
      const occ = a[s];
      const disp = occ ? (occ.split ? 'divisé (J/N)' : occ.doctor) : 'libre';
      b.innerHTML = `${s}${longShift?' 24h':''}<span class="assignee">${disp}</span>`;
      b.onclick = () => selectSlot(b, s);
      slotsEl.appendChild(b);
    });
    modalState.slotKey = slotKey || pickDefaultSlot(dateStr);
    highlightSlot();
  }

  refreshDoctorDropdown();
  $('modal-backdrop').hidden = false;
}

function refreshDoctorDropdown() {
  const dsel = $('modal-doctor');
  dsel.innerHTML = '';
  const cur = currentPickerInfo();
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '— vider ce créneau —';
  dsel.appendChild(blank);
  state.doctors.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.name;
    const r = objectivesRemaining(d);
    let label = d.name;
    if (r.total <= 0) label += ' ✓ (objectifs ok)';
    else if (!slotEligible(d, modalState.slotKey)) label += ' ⚠ (pas d\'obj sur ce site)';
    opt.textContent = label;
    if (cur && d.name === cur.name) opt.textContent = '⬅ ' + opt.textContent;
    dsel.appendChild(opt);
  });
  const existing = readSlotDoctor(modalState.dateStr, modalState.slotKey, modalState.half);
  if (existing) dsel.value = existing;
  else if (cur) dsel.value = cur.name;
  else dsel.value = '';
}

function pickDefaultSlot(dateStr) {
  const a = state.assignments[dateStr] || {};
  if (!a.HMN) return 'HMN';
  if (!a.ACH) return 'ACH';
  return 'HMN';
}
function readSlotDoctor(dateStr, slotKey, half) {
  const a = state.assignments[dateStr] || {};
  const s = a[slotKey];
  if (!s) return null;
  if (half) return s.split ? (s[half] || null) : null;
  return s.split ? null : (s.doctor || null);
}
function selectSlot(buttonEl, slotKey) {
  modalState.slotKey = slotKey;
  modalState.half = null;
  highlightSlot();
  refreshDoctorDropdown();
}
function highlightSlot() {
  document.querySelectorAll('#modal-slots button').forEach((b, i) => {
    const key = i === 0 ? 'HMN' : 'ACH';
    b.classList.toggle('active', key === modalState.slotKey);
  });
}

// Raccourcis clavier dans la modale d'assignation : Entrée = Assigner, Backspace/Delete = Vider, Esc = Annuler
document.addEventListener('keydown', (e) => {
  const back = $('modal-backdrop');
  if (back.hidden) return;
  // ne pas intercepter si l'utilisateur tape dans un champ (sauf le select : Entrée doit valider)
  const tag = (e.target.tagName || '').toLowerCase();
  const isTypingField = tag === 'input' || tag === 'textarea';
  if (e.key === 'Enter' && !isTypingField) {
    e.preventDefault();
    $('modal-save').click();
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && !isTypingField) {
    e.preventDefault();
    $('modal-clear').click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    $('modal-cancel').click();
  }
});

$('modal-cancel').onclick = () => { $('modal-backdrop').hidden = true; };
$('modal-clear').onclick = () => {
  setAssignment(modalState.dateStr, modalState.slotKey, null, modalState.half);
  $('modal-backdrop').hidden = true;
};
$('modal-save').onclick = () => {
  const doc = $('modal-doctor').value;
  if (!doc) { setAssignment(modalState.dateStr, modalState.slotKey, null, modalState.half); }
  else {
    // Règle : pas de garde la veille / le jour même (autre site) / le lendemain
    // + le médecin n'a pas marqué le jour comme indispo
    const prev = dateAdd(modalState.dateStr, -1);
    const next = dateAdd(modalState.dateStr, 1);
    const conflicts = [];
    if (pickerOnDay(doc, prev)) conflicts.push('déjà de garde la veille (' + formatLong(prev) + ')');
    if (pickerOnDay(doc, next)) conflicts.push('déjà de garde le lendemain (' + formatLong(next) + ')');
    const a = state.assignments[modalState.dateStr] || {};
    const otherSite = modalState.slotKey === 'HMN' ? 'ACH' : 'HMN';
    if (siteHasDoctor(a[otherSite], doc)) conflicts.push('déjà de garde le même jour sur ' + otherSite);
    const docVoeu = (state.allVoeux[doc] || {})[modalState.dateStr];
    if (docVoeu === 'blocked') conflicts.push('a marqué cette date comme INDISPO 🚫');
    // Cette garde n'est-elle pas dans ses objectifs (site + sem/WE) ?
    const dr = objectivesRemaining(findDoctor(doc));
    const bucketLabel = objectiveBucket(modalState.dateStr) === 'we' ? 'WE/férié' : 'semaine';
    if (dr[modalState.slotKey][objectiveBucket(modalState.dateStr)] <= 0) {
      conflicts.push(`n'a pas (ou plus) d'objectif "${bucketLabel}" sur ${modalState.slotKey}`);
    }
    if (conflicts.length) {
      const msg = `${doc} ${conflicts.join(' ; ')}.\n\nForcer quand même ?`;
      if (!confirm(msg)) return;
    }
    setAssignment(modalState.dateStr, modalState.slotKey, doc, modalState.half);
  }
  $('modal-backdrop').hidden = true;
};

$('advance-tour-btn').onclick = () => {
  if (!confirm(`Passer au tour ${state.currentTour + 1} ? (la dernière personne du tour ${state.currentTour} enchaîne en sens inverse)`)) return;
  advanceTour();
};

// Bascule du mode libre (pas de coloration liée au picker courant)
$('neutral-toggle').onclick = () => {
  state.neutralView = !state.neutralView;
  document.body.classList.toggle('neutral', state.neutralView);
  $('neutral-toggle').textContent = state.neutralView ? '🎯 Reprendre le mode tour' : '👁 Mode libre';
  $('neutral-toggle').classList.toggle('primary-action', state.neutralView);
  render();
};

// Sauter le picker courant (objectifs non choisis = restent dus, à faire au prochain tour)
$('skip-picker-btn').onclick = () => {
  if (!isAdmin()) return alert('Admin uniquement');
  const cur = currentPickerInfo();
  if (!cur) return alert('Pas de picker courant.');
  const msg = `Passer le tour de ${cur.name} ?\n\n` +
    `Les objectifs non choisis ce tour-ci restent dus dans son total ; ` +
    `il/elle continuera les tours suivants normalement.`;
  if (!confirm(msg)) return;
  snapshotForUndo();
  let nextCursor = cur.cursor + 1;
  // Même logique de retour au front que l'avancement auto (si on skip pendant
  // une correction en arrière).
  if (state.returnCursor != null && nextCursor < state.returnCursor) nextCursor = state.returnCursor;
  if (state.returnCursor != null && nextCursor >= state.returnCursor) state.returnCursor = null;
  state.pickerCursor = nextCursor;
  state.currentTurnPickCount = 0;
  state.currentTurnSlots = [];
  state.forcedNextPicker = null;
  syncSession();
  render();
};

// Tirage au sort du premier choisisseur (admin uniquement)
$('draw-btn').onclick = () => {
  if (!isAdmin()) return alert('Admin uniquement');
  if (!confirm('Tirer au sort le premier choisisseur ? (le tour reprend à 1)')) return;
  const N = state.doctors.length;
  const idx = Math.floor(Math.random() * N);
  const drawn = state.doctors[idx];
  state.firstPicker = drawn.name;
  state.tourStartIdx = idx;
  state.tourDirection = 1;
  state.currentTour = 1;
  state.pickerCursor = 0;
  state.currentTurnPickCount = 0;
  state.currentTurnSlots = [];
  state.forcedNextPicker = null;
  syncSession();
  render();
  alert(`🎲 Premier à choisir : ${drawn.name}`);
};

// ============================================================
// Undo
// ============================================================
$('undo-btn').onclick = () => {
  if (!UNDO_STACK.length) { alert('Rien à annuler.'); return; }
  if (!isAdmin()) { alert('Seul un admin peut annuler.'); return; }
  const snap = JSON.parse(UNDO_STACK.pop());
  const oldAssign = state.assignments;
  state.assignments = snap.assignments;
  state.history = snap.history;
  state.pickerCursor = snap.pickerCursor;
  state.currentTurnPickCount = snap.currentTurnPickCount || 0;
  state.currentTurnSlots = snap.currentTurnSlots || [];
  state.returnCursor = snap.returnCursor ?? null;
  state.forcedNextPicker = snap.forcedNextPicker;
  // Diff & sync les assignments qui ont changé
  diffAndSyncAssignments(oldAssign, state.assignments);
  syncSession();
  render();
};

function diffAndSyncAssignments(oldA, newA) {
  const keys = new Set();
  Object.keys(oldA).forEach(d => Object.keys(oldA[d]).forEach(s => keys.add(d+':'+s)));
  Object.keys(newA).forEach(d => Object.keys(newA[d]).forEach(s => keys.add(d+':'+s)));
  for (const k of keys) {
    const [date, site] = k.split(':');
    const oldS = oldA[date] && oldA[date][site];
    const newS = newA[date] && newA[date][site];
    if (JSON.stringify(oldS || null) !== JSON.stringify(newS || null)) syncSite(date, site);
  }
}

// ============================================================
// Export / Import CSV
// ============================================================
function siteCsv(s) {
  if (!s) return '';
  if (s.split) return `Jour: ${s.jour || '—'} / Nuit: ${s.nuit || '—'}`;
  return s.doctor || '';
}
function exportCSV() {
  const rows = [['date','jour','duree','HMN','ACH']];
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    const a = state.assignments[d] || {};
    const wk = WEEKDAYS_FR[parseYMD(d).getDay()];
    const dur = is24h(d) ? '24h' : '12h';
    rows.push([d, wk, dur, siteCsv(a.HMN), siteCsv(a.ACH)]);
  }
  const csv = rows.map(r => r.map(c => `"${(c||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `garde-${PERIOD_START}-${PERIOD_END}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
$('export-btn').onclick = exportCSV;
$('export-btn-2').onclick = exportCSV;

// ============================================================
// Export Excel (.xlsx) — feuille « Gardes » au format du document de
// référence. Le générateur générique vit dans xlsx.js (partagé avec l'app
// auto) ; ici on ne fournit que la correspondance données → colonnes.
// Garde = garde entière ou demi-garde « nuit » ; Journée = demi-garde « jour ».
// ============================================================
function exportPlanningXlsx() {
  const dates = [...iterDates(PERIOD_START, PERIOD_END)];
  downloadGardesXlsx(dates, d => {
    const a = state.assignments[d] || {};
    const hmn = a.HMN, ach = a.ACH;
    return {
      gardeMondor:      hmn ? (hmn.split ? (hmn.nuit || '') : (hmn.doctor || '')) : '',
      journeeMondor:    (hmn && hmn.split) ? (hmn.jour || '') : '',
      gardeChenevier:   ach ? (ach.split ? (ach.nuit || '') : (ach.doctor || '')) : '',
      journeeChenevier: (ach && ach.split) ? (ach.jour || '') : '',
    };
  }, `planning-${PERIOD_START}-${PERIOD_END}.xlsx`);
}
const _xlsxBtn = $('export-xlsx-btn');
if (_xlsxBtn) _xlsxBtn.onclick = exportPlanningXlsx;

// ============================================================
// « Déclarer » = import à sens unique : copie mes voeux du Perso vers la copie
// auto (table auto_declarations). L'édition côté app auto reste dans cette copie
// et ne revient jamais ici. Avertit si la copie dépasse les limites.
// ============================================================
async function declareForAuto() {
  const me = window.currentUser;
  const statusEl = $('declare-auto-status');
  if (!me) { if (statusEl) statusEl.textContent = 'Connecte-toi d\'abord.'; return; }
  const myVoeux = state.voeux || {};
  const nInd = Object.values(myVoeux).filter(v => v === 'blocked').length;
  const nWish = Object.values(myVoeux).filter(v => v && v.startsWith('wished')).length;
  const maxI = state.maxIndispo ?? 30, maxW = state.maxWished ?? 5;
  // Import à sens unique : copie mon Perso → auto_declarations (n'altère pas l'inverse)
  if (statusEl) statusEl.textContent = 'Import vers le planning auto…';
  const del = await sb().from('auto_declarations').delete().eq('user_id', me.id);
  if (del.error) { if (statusEl) statusEl.textContent = '⚠ ' + del.error.message; return; }
  const rows = Object.entries(myVoeux).map(([date, voeu]) => ({ user_id: me.id, date, voeu }));
  if (rows.length) {
    const ins = await sb().from('auto_declarations').insert(rows);
    if (ins.error) { if (statusEl) statusEl.textContent = '⚠ ' + ins.error.message; return; }
  }
  if (nInd > maxI || nWish > maxW) {
    const parts = [];
    if (nInd > maxI) parts.push(`indispos : ${nInd} (max ${maxI})`);
    if (nWish > maxW) parts.push(`vœux : ${nWish} (max ${maxW})`);
    alert(`Importé vers le planning auto, mais tu dépasses la limite :\n— ${parts.join('\n— ')}\n\n` +
      `Va sur l'app auto (ta page médecin) pour retirer des dates jusqu'à rentrer dans les limites. ` +
      `(Ça n'enlèvera rien à ton Perso ici.)`);
    if (statusEl) statusEl.textContent = `⚠ Importé mais hors limites — ${parts.join(' ; ')}. Ajuste sur l'app auto.`;
  } else {
    if (statusEl) statusEl.textContent = `✓ Importé pour le planning auto : ${nInd} indispos, ${nWish} vœux.`;
  }
}
const declareBtn = $('declare-auto-btn');
if (declareBtn) declareBtn.onclick = declareForAuto;
const logoutTop = $('logout-btn-top');
if (logoutTop) logoutTop.onclick = () => { if (typeof logout === 'function') logout(); };

$('import-btn').onclick = () => $('import-file').click();
$('import-file').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const lines = r.result.split(/\r?\n/).filter(Boolean);
      const header = parseCSVLine(lines[0]);
      const idx = {
        date: header.indexOf('date'),
        HMN: header.indexOf('HMN'),
        ACH: header.indexOf('ACH'),
      };
      if (idx.date < 0) { alert('Colonne "date" introuvable'); return; }
      lines.slice(1).forEach(line => {
        const cells = parseCSVLine(line);
        const date = cells[idx.date];
        if (!date) return;
        if (idx.HMN >= 0 && cells[idx.HMN]) {
          state.assignments[date] = state.assignments[date] || {};
          state.assignments[date].HMN = { doctor: cells[idx.HMN] };
        }
        if (idx.ACH >= 0 && cells[idx.ACH]) {
          state.assignments[date] = state.assignments[date] || {};
          state.assignments[date].ACH = { doctor: cells[idx.ACH] };
        }
      });
      // Sync chaque assignation importée vers Supabase
      Object.entries(state.assignments).forEach(([d, slots]) => {
        if (slots.HMN) syncSite(d, 'HMN');
        if (slots.ACH) syncSite(d, 'ACH');
      });
      render();
      alert('Import terminé.');
    } catch(err) { alert('Erreur import : ' + err.message); }
  };
  r.readAsText(f);
};
function parseCSVLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ============================================================
// Reset
// ============================================================
$('reset-btn').onclick = async () => {
  if (!isAdmin()) { alert('Seul un admin peut réinitialiser.'); return; }
  if (!confirm('Réinitialiser tous les choix de garde ?\n\n— Le planning sera VIDÉ\n— Le tour repart à 1\n— Les vœux/indispos perso de chacun sont CONSERVÉS')) return;
  await sb().from('assignments').delete().neq('date', '1900-01-01');
  state.assignments = {};
  state.pickerCursor = 0;
  state.currentTour = 1;
  state.currentTurnPickCount = 0;
  state.currentTurnSlots = [];
  state.returnCursor = null;
  state.tourDirection = 1;
  // tourStartIdx reste sur le firstPicker actuel
  if (state.firstPicker) {
    const idx = state.doctors.findIndex(d => d.name === state.firstPicker);
    if (idx >= 0) state.tourStartIdx = idx;
  }
  state.forcedNextPicker = null;
  syncSession();
  render();
};

// ============================================================
// Setup tab
// ============================================================
function renderSetup() {
  const fp = $('first-picker');
  fp.innerHTML = '';
  state.doctors.forEach(d => {
    const o = document.createElement('option');
    o.value = d.name; o.textContent = d.name;
    fp.appendChild(o);
  });
  fp.value = state.firstPicker || state.doctors[0].name;
  fp.onchange = () => {
    if (!isAdmin()) return alert('Seul un admin peut changer le premier choisisseur.');
    state.firstPicker = fp.value;
    state.tourStartIdx = state.doctors.findIndex(d => d.name === fp.value);
    state.tourDirection = 1;
    state.currentTour = 1;
    state.pickerCursor = 0;
    state.currentTurnPickCount = 0;
    state.currentTurnSlots = [];
    syncSession(); render();
  };

  // Doctors table
  const t = $('doctors-table');
  const admin = isAdmin();
  let html = `<table><thead><tr>
    <th>Médecin</th>
    <th colspan="2">ACH (Chenevier)</th>
    <th colspan="2">HMN (Mondor)</th>
    <th>Catégorie</th><th></th>
  </tr><tr>
    <th></th><th>sem</th><th>WE+f</th><th>sem</th><th>WE+f</th><th></th><th></th>
  </tr></thead><tbody>`;
  state.doctors.forEach((d, i) => {
    html += `<tr>
      <td>${d.name}</td>
      <td><input type="number" min="0" data-i="${i}" data-k="ACH-sem" value="${d.ACH.sem}"></td>
      <td><input type="number" min="0" data-i="${i}" data-k="ACH-we"  value="${d.ACH.we}"></td>
      <td><input type="number" min="0" data-i="${i}" data-k="HMN-sem" value="${d.HMN.sem}"></td>
      <td><input type="number" min="0" data-i="${i}" data-k="HMN-we"  value="${d.HMN.we}"></td>
      <td>${({ge4:'≥4 WE',eq3:'3 WE',lt3:'<3 WE',no:'sans WE'})[category(d)]}</td>
      <td>${admin ? `<button class="danger" data-del-doctor="${d.name}" title="Retirer ce médecin" style="padding:2px 8px">✕</button>` : ''}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  if (admin) {
    html += `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:12px">
      <input id="add-doc-name" placeholder="Nom Prénom" style="padding:4px 6px;border:1px solid var(--border);border-radius:6px">
      ACH <input id="add-doc-achsem" type="number" min="0" value="0" title="sem" style="width:42px">/<input id="add-doc-achwe" type="number" min="0" value="0" title="WE" style="width:42px">
      HMN <input id="add-doc-hmnsem" type="number" min="0" value="0" title="sem" style="width:42px">/<input id="add-doc-hmnwe" type="number" min="0" value="0" title="WE" style="width:42px">
      <button id="add-doc-btn" class="primary-action" style="padding:5px 12px">+ Ajouter médecin</button>
    </div>`;
  }
  t.innerHTML = html;
  t.querySelectorAll('input[data-i]').forEach(inp => {
    inp.onchange = () => {
      if (!isAdmin()) { renderSetup(); return alert('Seul un admin peut modifier les objectifs.'); }
      const i = parseInt(inp.dataset.i, 10);
      const [site, k] = inp.dataset.k.split('-');
      state.doctors[i][site][k] = parseInt(inp.value, 10) || 0;
      syncDoctor(state.doctors[i]);
      renderSetup();
    };
  });
  t.querySelectorAll('button[data-del-doctor]').forEach(b => {
    b.onclick = () => removeDoctor(b.dataset.delDoctor);
  });
  const addDocBtn = $('add-doc-btn');
  if (addDocBtn) addDocBtn.onclick = addDoctor;

  renderPeriodSettings();
  renderHolidaysEditor();
  renderObjectivesCoherence();
  renderAdminsTable();
  renderAccountInfo();
}

function renderPeriodSettings() {
  const ps = $('period-start'), pe = $('period-end');
  if (ps) ps.value = PERIOD_START;
  if (pe) pe.value = PERIOD_END;
  const save = $('period-save');
  if (save) save.onclick = savePeriodDates;
  const np = $('new-period-btn');
  if (np) np.onclick = startNewPeriod;
}

async function savePeriodDates() {
  if (!isAdmin()) return alert('Admin uniquement');
  const start = $('period-start').value, end = $('period-end').value;
  const st = $('period-status');
  if (!start || !end || start > end) { if (st) st.textContent = 'Dates invalides (début ≤ fin requis).'; return; }
  const { error } = await sb().from('session_state').update({
    period_start: start, period_end: end, updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (error) { if (st) st.textContent = '⚠ ' + error.message; return; }
  PERIOD_START = start; PERIOD_END = end;
  // Recharger pour ne garder que les données du nouveau quadrimestre en mémoire
  // (les assignations/vœux/indispos hors fenêtre ne doivent plus être comptés).
  await loadAllFromSupabase();
  if (st) st.textContent = '✓ Période mise à jour.';
  render();
}

async function startNewPeriod() {
  if (!isAdmin()) return alert('Admin uniquement');
  const start = $('period-start').value, end = $('period-end').value;
  const st = $('period-status');
  if (!start || !end || start > end) { if (st) st.textContent = 'Dates invalides (début ≤ fin requis).'; return; }
  if (!confirm(`Démarrer une NOUVELLE période ${start} → ${end} ?\n\n` +
    `Cela VIDE : le planning (assignations), tous les vœux/indispos, toutes les déclarations auto, et remet le tour à 1.\n` +
    `Les objectifs des médecins et les préférences récurrentes sont CONSERVÉS.`)) return;
  if (st) st.textContent = 'Réinitialisation…';
  const e1 = await sb().from('assignments').delete().gte('date', '1900-01-01');
  const e2 = await sb().from('auto_declarations').delete().gte('date', '1900-01-01');
  const e3 = await sb().from('voeux').delete().gte('date', '1900-01-01');
  const delErr = e1.error || e2.error || e3.error;
  if (delErr) { if (st) st.textContent = '⚠ ' + delErr.message; return; }
  const { error } = await sb().from('session_state').update({
    period_start: start, period_end: end,
    picker_cursor: 0, current_tour: 1, current_turn_pick_count: 0, forced_next_picker: null,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (error) { if (st) st.textContent = '⚠ ' + error.message; return; }
  PERIOD_START = start; PERIOD_END = end;
  state.assignments = {}; state.voeux = {}; state.allVoeux = {};
  state.pickerCursor = 0; state.currentTour = 1; state.currentTurnPickCount = 0;
  state.currentTurnSlots = []; state.returnCursor = null; state.forcedNextPicker = null;
  if (st) st.textContent = '✓ Nouvelle période démarrée.';
  render();
}

async function addDoctor() {
  if (!isAdmin()) return alert('Admin uniquement');
  const name = $('add-doc-name').value.trim();
  if (!name) return alert('Nom requis.');
  if (state.doctors.some(d => d.name === name)) return alert('Ce médecin existe déjà.');
  const row = {
    name,
    ach_sem: parseInt($('add-doc-achsem').value, 10) || 0,
    ach_we:  parseInt($('add-doc-achwe').value, 10)  || 0,
    hmn_sem: parseInt($('add-doc-hmnsem').value, 10) || 0,
    hmn_we:  parseInt($('add-doc-hmnwe').value, 10)  || 0,
  };
  const { error } = await sb().from('doctors').insert(row);
  if (error) return alert('Ajout impossible : ' + error.message);
  state.doctors.push({ name, ACH: { sem: row.ach_sem, we: row.ach_we }, HMN: { sem: row.hmn_sem, we: row.hmn_we } });
  state.doctors.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  renderSetup();
}

async function removeDoctor(name) {
  if (!isAdmin()) return alert('Admin uniquement');
  if (!confirm(`Retirer ${name} de la liste ?\n\n(Impossible s'il a des gardes déjà assignées — vide-les d'abord. Son compte/vœux éventuels ne sont pas supprimés.)`)) return;
  const { error } = await sb().from('doctors').delete().eq('name', name);
  if (error) { alert('Suppression impossible : ' + error.message + '\n\nLe médecin a probablement des gardes assignées sur le planning.'); return; }
  state.doctors = state.doctors.filter(d => d.name !== name);
  renderSetup();
}

function renderHolidaysEditor() {
  const el = $('holidays-editor');
  if (!el) return;
  if (!isAdmin()) { el.innerHTML = '<em style="font-size:12px;color:var(--ink-soft)">Réservé aux admins.</em>'; return; }
  const list = (state.holidays || []).slice().sort();
  let html = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">';
  if (!list.length) html += '<span class="hint">Aucun jour férié pour l\'instant.</span>';
  list.forEach(h => {
    html += `<span style="display:inline-flex;align-items:center;gap:5px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:2px 4px 2px 8px;font-size:12px">${formatLong(h)} <button data-del="${h}" title="Retirer" style="border:none;background:none;cursor:pointer;color:#b91c1c;font-weight:700;font-size:14px">×</button></span>`;
  });
  html += '</div><label>Ajouter <input type="date" id="holiday-add-date"></label> <button id="holiday-add-btn">+ Ajouter</button>';
  el.innerHTML = html;
  el.querySelectorAll('button[data-del]').forEach(b => { b.onclick = () => removeHoliday(b.dataset.del); });
  const addBtn = $('holiday-add-btn');
  if (addBtn) addBtn.onclick = addHoliday;
}

async function addHoliday() {
  if (!isAdmin()) return alert('Admin uniquement');
  const d = $('holiday-add-date').value;
  if (!d) return;
  const { error } = await sb().from('holidays').upsert({ date: d });
  if (error) { alert(error.message); return; }
  if (!state.holidays.includes(d)) state.holidays.push(d);
  render();
}

async function removeHoliday(d) {
  if (!isAdmin()) return alert('Admin uniquement');
  const { error } = await sb().from('holidays').delete().eq('date', d);
  if (error) { alert(error.message); return; }
  state.holidays = state.holidays.filter(x => x !== d);
  render();
}

// Contrôle de cohérence : objectifs déclarés vs nombre réel de créneaux à couvrir
// (par site + bucket), pour repérer/ajuster les écarts AVANT de lancer les choix.
function renderObjectivesCoherence() {
  const el = $('remaining-objectives');
  if (!el) return;
  if (!isAdmin()) {
    el.innerHTML = '<em style="font-size:12px;color:var(--ink-soft)">Réservé aux admins.</em>';
    return;
  }
  // Nombre de créneaux par bucket (1 par site et par jour)
  let semSlots = 0, weSlots = 0;
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    if (isWE(d)) weSlots++; else semSlots++;
  }
  const obj = { ACH: { sem: 0, we: 0 }, HMN: { sem: 0, we: 0 } };
  state.doctors.forEach(d => {
    obj.ACH.sem += d.ACH.sem|0; obj.ACH.we += d.ACH.we|0;
    obj.HMN.sem += d.HMN.sem|0; obj.HMN.we += d.HMN.we|0;
  });
  const rows = [
    ['ACH semaine',     obj.ACH.sem, semSlots],
    ['ACH WE + fériés', obj.ACH.we,  weSlots],
    ['HMN semaine',     obj.HMN.sem, semSlots],
    ['HMN WE + fériés', obj.HMN.we,  weSlots],
  ];
  const diffCell = diff => {
    if (diff === 0) return `<span style="color:#15803d;font-weight:700">✓ exact</span>`;
    if (diff < 0)   return `<span style="color:#b91c1c;font-weight:700">⚠ manque ${-diff}</span>`;
    return `<span style="color:#92400e;font-weight:700">+${diff} en trop</span>`;
  };
  let totObj = 0, totSlot = 0, anyMismatch = false;
  let body = '';
  rows.forEach(([label, o, s]) => {
    totObj += o; totSlot += s;
    if (o !== s) anyMismatch = true;
    body += `<tr style="border-top:1px solid var(--border,#e2e8f0)">
      <td style="padding:4px 14px 4px 0">${label}</td>
      <td style="text-align:right;padding:4px 14px">${o}</td>
      <td style="text-align:right;padding:4px 14px">${s}</td>
      <td style="padding:4px 0">${diffCell(o - s)}</td>
    </tr>`;
  });
  const banner = anyMismatch
    ? `<p style="margin:0 0 8px;color:#b91c1c;font-weight:600">⚠ Des écarts existent : ajuste les objectifs ci-dessous avant de lancer les choix, sinon certains créneaux ne pourront pas être couverts (ou il y aura des objectifs en trop).</p>`
    : `<p style="margin:0 0 8px;color:#15803d;font-weight:600">✓ Objectifs et créneaux sont cohérents sur tous les sites.</p>`;
  el.innerHTML = `
    ${banner}
    <table style="border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;padding:4px 14px 4px 0">Type de garde</th>
        <th style="text-align:right;padding:4px 14px">Objectifs</th>
        <th style="text-align:right;padding:4px 14px">Créneaux</th>
        <th style="padding:4px 0">Écart</th>
      </tr></thead><tbody>
        ${body}
        <tr style="border-top:2px solid var(--border,#cbd5e1);font-weight:700">
          <td style="padding:4px 14px 4px 0">Total période</td>
          <td style="text-align:right;padding:4px 14px">${totObj}</td>
          <td style="text-align:right;padding:4px 14px">${totSlot}</td>
          <td style="padding:4px 0">${diffCell(totObj - totSlot)}</td>
        </tr>
      </tbody>
    </table>`;
}

function renderAccountInfo() {
  const el = $('account-info');
  if (!window.currentProfile) { el.textContent = 'Non connecté'; return; }
  const role = window.currentProfile.is_super_admin ? 'super admin'
             : window.currentProfile.is_admin ? 'admin'
             : 'utilisateur';
  el.innerHTML = `<strong>${state.myName}</strong> — ${window.currentUser?.email || ''} <em>(${role})</em>`;
}

async function renderAdminsTable() {
  const t = $('admins-table');
  if (!isAdmin()) {
    t.innerHTML = '<em style="font-size:12px;color:var(--ink-soft)">Réservé aux admins.</em>';
    return;
  }
  // Recharger les profiles depuis Supabase à chaque ouverture
  const { data: profiles } = await sb().from('profiles').select('*').order('doctor_name');
  state.allProfiles = profiles || [];
  let html = '<table><thead><tr><th>Médecin</th><th>Rôle</th><th></th></tr></thead><tbody>';
  state.allProfiles.forEach(p => {
    const role = p.is_super_admin ? 'super admin' : p.is_admin ? 'admin' : '—';
    let actions = '';
    if (!p.is_super_admin) {
      actions += p.is_admin
        ? `<button data-action="demote" data-uid="${p.user_id}">Retirer admin</button> `
        : `<button data-action="promote" data-uid="${p.user_id}">Promouvoir admin</button> `;
    }
    if (window.currentProfile.is_super_admin && !p.is_super_admin) {
      actions += `<button data-action="super" data-uid="${p.user_id}">→ super admin</button>`;
    }
    html += `<tr><td>${p.doctor_name}</td><td>${role}</td><td>${actions}</td></tr>`;
  });
  html += '</tbody></table>';
  t.innerHTML = html;
  t.querySelectorAll('button').forEach(btn => {
    btn.onclick = async () => {
      const uid = btn.dataset.uid;
      const action = btn.dataset.action;
      let upd = {};
      if (action === 'promote') upd = { is_admin: true };
      else if (action === 'demote') upd = { is_admin: false };
      else if (action === 'super') upd = { is_super_admin: true, is_admin: true };
      const { error } = await sb().from('profiles').update(upd).eq('user_id', uid);
      if (error) alert(error.message);
      renderAdminsTable();
    };
  });
}

function isAdmin() {
  return !!(window.currentProfile && (window.currentProfile.is_admin || window.currentProfile.is_super_admin));
}
function applyPermissions() {
  const admin = isAdmin();
  document.body.classList.toggle('read-only', !admin);
  // Onglet Réglages réservé aux admins
  const setupTab = document.querySelector('.tab[data-tab="setup"]');
  if (setupTab) {
    setupTab.style.display = admin ? '' : 'none';
    if (!admin && setupTab.classList.contains('active')) {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
      const pt = document.querySelector('.tab[data-tab="planning"]');
      const pv = document.getElementById('planning');
      if (pt) pt.classList.add('active');
      if (pv) pv.classList.add('active');
    }
  }
}

// ============================================================
// Init multi-utilisateur (appelé par auth.js après login)
// ============================================================
let _appInitialised = false;
async function initApp() {
  if (_appInitialised) return;
  _appInitialised = true;
  try {
    await loadAllFromSupabase();
    console.log('Loaded session state:', {
      firstPicker: state.firstPicker,
      pickerCursor: state.pickerCursor,
      currentTour: state.currentTour,
      tourStartIdx: state.tourStartIdx,
      tourDirection: state.tourDirection,
    });
  } catch (e) {
    console.error('loadAllFromSupabase failed', e);
    alert('Erreur de chargement Supabase : ' + (e.message || e));
  }
  if (!state.firstPicker) {
    state.firstPicker = state.doctors[0].name;
    state.tourStartIdx = 0;
    state.tourDirection = 1;
    state.currentTour = 1;
  }
  applyPermissions();
  setupRealtime();
  render();
}
window.initApp = initApp;

// ============================================================
// Realtime : sync entre clients
// ============================================================
function setupRealtime() {
  const ch = sb().channel('garde-room')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, payload => {
      if (payload.eventType === 'DELETE') {
        const r = payload.old;
        if (state.assignments[r.date]) {
          delete state.assignments[r.date][r.site];
          if (Object.keys(state.assignments[r.date]).length === 0) delete state.assignments[r.date];
        }
      } else {
        const r = payload.new;
        if (inPeriod(r.date)) {
          if (!state.assignments[r.date]) state.assignments[r.date] = {};
          state.assignments[r.date][r.site] = rowToSite(r);
        }
      }
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'session_state' }, payload => {
      if (payload.new) {
        state.firstPicker = payload.new.first_picker;
        state.pickerCursor = payload.new.picker_cursor;
        state.currentTurnPickCount = payload.new.current_turn_pick_count;
        // « forcer un choix » retiré : on n'applique plus forced_next_picker.
        state.currentTour = payload.new.current_tour ?? state.currentTour;
        state.tourStartIdx = payload.new.tour_start_idx ?? state.tourStartIdx;
        state.tourDirection = payload.new.tour_direction ?? state.tourDirection;
        if (payload.new.period_start) PERIOD_START = payload.new.period_start;
        if (payload.new.period_end)   PERIOD_END   = payload.new.period_end;
        if (payload.new.wished_per_gardes != null) { state.wishedPerGardes = payload.new.wished_per_gardes; computeMyMaxWished(); }
        if (payload.new.max_indispo != null) state.maxIndispo = payload.new.max_indispo;
        render();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'doctors' }, payload => {
      if (payload.new) {
        const d = state.doctors.find(x => x.name === payload.new.name);
        if (d) {
          d.ACH = { sem: payload.new.ach_sem, we: payload.new.ach_we };
          d.HMN = { sem: payload.new.hmn_sem, we: payload.new.hmn_we };
        }
        render();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'voeux' }, payload => {
      const row = payload.new || payload.old;
      const profByUid = Object.fromEntries((state.allProfiles||[]).map(p => [p.user_id, p.doctor_name]));
      const dn = profByUid[row.user_id];
      if (!dn) return;
      if (!state.allVoeux[dn]) state.allVoeux[dn] = {};
      if (payload.eventType === 'DELETE') delete state.allVoeux[dn][row.date];
      else if (inPeriod(row.date)) state.allVoeux[dn][row.date] = row.voeu;
      if (dn === state.myName) state.voeux = state.allVoeux[dn];
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async () => {
      // Quelqu'un a été promu/démuté ou s'est inscrit → re-fetch profils + ré-applique permissions
      const { data } = await sb().from('profiles').select('*');
      state.allProfiles = data || [];
      if (window.currentUser) {
        const my = state.allProfiles.find(p => p.user_id === window.currentUser.id);
        if (my) window.currentProfile = my;
      }
      applyPermissions();
      render();
    });
  ch.subscribe();
}
