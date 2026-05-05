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
    forcedNextPicker: null,
    allVoeux: {},             // doctorName -> { date -> voeu }, chargé depuis Supabase
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

  state.assignments = {};
  (assignments.data || []).forEach(row => {
    if (!state.assignments[row.date]) state.assignments[row.date] = {};
    state.assignments[row.date][row.site] = { doctor: row.doctor_name };
  });

  if (sess.data) {
    state.firstPicker = sess.data.first_picker;
    state.pickerCursor = sess.data.picker_cursor;
    state.currentTurnPickCount = sess.data.current_turn_pick_count;
    state.forcedNextPicker = sess.data.forced_next_picker;
    state.currentTour = sess.data.current_tour ?? 1;
    state.tourStartIdx = sess.data.tour_start_idx ?? 0;
    state.tourDirection = sess.data.tour_direction ?? 1;
  }

  state.allProfiles = profile.data || [];
  if (window.currentProfile) state.myName = window.currentProfile.doctor_name;

  // Construire allVoeux : { doctorName -> { date -> voeu } }
  const profByUid = Object.fromEntries(state.allProfiles.map(p => [p.user_id, p.doctor_name]));
  state.allVoeux = {};
  (voeux.data || []).forEach(row => {
    const dn = profByUid[row.user_id];
    if (!dn) return;
    if (!state.allVoeux[dn]) state.allVoeux[dn] = {};
    state.allVoeux[dn][row.date] = row.voeu;
  });
  state.voeux = state.allVoeux[state.myName] || {};
}

