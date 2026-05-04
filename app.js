'use strict';

// ============================================================
// État + persistence
// ============================================================
const STORAGE_KEY = 'garde-state-v1';

function defaultState() {
  return {
    assignments: {},          // dateStr -> { HMN: {doctor}, ACH: {doctor}, full24: [{doctor, site}] }
    history: [],              // [{ ts, action, date, slot, doctor, prevDoctor, byCurrentPicker }]
    voeux: {},                // dateStr -> 'wished' | 'blocked'
    myName: 'GUATTERI Laura',
    firstPicker: null,
    pickerCursor: 0,          // index dans la séquence snake
    currentTurnPickCount: 0,  // nb de picks faits par le picker courant pendant son tour
    forcedNextPicker: null,
    doctors: deepClone(DOCTORS),
    holidays: HOLIDAYS.slice(),
  };
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

let state = loadState();
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged = Object.assign(defaultState(), parsed);
      // Si la liste des médecins a changé en dur, garder ceux du localStorage
      if (!merged.doctors || merged.doctors.length === 0) merged.doctors = deepClone(DOCTORS);
      return merged;
    }
  } catch (e) { console.warn('loadState failed', e); }
  return defaultState();
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch(e) { alert('Sauvegarde impossible : ' + e.message); }
}

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
// Snake order
// ============================================================
function buildSnake(maxTours = 15) {
  const N = state.doctors.length;
  if (!N) return [];
  if (!state.firstPicker) state.firstPicker = state.doctors[0].name;
  let cursor = state.doctors.findIndex(d => d.name === state.firstPicker);
  if (cursor < 0) cursor = 0;
  const seq = [];
  let dir = 1;
  for (let tour = 1; tour <= maxTours; tour++) {
    for (let i = 0; i < N; i++) {
      seq.push({ name: state.doctors[cursor].name, tour });
      if (i < N - 1) cursor = (cursor + dir + N) % N;
    }
    dir = -dir;
  }
  return seq;
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
  const seq = buildSnake();
  if (state.forcedNextPicker) {
    const d = findDoctor(state.forcedNextPicker);
    if (d) return { name: d.name, tour: '?', forced: true, cursor: state.pickerCursor };
  }
  let cursor = state.pickerCursor;
  while (cursor < seq.length) {
    const e = seq[cursor];
    const d = findDoctor(e.name);
    if (!d) { cursor++; continue; }
    // sauter les docs qui ont fini leurs objectifs
    if (objectivesRemaining(d).total <= 0) { cursor++; continue; }
    // sauter aussi si tour déjà complet (ex: rattrapé hors-ordre par une assignation manuelle)
    if (tourComplete(e.name, e.tour)) { cursor++; continue; }
    return { name: e.name, tour: e.tour, cursor, forced: false };
  }
  return null;
}

function nextPickerInfo() {
  const seq = buildSnake();
  const cur = currentPickerInfo();
  let start = (cur ? cur.cursor : state.pickerCursor) + 1;
  while (start < seq.length) {
    const e = seq[start];
    const d = findDoctor(e.name);
    if (!d) { start++; continue; }
    if (objectivesRemaining(d).total <= 0) { start++; continue; }
    if (tourComplete(e.name, e.tour)) { start++; continue; }
    return { name: e.name, tour: e.tour };
  }
  return null;
}

// Recale le curseur sur la prochaine apparition de `name` dans la séquence snake
// dont le tour n'est pas encore complet. Sert à revenir en arrière sur une personne.
function setCurrentPickerManually(name) {
  if (!name) return;
  snapshotForUndo();
  const seq = buildSnake();
  let target = -1;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].name === name && !tourComplete(name, seq[i].tour)) { target = i; break; }
  }
  if (target < 0) {
    // tous ses tours sont complets — repositionner au tout 1er passage de cette personne quand même
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].name === name) { target = i; break; }
    }
  }
  if (target < 0) return;
  state.pickerCursor = target;
  state.currentTurnPickCount = 0;
  state.forcedNextPicker = null;
  saveState();
  render();
}

function quotaSum(d, tour) {
  return Object.values(tourQuota(d, tour)).reduce((a,b)=>a+b, 0);
}