// ============================================================
// Sync vers Supabase (par table) — idempotent
// ============================================================
async function syncAssignment(date, site, doctorName) {
  if (doctorName) {
    return sb().from('assignments').upsert({
      date, site, doctor_name: doctorName,
      updated_at: new Date().toISOString(),
      updated_by: window.currentUser ? window.currentUser.id : null,
    });
  }
  return sb().from('assignments').delete().eq('date', date).eq('site', site);
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
  return sb().from('session_state').update({
    first_picker: state.firstPicker,
    picker_cursor: state.pickerCursor,
    current_turn_pick_count: state.currentTurnPickCount || 0,
    forced_next_picker: state.forcedNextPicker,
    current_tour: state.currentTour,
    tour_start_idx: state.tourStartIdx,
    tour_direction: state.tourDirection,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
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
  ge4: { 1: { libre: 1, vendredi: 1, we: 2 }, 2: { semaine: 1, we: 1 } },
  eq3: { 1: { libre: 1, vendredi: 1, we: 1 }, 2: { semaine: 1, we: 1 } },
  lt3: { 1: { libre: 1, vendredi: 1 },        2: { semaine: 1, we: 1 } },
  no:  { 1: { libre: 1, vendredi: 1 },        2: { semaine: 1 } },
};
function tourQuota(d, tour) {
  const rules = TOUR_RULES[category(d)];
  if (rules[tour]) return Object.assign({}, rules[tour]);
  return { libre: 1 };
}

// ============================================================
// Comptabilisation des picks par médecin
// ============================================================
function picksByDoctor(name) {
  const out = [];
  Object.entries(state.assignments).forEach(([date, slots]) => {
    if (slots.HMN && slots.HMN.doctor === name) out.push({ date, slot: 'HMN', site: 'HMN' });
    if (slots.ACH && slots.ACH.doctor === name) out.push({ date, slot: 'ACH', site: 'ACH' });
  });
  return out;
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
  picks.forEach(p => {
    const b = objectiveBucket(p.date);
    if (c[p.site]) c[p.site][b]++;
  });
  return {
    ACH: { sem: d.ACH.sem - c.ACH.sem, we: d.ACH.we - c.ACH.we },
    HMN: { sem: d.HMN.sem - c.HMN.sem, we: d.HMN.we - c.HMN.we },
    total: totalObjective(d) - picks.length,
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
function setCurrentPickerManually(name) {
  if (!name) return;
  snapshotForUndo();
  const N = state.doctors.length;
  const docIdx = state.doctors.findIndex(d => d.name === name);
  if (docIdx < 0) return;
  // Position dans le tour : (docIdx - tourStartIdx) * direction mod N
  const cursor = ((docIdx - state.tourStartIdx) * state.tourDirection % N + N) % N;
  state.pickerCursor = cursor;
  state.currentTurnPickCount = 0;
  state.currentTurnSlots = [];
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
function pickerOnDay(name, dateStr) {
  const a = state.assignments[dateStr];
  if (!a) return false;
  return (a.HMN && a.HMN.doctor === name) || (a.ACH && a.ACH.doctor === name);
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
  const cur = currentPickerInfo();
  if (!cur || cur.forced) return;
  const d = findDoctor(cur.name);
  const q = quotaSum(d, cur.tour);
  const objDone = objectivesRemaining(d).total <= 0;
  if ((state.currentTurnPickCount || 0) >= q || objDone) {
    state.pickerCursor = cur.cursor + 1; // s'arrêtera à N → tour terminé, attendra l'admin
    state.currentTurnPickCount = 0;
    state.currentTurnSlots = [];
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
    forcedNextPicker: state.forcedNextPicker,
  }));
  if (UNDO_STACK.length > UNDO_MAX) UNDO_STACK.shift();
}

function setAssignment(date, slotKey, doctorName, site) {
  snapshotForUndo();

  // Capturer le picker courant AVANT la modification (sinon currentPickerInfo
  // peut sauter au suivant si le pick complète le quota)
  const curBefore = currentPickerInfo();

  if (!state.assignments[date]) state.assignments[date] = {};
  const a = state.assignments[date];

  let prev = null;
  if (slotKey === 'HMN') { prev = a.HMN || null; if (doctorName) a.HMN = { doctor: doctorName }; else delete a.HMN; }
  else if (slotKey === 'ACH') { prev = a.ACH || null; if (doctorName) a.ACH = { doctor: doctorName }; else delete a.ACH; }

  if (Object.keys(a).length === 0) delete state.assignments[date];

  state.history.push({
    ts: Date.now(),
    action: doctorName ? 'assign' : 'clear',
    date, slot: slotKey,
    doctor: doctorName || (prev && prev.doctor) || null,
    prevDoctor: prev ? prev.doctor : null,
    site: site || (prev && prev.site) || null,
  });

  // Tracker les picks du tour en cours (pour pouvoir décrémenter au "vider")
  if (curBefore && !curBefore.forced) {
    state.currentTurnSlots = state.currentTurnSlots || [];
    const slotKey2 = `${date}:${slotKey}`;
    if (doctorName && doctorName === curBefore.name) {
      // ASSIGN par le picker courant : on ajoute si pas déjà compté
      if (!state.currentTurnSlots.includes(slotKey2)) state.currentTurnSlots.push(slotKey2);
    } else if (!doctorName && prev && prev.doctor === curBefore.name) {
      // CLEAR d'une garde du picker courant : décrémente uniquement si elle a été
      // prise pendant ce tour (sinon c'est une garde d'un tour précédent → on la
      // libère sans modifier le compteur du tour actuel)
      const i = state.currentTurnSlots.indexOf(slotKey2);
      if (i >= 0) state.currentTurnSlots.splice(i, 1);
    }
    state.currentTurnPickCount = state.currentTurnSlots.length;
  }

  // Le forcedNextPicker n'est valable que pour UN choix
  if (state.forcedNextPicker && doctorName === state.forcedNextPicker) {
    state.forcedNextPicker = null;
  }
  advanceCursorIfNeeded();
  // Sync vers Supabase
  syncAssignment(date, slotKey, doctorName);
  syncSession();
  render();
}

// ============================================================
// UI : tabs
// ============================================================
document.querySelectorAll('.tab').forEach(t => {
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
  // Vœux/indispos : visibles uniquement sur la page Perso
  if (mode !== 'planning' && state.voeux[dateStr]) el.dataset.voeu = state.voeux[dateStr];

  const num = document.createElement('div');
  num.className = 'num';
  const d = parseYMD(dateStr);
  num.textContent = d.getDate() + (t === 'holiday' ? ' 🎉' : '');
  el.appendChild(num);

  const a = state.assignments[dateStr] || {};
  const slotEls = []; // pour brancher le clic en mode planning

  // Picker courant + sites éligibles (mode planning uniquement)
  let curName = null, curEligible = ['HMN','ACH'];
  if (mode === 'planning') {
    const cur = currentPickerInfo();
    if (cur) {
      curName = cur.name;
      const cd = findDoctor(curName);
      if (cd) curEligible = eligibleSites(cd);
      if (curEligible.length === 0) curEligible = ['HMN','ACH']; // fallback
    }
  }

  const longShift = is24h(dateStr);
  ['HMN','ACH'].forEach(site => {
    // Si le picker est mono-site, masquer l'autre site (mode planning seulement)
    if (mode === 'planning' && curName && !curEligible.includes(site)) return;
    const s = document.createElement('div');
    const occ = a[site];
    if (occ) {
      s.className = 'slot ' + site;
      if (mode !== 'planning' && occ.doctor === state.myName) s.classList.add('mine');
      if (occ.doctor === curName) s.classList.add('mine-current');
      s.textContent = `${site}${longShift?' 24h':''} ${shortName(occ.doctor)}`;
    } else {
      s.className = 'slot empty-slot ' + site;
      s.textContent = `${site}${longShift?' 24h':''}`;
    }
    s.dataset.slotKey = site;
    el.appendChild(s); slotEls.push(s);
  });
  // "Mine" : au moins un slot pris par le picker courant (planning) ou par moi (perso)
  const refDoctor = (mode === 'planning') ? curName : state.myName;
  const hasMine = refDoctor && ['HMN','ACH'].some(s => a[s] && a[s].doctor === refDoctor);

  if (curName) {
    // Planning : indispo si tous les sites éligibles du picker sont pris
    const allTaken = curEligible.every(site => !!a[site]);
    if (allTaken) {
      el.classList.add('day-unavailable');
      if (hasMine) el.classList.add('day-unavailable-mine');
    } else if (hasMine) {
      el.classList.add('day-mine');
    }
  } else {
    // Perso : indispo si HMN ET ACH sont pris (peu importe par qui)
    if (a.HMN && a.ACH) {
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
      s.onclick = (e) => { e.stopPropagation(); openAssignModal(dateStr, s.dataset.slotKey); };
    });
    el.onclick = () => openAssignModal(dateStr, slotEls[0]?.dataset.slotKey);
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
  const overrideEl = document.getElementById('override-notice');

  overrideEl.classList.toggle('active', !!state.forcedNextPicker);

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
    Object.keys(quota).forEach(k => {
      const label = ({libre:'libre', vendredi:'vendredi', we:'WE/f', semaine:'semaine'})[k] || k;
      html += `<span class="quota-item">${quota[k]} ${label}</span>`;
    });
    tourEl.innerHTML = html;
  }

  const r = objectivesRemaining(d);
  const totSem = r.ACH.sem + r.HMN.sem;
  const totWE  = r.ACH.we + r.HMN.we;
  objEl.innerHTML =
    `Objectifs : <strong>${totSem} sem / ${totWE} WE+f</strong><br>` +
    `<span style="opacity:0.8">ACH ${r.ACH.sem}/${r.ACH.we} · HMN ${r.HMN.sem}/${r.HMN.we}</span>`;

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
      `<div class="next-line3">Objectifs : <strong>${nTotSem} sem / ${nTotWE} WE+f</strong> &nbsp;(ACH ${nr.ACH.sem}/${nr.ACH.we} · HMN ${nr.HMN.sem}/${nr.HMN.we})</div>`;
  }
}

function renderMeBadge() {
  const el = $('me-badge');
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  // Badge visible uniquement sur la page Perso
  if (activeTab !== 'voeux') { el.style.display = 'none'; return; }
  el.style.display = '';
  const me = findDoctor(state.myName);
  if (!me) { el.innerHTML = ''; return; }
  const r = objectivesRemaining(me);
  const totSem = r.ACH.sem + r.HMN.sem;
  const totWE = r.ACH.we + r.HMN.we;
  el.innerHTML =
    `<div class="me-name">${state.myName}</div>` +
    `<div class="me-totals">Jours de semaine : ${totSem} / Jours de WE (+ fériés) : ${totWE}</div>` +
    `<div class="me-detail">ACH : ${r.ACH.sem}/${r.ACH.we} - HMN : ${r.HMN.sem}/${r.HMN.we}</div>`;
}

function render() {
  renderMeBadge();
  const activeTab = document.querySelector('.tab.active').dataset.tab;
  if (activeTab === 'planning') {
    renderCalendar('planning-calendar', 'planning');
    renderPickerInfo();
  } else if (activeTab === 'voeux') {
    renderCalendar('voeux-calendar', 'voeux');
  } else if (activeTab === 'setup') {
    renderSetup();
  }
}

// ============================================================
// Modale d'assignation
// ============================================================
const modalState = { dateStr: null, slotKey: null };
const $ = id => document.getElementById(id);

function openAssignModal(dateStr, slotKey = null) {
  modalState.dateStr = dateStr;
  $('modal-day').textContent = formatLong(dateStr);
  const t = dayType(dateStr);
  const labelMap = { holiday:'Jour férié — garde 24h combinée HMN+ACH',
                     sunday:'Dimanche — garde 24h combinée HMN+ACH',
                     saturday:'Samedi — 1 garde par site (compte WE)',
                     friday:'Vendredi — 1 garde par site (compte semaine pour les objectifs)',
                     weekday:'Semaine — 1 garde par site' };
  $('modal-day-info').textContent = labelMap[t] || '';

  const a = state.assignments[dateStr] || {};
  const slotsEl = $('modal-slots');
  slotsEl.innerHTML = '';
  $('modal-split-wrapper').hidden = true; // plus de split
  const longShift = is24h(dateStr);
  ['HMN','ACH'].forEach(s => {
    const b = document.createElement('button');
    const occ = a[s];
    b.innerHTML = `${s}${longShift?' 24h':''}${occ?'<span class="assignee">'+occ.doctor+'</span>':'<span class="assignee">libre</span>'}`;
    b.onclick = () => selectSlot(b, s);
    slotsEl.appendChild(b);
  });

  // sélection initiale : slot demandé, ou premier libre, ou premier
  modalState.slotKey = slotKey || pickDefaultSlot(dateStr);
  highlightSlot();

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
    if (!slotEligible(d, modalState.slotKey)) return; // exclure les médecins sans objectifs sur ce site
    const opt = document.createElement('option');
    opt.value = d.name;
    const r = objectivesRemaining(d);
    opt.textContent = d.name + (r.total <= 0 ? ' ✓ (objectifs ok)' : '');
    if (cur && d.name === cur.name) opt.textContent = '⬅ ' + opt.textContent;
    dsel.appendChild(opt);
  });
  const existing = readSlotDoctor(modalState.dateStr, modalState.slotKey);
  if (existing) dsel.value = existing;
  else if (cur && slotEligible(findDoctor(cur.name) || {ACH:{sem:0,we:0},HMN:{sem:0,we:0}}, modalState.slotKey)) dsel.value = cur.name;
  else dsel.value = '';
}

function pickDefaultSlot(dateStr) {
  const a = state.assignments[dateStr] || {};
  if (!a.HMN) return 'HMN';
  if (!a.ACH) return 'ACH';
  return 'HMN';
}
function readSlotDoctor(dateStr, slotKey) {
  const a = state.assignments[dateStr] || {};
  if (slotKey === 'HMN') return a.HMN ? a.HMN.doctor : null;
  if (slotKey === 'ACH') return a.ACH ? a.ACH.doctor : null;
  return null;
}
function selectSlot(buttonEl, slotKey) {
  modalState.slotKey = slotKey;
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
  setAssignment(modalState.dateStr, modalState.slotKey, null, null);
  $('modal-backdrop').hidden = true;
};
$('modal-save').onclick = () => {
  const doc = $('modal-doctor').value;
  if (!doc) { setAssignment(modalState.dateStr, modalState.slotKey, null, null); }
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
    if (a[otherSite] && a[otherSite].doctor === doc) conflicts.push('déjà de garde le même jour sur ' + otherSite);
    const docVoeu = (state.allVoeux[doc] || {})[modalState.dateStr];
    if (docVoeu === 'blocked') conflicts.push('a marqué cette date comme INDISPO 🚫');
    if (conflicts.length) {
      const msg = `${doc} ${conflicts.join(' ; ')}.\n\nForcer quand même ?`;
      if (!confirm(msg)) return;
    }
    setAssignment(modalState.dateStr, modalState.slotKey, doc, null);
  }
  $('modal-backdrop').hidden = true;
};