function advanceCursorIfNeeded() {
  const cur = currentPickerInfo();
  if (!cur || cur.forced) return;
  const d = findDoctor(cur.name);
  const q = quotaSum(d, cur.tour);
  const objDone = objectivesRemaining(d).total <= 0;
  // Avance dès que le picker courant a fait son nombre de picks de tour, ou qu'il a atteint ses objectifs totaux
  if ((state.currentTurnPickCount || 0) >= q || objDone) {
    state.pickerCursor = cur.cursor + 1;
    state.currentTurnPickCount = 0;
  }
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

  // Compter le pick si fait par le picker courant (pour auto-avancer après N picks)
  if (doctorName && curBefore && !curBefore.forced && doctorName === curBefore.name) {
    state.currentTurnPickCount = (state.currentTurnPickCount || 0) + 1;
  }

  // Le forcedNextPicker n'est valable que pour UN choix
  if (state.forcedNextPicker && doctorName === state.forcedNextPicker) {
    state.forcedNextPicker = null;
  }
  advanceCursorIfNeeded();
  saveState();
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
    monthEl.innerHTML = `<h2>${MONTHS_FR[firstDate.getMonth()]} ${firstDate.getFullYear()}</h2>`;
    const wkEl = document.createElement('div');
    wkEl.className = 'weekdays';
    WEEKDAYS_HEADER.forEach(w => { const s = document.createElement('div'); s.textContent = w; wkEl.appendChild(s); });
    monthEl.appendChild(wkEl);

    const daysEl = document.createElement('div');
    daysEl.className = 'days';
    // padding initial (lundi=0 dans notre header) — JS getDay: 1=lundi, 0=dimanche
    const firstDow = (firstDate.getDay() + 6) % 7; // 0=lundi
    for (let i = 0; i < firstDow; i++) {
      const e = document.createElement('div'); e.className = 'day empty'; daysEl.appendChild(e);
    }
    m.days.forEach(d => {
      daysEl.appendChild(buildDayCell(d, mode));
    });
    monthEl.appendChild(daysEl);
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

  // Indispo : tous les sites éligibles du picker sont pris (planning seulement)
  if (curName) {
    const allTaken = curEligible.every(site => !!a[site]);
    if (allTaken) {
      el.classList.add('day-unavailable');
      if (hasMine) el.classList.add('day-unavailable-mine');
    } else if (hasMine) {
      el.classList.add('day-mine');
    }
  } else if (hasMine) {
    // Onglet perso
    el.classList.add('day-mine');
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
// Toggle indispo (clic sur la date) : neutre ↔ blocked
function toggleBlocked(dateStr) {
  if (state.voeux[dateStr] === 'blocked') delete state.voeux[dateStr];
  else state.voeux[dateStr] = 'blocked';
  saveState(); render();
}

// Toggle vœu sur un site (clic sur HMN ou ACH).
// Si indispo, l'efface au passage (mutuellement exclusif).
function toggleWishSite(dateStr, site) {
  const cur = state.voeux[dateStr];
  let hasHMN = (cur === 'wishedHMN' || cur === 'wishedBoth');
  let hasACH = (cur === 'wishedACH' || cur === 'wishedBoth');
  if (cur === 'blocked') { hasHMN = false; hasACH = false; }
  if (site === 'HMN') hasHMN = !hasHMN;
  else if (site === 'ACH') hasACH = !hasACH;
  if (hasHMN && hasACH) state.voeux[dateStr] = 'wishedBoth';
  else if (hasHMN) state.voeux[dateStr] = 'wishedHMN';
  else if (hasACH) state.voeux[dateStr] = 'wishedACH';
  else delete state.voeux[dateStr];
  saveState(); render();
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
    o.value = ''; o.textContent = '✓ Choix terminé';
    nameSel.insertBefore(o, nameSel.firstChild);
    nameSel.value = '';
    tourEl.textContent = '';
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
    let html = `<strong>Tour ${cur.tour}</strong> — <span class="quota-item ${done>=totalNeeded?'done':'todo'}">${done}/${totalNeeded} choisies</span> `;
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
    `Objectifs restants — <strong style="font-size:14px">${totSem} sem / ${totWE} WE+f</strong>` +
    ` <span style="color:var(--ink-soft)">(ACH ${r.ACH.sem}/${r.ACH.we} · HMN ${r.HMN.sem}/${r.HMN.we})</span>`;

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
      `<div class="next-line1"><span class="next-label">Suivant</span> : <span class="next-name">${next.name}</span></div>` +
      `<div class="next-line2"><span class="next-tour">Tour ${next.tour}</span> — <span class="next-quota">${quotaHtml}</span></div>` +
      `<div class="next-line3">Objectifs restants : ${nTotSem} sem / ${nTotWE} WE+f (ACH ${nr.ACH.sem}/${nr.ACH.we} · HMN ${nr.HMN.sem}/${nr.HMN.we})</div>`;
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
    `<div class="me-totals">Jours de semaine : ${totSem}</div>` +
    `<div class="me-totals">Jours de WE (+ fériés) : ${totWE}</div>` +
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
  else { setAssignment(modalState.dateStr, modalState.slotKey, doc, null); }
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
  saveState(); render();
  $('modal-backdrop-picker').hidden = true;
};
$('clear-override').onclick = () => {
  state.forcedNextPicker = null; saveState(); render();
};

// ============================================================
// Undo
// ============================================================
$('undo-btn').onclick = () => {
  if (!UNDO_STACK.length) { alert('Rien à annuler.'); return; }
  const snap = JSON.parse(UNDO_STACK.pop());
  state.assignments = snap.assignments;
  state.history = snap.history;
  state.pickerCursor = snap.pickerCursor;
  state.currentTurnPickCount = snap.currentTurnPickCount || 0;
  state.forcedNextPicker = snap.forcedNextPicker;
  saveState(); render();
};

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
      saveState(); render();
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
$('reset-btn').onclick = () => {
  if (!confirm('Tout effacer (assignations, vœux, historique) ? Les médecins/objectifs gardés.')) return;
  const docs = state.doctors;
  const my = state.myName;
  const fp = state.firstPicker;
  state = defaultState();
  state.doctors = docs;
  state.myName = my;
  state.firstPicker = fp;
  saveState(); render();
};

// ============================================================
// Setup tab
// ============================================================
function renderSetup() {
  const my = $('my-name');
  const fp = $('first-picker');
  [my, fp].forEach(sel => {
    sel.innerHTML = '';
    state.doctors.forEach(d => {
      const o = document.createElement('option');
      o.value = d.name; o.textContent = d.name;
      sel.appendChild(o);
    });
  });
  my.value = state.myName;
  fp.value = state.firstPicker || state.doctors[0].name;
  my.onchange = () => { state.myName = my.value; saveState(); };
  fp.onchange = () => { state.firstPicker = fp.value; state.pickerCursor = 0; saveState(); };

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
      const i = parseInt(inp.dataset.i, 10);
      const [site, k] = inp.dataset.k.split('-');
      state.doctors[i][site][k] = parseInt(inp.value, 10) || 0;
      saveState();
      renderSetup(); // refresh categories
    };
  });
}

// ============================================================
// Init
// ============================================================
if (!state.firstPicker) state.firstPicker = state.doctors[0].name;
render();