// ============================================================
// Forcer un autre choisisseur
// ============================================================
$('force-picker-btn').onclick = () => {
  const sel = $('force-picker-select');
  sel.innerHTML = '';
  state.doctors.forEach(d => {
    const o = document.createElement('option');
    o.value = d.name; o.textContent = d.name;
    sel.appendChild(o);
  });
  $('modal-backdrop-picker').hidden = false;
};
$('force-cancel').onclick = () => { $('modal-backdrop-picker').hidden = true; };
$('force-save').onclick = () => {
  state.forcedNextPicker = $('force-picker-select').value;
  syncSession(); render();
  $('modal-backdrop-picker').hidden = true;
};
$('clear-override').onclick = () => {
  state.forcedNextPicker = null; syncSession(); render();
};
$('advance-tour-btn').onclick = () => {
  if (!confirm(`Passer au tour ${state.currentTour + 1} ? (la dernière personne du tour ${state.currentTour} enchaîne en sens inverse)`)) return;
  advanceTour();
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
    const oldDoc = oldA[date] && oldA[date][site] && oldA[date][site].doctor;
    const newDoc = newA[date] && newA[date][site] && newA[date][site].doctor;
    if (oldDoc !== newDoc) syncAssignment(date, site, newDoc || null);
  }
}

// ============================================================
// Export / Import CSV
// ============================================================
function exportCSV() {
  const rows = [['date','jour','duree','HMN','ACH']];
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    const a = state.assignments[d] || {};
    const wk = WEEKDAYS_FR[parseYMD(d).getDay()];
    const dur = is24h(d) ? '24h' : '12h';
    rows.push([d, wk, dur, a.HMN ? a.HMN.doctor : '', a.ACH ? a.ACH.doctor : '']);
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
        if (slots.HMN) syncAssignment(d, 'HMN', slots.HMN.doctor);
        if (slots.ACH) syncAssignment(d, 'ACH', slots.ACH.doctor);
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
  if (!confirm('Effacer TOUTES les assignations du planning ? (vœux et objectifs conservés)')) return;
  // Effacer côté Supabase
  await sb().from('assignments').delete().neq('date', '1900-01-01');
  state.assignments = {};
  state.pickerCursor = 0;
  state.currentTurnPickCount = 0;
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
  let html = `<table><thead><tr>
    <th>Médecin</th>
    <th colspan="2">ACH (Chenevier)</th>
    <th colspan="2">HMN (Mondor)</th>
    <th>Catégorie</th>
  </tr><tr>
    <th></th><th>sem</th><th>WE+f</th><th>sem</th><th>WE+f</th><th></th>
  </tr></thead><tbody>`;
  state.doctors.forEach((d, i) => {
    html += `<tr>
      <td>${d.name}</td>
      <td><input type="number" min="0" data-i="${i}" data-k="ACH-sem" value="${d.ACH.sem}"></td>
      <td><input type="number" min="0" data-i="${i}" data-k="ACH-we"  value="${d.ACH.we}"></td>
      <td><input type="number" min="0" data-i="${i}" data-k="HMN-sem" value="${d.HMN.sem}"></td>
      <td><input type="number" min="0" data-i="${i}" data-k="HMN-we"  value="${d.HMN.we}"></td>
      <td>${({ge4:'≥4 WE',eq3:'3 WE',lt3:'<3 WE',no:'sans WE'})[category(d)]}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  t.innerHTML = html;
  t.querySelectorAll('input').forEach(inp => {
    inp.onchange = () => {
      if (!isAdmin()) { renderSetup(); return alert('Seul un admin peut modifier les objectifs.'); }
      const i = parseInt(inp.dataset.i, 10);
      const [site, k] = inp.dataset.k.split('-');
      state.doctors[i][site][k] = parseInt(inp.value, 10) || 0;
      syncDoctor(state.doctors[i]);
      renderSetup();
    };
  });

  renderAdminsTable();
  renderAccountInfo();
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
  document.body.classList.toggle('read-only', !isAdmin());
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
  } catch (e) { console.error('loadAllFromSupabase failed', e); }
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
        if (!state.assignments[r.date]) state.assignments[r.date] = {};
        state.assignments[r.date][r.site] = { doctor: r.doctor_name };
      }
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'session_state' }, payload => {
      if (payload.new) {
        state.firstPicker = payload.new.first_picker;
        state.pickerCursor = payload.new.picker_cursor;
        state.currentTurnPickCount = payload.new.current_turn_pick_count;
        state.forcedNextPicker = payload.new.forced_next_picker;
        state.currentTour = payload.new.current_tour ?? state.currentTour;
        state.tourStartIdx = payload.new.tour_start_idx ?? state.tourStartIdx;
        state.tourDirection = payload.new.tour_direction ?? state.tourDirection;
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
      else state.allVoeux[dn][row.date] = row.voeu;
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
