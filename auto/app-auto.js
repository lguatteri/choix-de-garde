'use strict';

// ============================================================
// App Auto-distribution — chargement données + affichage
// (algo de génération à venir)
// ============================================================

const sb = () => window.supabaseClient;

// PERIOD_START / PERIOD_END / HOLIDAYS sont définis dans doctors.js (chargé avant)
const MONTHS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const WEEKDAYS_HEADER = ['L','M','M','J','V','S','D'];

let autoState = {
  doctors: [],
  holidays: [],
  voeuxByDoctor: {},
  realVoeuxByDoctor: null,   // sauvegarde quand on entre en simulation
  simulationMode: false,
  prefsByDoctor: {},          // name -> { blockedHMN:[dow], blockedACH:[dow], preferSem:[dow], preferWe:[dow] }
  proposed: {},      // dateStr -> { HMN: name, ACH: name }
  failures: [],      // [{ date, site, reason }]
  remainingAfter: {}, // doctorName -> { ACH:{sem,we}, HMN:{sem,we} } restants après gen
};

function getPrefs(name) {
  if (!autoState.prefsByDoctor[name]) {
    autoState.prefsByDoctor[name] = {
      blockedHMN: [], blockedACH: [],
      preferSem: [], preferWe: [],
    };
  }
  return autoState.prefsByDoctor[name];
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()); }
function parseYMD(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function* iterDates(s, e) {
  const a = parseYMD(s), b = parseYMD(e);
  for (let d = new Date(a); d <= b; d.setDate(d.getDate()+1)) yield ymd(d);
}
function dayType(dateStr) {
  if (autoState.holidays.includes(dateStr)) return 'holiday';
  const dow = parseYMD(dateStr).getDay();
  if (dow === 0) return 'sunday';
  if (dow === 6) return 'saturday';
  if (dow === 5) return 'friday';
  return 'weekday';
}
function isWE(dateStr) {
  const t = dayType(dateStr);
  return t === 'sunday' || t === 'saturday' || t === 'holiday';
}
function dateAdd(dateStr, n) {
  const d = parseYMD(dateStr);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function bucketOf(dateStr) { return isWE(dateStr) ? 'we' : 'sem'; }
function weekStart(dateStr) {
  // Lundi de la semaine contenant dateStr (ISO Lun→Dim)
  const d = parseYMD(dateStr);
  const offset = (d.getDay() + 6) % 7;  // Lun=0..Dim=6
  d.setDate(d.getDate() - offset);
  return ymd(d);
}

const MAX_GARDES_PER_WEEK = 3;

async function loadAllForAuto() {
  const [doctors, holidays, profiles, voeux] = await Promise.all([
    sb().from('doctors').select('*').order('name'),
    sb().from('holidays').select('date'),
    sb().from('profiles').select('*'),
    sb().from('voeux').select('*'),
  ]);
  if (doctors.error) throw doctors.error;
  autoState.doctors = (doctors.data || []).map(d => ({
    name: d.name,
    ACH: { sem: d.ach_sem, we: d.ach_we },
    HMN: { sem: d.hmn_sem, we: d.hmn_we },
  })).sort((a,b) => a.name.localeCompare(b.name, 'fr'));
  autoState.holidays = (holidays.data || []).map(h => h.date);
  const profByUid = Object.fromEntries((profiles.data || []).map(p => [p.user_id, p.doctor_name]));
  autoState.voeuxByDoctor = {};
  (voeux.data || []).forEach(row => {
    const dn = profByUid[row.user_id];
    if (!dn) return;
    if (!autoState.voeuxByDoctor[dn]) autoState.voeuxByDoctor[dn] = {};
    autoState.voeuxByDoctor[dn][row.date] = row.voeu;
  });
}

function computeSlotCounts() {
  let sem = 0, we = 0;
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    if (isWE(d)) we++; else sem++;
  }
  return { sem, we };
}

function renderObjectivesCheck() {
  const slots = computeSlotCounts();
  const totals = { ACH: { sem: 0, we: 0 }, HMN: { sem: 0, we: 0 } };
  autoState.doctors.forEach(d => {
    totals.ACH.sem += d.ACH.sem;
    totals.ACH.we += d.ACH.we;
    totals.HMN.sem += d.HMN.sem;
    totals.HMN.we += d.HMN.we;
  });
  const rows = [
    ['ACH semaine',    totals.ACH.sem, slots.sem],
    ['ACH WE+fériés',  totals.ACH.we,  slots.we],
    ['HMN semaine',    totals.HMN.sem, slots.sem],
    ['HMN WE+fériés',  totals.HMN.we,  slots.we],
  ];
  let totalObj = 0, totalSlot = 0;
  function diffCell(diff) {
    if (diff === 0)  return `<span style="color:#15803d;font-weight:700">✓ exact</span>`;
    if (diff < 0)    return `<span style="color:#b91c1c;font-weight:700">⚠ manque ${-diff}</span>`;
    return `<span style="color:#92400e;font-weight:700">+${diff} en trop</span>`;
  }
  let html = `<table>
    <thead><tr>
      <th>Type de garde</th>
      <th style="text-align:right">Objectifs déclarés</th>
      <th style="text-align:right">Slots à couvrir</th>
      <th>Écart</th>
    </tr></thead><tbody>`;
  rows.forEach(([label, obj, slot]) => {
    totalObj += obj;
    totalSlot += slot;
    html += `<tr>
      <td>${label}</td>
      <td style="text-align:right">${obj}</td>
      <td style="text-align:right">${slot}</td>
      <td>${diffCell(obj - slot)}</td>
    </tr>`;
  });
  html += `<tr class="total-row">
    <td>Total période (1er juin → 30 sept 2026)</td>
    <td style="text-align:right">${totalObj}</td>
    <td style="text-align:right">${totalSlot}</td>
    <td>${diffCell(totalObj - totalSlot)}</td>
  </tr>`;
  html += '</tbody></table>';
  document.getElementById('objectives-check').innerHTML = html;
}

function renderCoverageTable() {
  const t = document.getElementById('coverage-table');
  let html = `<table>
    <thead><tr>
      <th>Médecin</th>
      <th>ACH sem</th><th>ACH WE+f</th>
      <th>HMN sem</th><th>HMN WE+f</th>
      <th>💙 vœux</th><th>🚫 indispos</th>
      <th>Statut</th>
    </tr></thead><tbody>`;
  autoState.doctors.forEach(d => {
    const v = autoState.voeuxByDoctor[d.name] || {};
    let nVoeux = 0, nBlocked = 0;
    Object.values(v).forEach(x => {
      if (x === 'blocked') nBlocked++;
      else if (x && x.startsWith('wished')) nVoeux++;
    });
    const total = d.ACH.sem + d.ACH.we + d.HMN.sem + d.HMN.we;
    const we = d.ACH.we + d.HMN.we;
    let badge = `<span class="badge badge-ok">prêt</span>`;
    // Faisabilité grossière : trop d'indispos vs WE objectifs ?
    if (nBlocked > 30 && we > 0) badge = `<span class="badge badge-warn">bcp d'indispos</span>`;
    if (total === 0) badge = `<span class="badge badge-err">0 obj</span>`;
    html += `<tr>
      <td class="doctor-name" data-doctor="${d.name}" title="Cliquer pour voir/modifier les indispos"><strong>${d.name}</strong></td>
      <td>${d.ACH.sem}</td><td>${d.ACH.we}</td>
      <td>${d.HMN.sem}</td><td>${d.HMN.we}</td>
      <td>${nVoeux}</td><td>${nBlocked}</td>
      <td>${badge}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  t.innerHTML = html;
  t.querySelectorAll('td.doctor-name').forEach(td => {
    td.addEventListener('click', () => openDoctorEditor(td.dataset.doctor));
  });
}

function renderAutoCalendar() {
  const c = document.getElementById('auto-calendar');
  c.innerHTML = '';
  // Compter les indispos par jour pour affichage rapide
  const blockedByDate = {};
  Object.entries(autoState.voeuxByDoctor).forEach(([name, voeux]) => {
    Object.entries(voeux).forEach(([date, v]) => {
      if (v === 'blocked') {
        if (!blockedByDate[date]) blockedByDate[date] = [];
        blockedByDate[date].push(name);
      }
    });
  });

  const months = [];
  let cur = null;
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    const dt = parseYMD(d);
    const k = dt.getFullYear() + '-' + dt.getMonth();
    if (!cur || cur.key !== k) { cur = { key: k, days: [] }; months.push(cur); }
    cur.days.push(d);
  }
  months.forEach(m => {
    const monthEl = document.createElement('div');
    monthEl.className = 'month';
    const fd = parseYMD(m.days[0]);
    const h2 = document.createElement('h2');
    h2.textContent = MONTHS_FR[fd.getMonth()];
    monthEl.appendChild(h2);
    const content = document.createElement('div');
    content.className = 'month-content';
    const wkEl = document.createElement('div');
    wkEl.className = 'weekdays';
    WEEKDAYS_HEADER.forEach(w => { const s = document.createElement('div'); s.textContent = w; wkEl.appendChild(s); });
    content.appendChild(wkEl);
    const daysEl = document.createElement('div');
    daysEl.className = 'days';
    const firstDow = (fd.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) {
      const e = document.createElement('div'); e.className = 'day empty'; daysEl.appendChild(e);
    }
    m.days.forEach(d => {
      const cell = document.createElement('div');
      cell.className = 'day';
      const t = dayType(d);
      if (t === 'holiday') cell.classList.add('holiday');
      else if (t === 'sunday' || t === 'saturday') cell.classList.add('weekend');
      else if (t === 'friday') cell.classList.add('friday');
      const num = document.createElement('div'); num.className = 'num'; num.textContent = parseYMD(d).getDate();
      cell.appendChild(num);
      const blockers = blockedByDate[d] || [];
      if (blockers.length > 0) {
        const tag = document.createElement('div');
        tag.className = 'slot';
        tag.style.background = '#fee2e2';
        tag.style.color = '#7f1d1d';
        tag.style.fontWeight = '700';
        tag.textContent = `🚫 ${blockers.length}`;
        tag.title = blockers.join(', ');
        cell.appendChild(tag);
      }
      daysEl.appendChild(cell);
    });
    content.appendChild(daysEl);
    monthEl.appendChild(content);
    c.appendChild(monthEl);
  });
}

// ============================================================
// ALGORITHME : génération gloutonne avec scoring
// ============================================================
function generatePlanning() {
  const slots = [];
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    slots.push({ date: d, site: 'HMN' });
    slots.push({ date: d, site: 'ACH' });
  }
  // Compteurs restants par médecin (cloné)
  const rem = {};
  autoState.doctors.forEach(d => {
    rem[d.name] = {
      ACH: { sem: d.ACH.sem, we: d.ACH.we },
      HMN: { sem: d.HMN.sem, we: d.HMN.we },
    };
  });
  const assignment = {};      // dateStr -> { HMN: name, ACH: name }

  function canAssign(slot, name) {
    const r = rem[name];
    const b = bucketOf(slot.date);
    if (r[slot.site][b] <= 0) return false;
    if ((autoState.voeuxByDoctor[name] || {})[slot.date] === 'blocked') return false;
    // Règles récurrentes par jour de semaine
    const prefs = autoState.prefsByDoctor[name];
    if (prefs) {
      const dow = parseYMD(slot.date).getDay();
      if (slot.site === 'HMN' && prefs.blockedHMN.includes(dow)) return false;
      if (slot.site === 'ACH' && prefs.blockedACH.includes(dow)) return false;
    }
    // Adjacence : pas la veille / pas le même jour autre site / pas le lendemain
    const checks = [
      { date: dateAdd(slot.date, -1), all: true },
      { date: slot.date, all: false },
      { date: dateAdd(slot.date, 1),  all: true },
    ];
    for (const c of checks) {
      const a = assignment[c.date];
      if (!a) continue;
      if (c.all) {
        if (a.HMN === name || a.ACH === name) return false;
      } else {
        const other = slot.site === 'HMN' ? 'ACH' : 'HMN';
        if (a[other] === name) return false;
      }
    }
    // Max gardes par semaine ISO (Lun→Dim)
    const ws = weekStart(slot.date);
    let weekCount = 0;
    for (let i = 0; i < 7; i++) {
      const dd = dateAdd(ws, i);
      const a = assignment[dd];
      if (!a) continue;
      if (a.HMN === name) weekCount++;
      if (a.ACH === name) weekCount++;
    }
    if (weekCount >= MAX_GARDES_PER_WEEK) return false;
    return true;
  }

  function score(slot, name) {
    const r = rem[name];
    const b = bucketOf(slot.date);
    let s = 0;
    // Médecins avec le plus à placer = priorité (sinon les mono-objectifs vont être coincés)
    s += r[slot.site][b] * 12;
    // Vœux : bonus
    const v = (autoState.voeuxByDoctor[name] || {})[slot.date];
    if (v === 'wished' + slot.site) s += 50;
    else if (v === 'wishedBoth') s += 30;
    else if (v && v.startsWith('wished')) s += 8;  // wished autre site mais pas celui-là
    // Préférences récurrentes (jour de semaine préféré pour sem/WE)
    const prefs = autoState.prefsByDoctor[name];
    if (prefs) {
      const dow = parseYMD(slot.date).getDay();
      if (b === 'sem' && prefs.preferSem.includes(dow)) s += 20;
      if (b === 'we'  && prefs.preferWe.includes(dow))  s += 20;
    }
    // Tie-breaking aléatoire (pour avoir des plannings différents à chaque génération)
    s += Math.random() * 6;
    return s;
  }

  // Ordre de traitement : créneaux les plus contraints d'abord (WE+férié, puis vendredi, puis semaine)
  slots.sort((a, b) => {
    const ta = dayType(a.date), tb = dayType(b.date);
    const order = { holiday: 0, sunday: 1, saturday: 2, friday: 3, weekday: 4 };
    if (order[ta] !== order[tb]) return order[ta] - order[tb];
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.site.localeCompare(b.site);
  });

  const failures = [];
  for (const slot of slots) {
    const cands = autoState.doctors
      .filter(d => canAssign(slot, d.name))
      .map(d => ({ name: d.name, score: score(slot, d.name) }));
    if (cands.length === 0) {
      // Diagnostic : on filtre étape par étape pour voir où ça bloque
      let nObj = 0, nNotBlocked = 0, nNotPrefBlocked = 0, nNotWeekFull = 0;
      const dow = parseYMD(slot.date).getDay();
      const ws = weekStart(slot.date);
      autoState.doctors.forEach(d => {
        const r = rem[d.name];
        const b = bucketOf(slot.date);
        if (r[slot.site][b] <= 0) return;
        nObj++;
        if ((autoState.voeuxByDoctor[d.name] || {})[slot.date] === 'blocked') return;
        nNotBlocked++;
        const prefs = autoState.prefsByDoctor[d.name];
        if (prefs) {
          if (slot.site === 'HMN' && prefs.blockedHMN.includes(dow)) return;
          if (slot.site === 'ACH' && prefs.blockedACH.includes(dow)) return;
        }
        nNotPrefBlocked++;
        let wc = 0;
        for (let i = 0; i < 7; i++) {
          const dd = dateAdd(ws, i);
          const a = assignment[dd];
          if (!a) continue;
          if (a.HMN === d.name) wc++;
          if (a.ACH === d.name) wc++;
        }
        if (wc >= MAX_GARDES_PER_WEEK) return;
        nNotWeekFull++;
      });
      let reason;
      if (nObj === 0) reason = 'Aucun médecin n\'a d\'objectif restant pour ce site/bucket';
      else if (nNotBlocked === 0) reason = `Tous bloqués (indispo posée) — ${nObj} candidats avant filtrage`;
      else if (nNotPrefBlocked === 0) reason = `Tous bloqués par préférence DOW — ${nNotBlocked} candidats avant filtrage`;
      else if (nNotWeekFull === 0) reason = `Tous ont déjà ${MAX_GARDES_PER_WEEK} gardes cette semaine — ${nNotPrefBlocked} candidats avant`;
      else reason = `Tous bloqués par adjacence (veille/lendemain/même jour) — ${nNotWeekFull} candidats avant`;
      failures.push({ date: slot.date, site: slot.site, reason });
      continue;
    }
    cands.sort((a, b) => b.score - a.score);
    const chosen = cands[0].name;
    if (!assignment[slot.date]) assignment[slot.date] = {};
    assignment[slot.date][slot.site] = chosen;
    rem[chosen][slot.site][bucketOf(slot.date)]--;
  }

  autoState.proposed = assignment;
  autoState.failures = failures;
  autoState.remainingAfter = rem;
  return { assignment, failures, rem };
}

function renderProposedCalendar() {
  const c = document.getElementById('auto-calendar');
  c.innerHTML = '';
  const months = [];
  let cur = null;
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    const dt = parseYMD(d);
    const k = dt.getFullYear() + '-' + dt.getMonth();
    if (!cur || cur.key !== k) { cur = { key: k, days: [] }; months.push(cur); }
    cur.days.push(d);
  }
  const failureKeys = new Set(autoState.failures.map(f => f.date+':'+f.site));
  months.forEach(m => {
    const monthEl = document.createElement('div');
    monthEl.className = 'month';
    const fd = parseYMD(m.days[0]);
    const h2 = document.createElement('h2');
    h2.textContent = MONTHS_FR[fd.getMonth()];
    monthEl.appendChild(h2);
    const content = document.createElement('div');
    content.className = 'month-content';
    const wkEl = document.createElement('div');
    wkEl.className = 'weekdays';
    WEEKDAYS_HEADER.forEach(w => { const s = document.createElement('div'); s.textContent = w; wkEl.appendChild(s); });
    content.appendChild(wkEl);
    const daysEl = document.createElement('div');
    daysEl.className = 'days';
    const firstDow = (fd.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) {
      const e = document.createElement('div'); e.className = 'day empty'; daysEl.appendChild(e);
    }
    m.days.forEach(d => {
      const cell = document.createElement('div');
      cell.className = 'day';
      const t = dayType(d);
      if (t === 'holiday') cell.classList.add('holiday');
      else if (t === 'sunday' || t === 'saturday') cell.classList.add('weekend');
      else if (t === 'friday') cell.classList.add('friday');
      const num = document.createElement('div'); num.className = 'num'; num.textContent = parseYMD(d).getDate();
      cell.appendChild(num);
      const a = autoState.proposed[d] || {};
      const longShift = isWE(d) || dayType(d) === 'holiday' || dayType(d) === 'sunday';
      ['HMN','ACH'].forEach(site => {
        const slot = document.createElement('div');
        slot.className = 'slot ' + site;
        if (a[site]) {
          slot.textContent = `${site} ${shortName(a[site])}`;
          slot.style.background = 'rgba(185,28,28,0.18)';
          slot.style.color = '#7f1d1d';
          slot.style.fontWeight = '600';
        } else if (failureKeys.has(d+':'+site)) {
          slot.textContent = `${site} ⚠`;
          slot.style.background = '#fecaca';
          slot.style.color = '#7f1d1d';
          slot.style.fontWeight = '700';
          slot.title = 'Aucun candidat trouvé';
        } else {
          slot.className = 'slot empty-slot';
          slot.textContent = site;
        }
        cell.appendChild(slot);
      });
      daysEl.appendChild(cell);
    });
    content.appendChild(daysEl);
    monthEl.appendChild(content);
    c.appendChild(monthEl);
  });
}

function shortName(name) {
  if (!name) return '';
  const parts = name.split(' ');
  return parts[0].slice(0,4) + '.' + (parts[1] ? parts[1][0] : '');
}

function renderAlgoStatus() {
  const el = document.getElementById('algo-status');
  const doctors = autoState.doctors;
  const rem = autoState.remainingAfter;
  let perDoctor = '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px"><thead><tr><th style="text-align:left;padding:4px">Médecin</th><th>ACH sem</th><th>ACH WE</th><th>HMN sem</th><th>HMN WE</th><th>Statut</th></tr></thead><tbody>';
  let allOk = true;
  doctors.forEach(d => {
    const r = rem[d.name];
    const left = r.ACH.sem + r.ACH.we + r.HMN.sem + r.HMN.we;
    let status, color;
    if (left === 0) { status = '✓'; color = '#15803d'; }
    else { status = `${left} non placés`; color = '#b91c1c'; allOk = false; }
    perDoctor += `<tr style="border-top:1px solid #e2e8f0">
      <td style="padding:4px"><strong>${d.name}</strong></td>
      <td style="text-align:center">${d.ACH.sem - r.ACH.sem}/${d.ACH.sem}</td>
      <td style="text-align:center">${d.ACH.we - r.ACH.we}/${d.ACH.we}</td>
      <td style="text-align:center">${d.HMN.sem - r.HMN.sem}/${d.HMN.sem}</td>
      <td style="text-align:center">${d.HMN.we - r.HMN.we}/${d.HMN.we}</td>
      <td style="color:${color};font-weight:600">${status}</td>
    </tr>`;
  });
  perDoctor += '</tbody></table>';
  let failHtml = '';
  if (autoState.failures.length) {
    failHtml = `<p style="color:#b91c1c;margin-top:10px"><strong>${autoState.failures.length} créneau(x) non couvert(s) :</strong></p><ul style="font-size:12px;color:#7f1d1d">`;
    autoState.failures.forEach(f => {
      failHtml += `<li>${f.date} — ${f.site} : ${f.reason}</li>`;
    });
    failHtml += '</ul>';
  }
  el.innerHTML = `
    <p><strong>${allOk && !autoState.failures.length ? '✓ Génération réussie' : '⚠ Génération partielle'}</strong> — ${Object.keys(autoState.proposed).length} jours assignés, ${autoState.failures.length} créneau(x) en échec.</p>
    ${failHtml}
    ${perDoctor}
  `;
}

// ============================================================
// SIMULATION : remplit voeuxByDoctor avec des données fictives
// ============================================================
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Vacances scolaires d'été 2026 (FR) : du sam 4 juillet au mar 1er septembre
const SCHOOL_HOLIDAYS_START = '2026-07-04';
const SCHOOL_HOLIDAYS_END   = '2026-09-01';

function isHmnOnly(doc) {
  return doc.ACH.sem === 0 && doc.ACH.we === 0;
}

function placeBlock(doc, size, prefersSchool, fake, hmnAbsentByDate, allDates, rand, maxHmnAbsent) {
  const isHmn = isHmnOnly(doc);
  // Construit la liste des indices de départ valides avec un poids
  const candidates = [];
  for (let i = 0; i <= allDates.length - size; i++) {
    const startDate = allDates[i];
    const endDate = allDates[i + size - 1];
    const overlapsSchool = startDate <= SCHOOL_HOLIDAYS_END && endDate >= SCHOOL_HOLIDAYS_START;
    const weight = prefersSchool
      ? (overlapsSchool ? 5 : 1)
      : (overlapsSchool ? 1 : 4);
    candidates.push({ idx: i, weight });
  }
  // Plusieurs essais : tirage pondéré, puis on vérifie collision
  for (let attempt = 0; attempt < 60; attempt++) {
    const totalW = candidates.reduce((s, c) => s + c.weight, 0);
    if (totalW <= 0) break;
    let r = rand() * totalW;
    let chosen = candidates[0];
    for (const c of candidates) {
      r -= c.weight;
      if (r <= 0) { chosen = c; break; }
    }
    let valid = true;
    for (let k = 0; k < size; k++) {
      const date = allDates[chosen.idx + k];
      if (fake[doc.name][date]) { valid = false; break; }
      if (isHmn && hmnAbsentByDate[date] >= maxHmnAbsent) { valid = false; break; }
    }
    if (valid) {
      for (let k = 0; k < size; k++) {
        const date = allDates[chosen.idx + k];
        fake[doc.name][date] = 'blocked';
        if (isHmn) hmnAbsentByDate[date]++;
      }
      return true;
    }
  }
  return false;
}

function generateRealisticIndispos(seed, totalTarget) {
  const rand = mulberry32(seed >>> 0);
  const allDates = [];
  for (const d of iterDates(PERIOD_START, PERIOD_END)) allDates.push(d);

  const fake = {};
  autoState.doctors.forEach(d => fake[d.name] = {});

  // Contrainte HMN-only : minimum 3 présents → max (n - 3) absents par jour
  const hmnOnlyDocs = autoState.doctors.filter(isHmnOnly);
  const maxHmnAbsent = Math.max(0, hmnOnlyDocs.length - 3);
  const hmnAbsentByDate = {};
  allDates.forEach(d => hmnAbsentByDate[d] = 0);

  // Traiter d'abord les HMN-only (plus contraints)
  const ordered = [
    ...autoState.doctors.filter(isHmnOnly),
    ...autoState.doctors.filter(d => !isHmnOnly(d)),
  ];

  const stats = { totalVacDays: 0, totalScattered: 0, blocksPlaced: 0, blocksFailed: 0 };

  for (const doc of ordered) {
    // Cible par médecin : ±15% autour du target global
    const noise = 0.85 + rand() * 0.30;
    const docTarget = Math.max(0, Math.round(totalTarget * noise));
    // 60% en congés (par blocs), 40% en indispos ponctuelles
    const totalVac = Math.round(docTarget * 0.6);
    const targetScattered = Math.max(0, docTarget - totalVac);
    const prefersSchool = rand() < 0.75;

    // 1 à 3 blocs de congés (min 5j chacun, sauf si totalVac trop petit)
    const minBlock = totalVac >= 15 ? 5 : Math.max(1, Math.floor(totalVac / 2));
    const maxBlocks = Math.max(1, Math.min(3, Math.floor(totalVac / minBlock)));
    const numBlocks = 1 + Math.floor(rand() * maxBlocks);

    const sizes = [];
    let remaining = totalVac;
    for (let i = 0; i < numBlocks; i++) {
      if (i === numBlocks - 1) {
        sizes.push(Math.max(minBlock, remaining));
      } else {
        const reserveForRest = minBlock * (numBlocks - i - 1);
        const maxSize = Math.max(minBlock, remaining - reserveForRest);
        const s = minBlock + Math.floor(rand() * Math.max(1, maxSize - minBlock + 1));
        sizes.push(s);
        remaining -= s;
      }
    }

    sizes.forEach(size => {
      if (size <= 0) return;
      const ok = placeBlock(doc, size, prefersSchool, fake, hmnAbsentByDate, allDates, rand, maxHmnAbsent);
      if (ok) stats.blocksPlaced++; else stats.blocksFailed++;
    });

    // Indispos ponctuelles : blocs de 1 ou 2 jours
    let placed = 0;
    let attempts = 0;
    const isHmn = isHmnOnly(doc);
    while (placed < targetScattered && attempts < 300) {
      attempts++;
      const blockLen = rand() < 0.35 ? 2 : 1;
      const startIdx = Math.floor(rand() * (allDates.length - blockLen + 1));
      let valid = true;
      const candidates = [];
      for (let k = 0; k < blockLen; k++) {
        const date = allDates[startIdx + k];
        if (fake[doc.name][date]) { valid = false; break; }
        if (isHmn && hmnAbsentByDate[date] >= maxHmnAbsent) { valid = false; break; }
        candidates.push(date);
      }
      if (valid) {
        candidates.forEach(date => {
          fake[doc.name][date] = 'blocked';
          if (isHmn) hmnAbsentByDate[date]++;
        });
        placed += candidates.length;
        stats.totalScattered += candidates.length;
      }
    }

    stats.totalVacDays += Object.keys(fake[doc.name]).length - placed;
  }

  // Stats max HMN-only absent
  let maxHmnSimul = 0;
  Object.values(hmnAbsentByDate).forEach(n => { if (n > maxHmnSimul) maxHmnSimul = n; });
  stats.maxHmnSimul = maxHmnSimul;
  stats.hmnOnlyCount = hmnOnlyDocs.length;
  stats.maxHmnAbsentAllowed = maxHmnAbsent;

  return { fake, stats };
}

function setSimulationMode(on) {
  autoState.simulationMode = on;
  const panel = document.querySelector('.sim-panel');
  const badge = document.getElementById('sim-badge');
  const banner = document.getElementById('banner');
  const restoreBtn = document.getElementById('sim-restore-btn');
  if (panel) panel.classList.toggle('active', on);
  if (badge) badge.hidden = !on;
  if (restoreBtn) restoreBtn.disabled = !on;
  if (banner) {
    if (on) {
      banner.style.background = '#fef3c7';
      banner.style.borderColor = '#f59e0b';
      banner.innerHTML = '<strong>🧪 Mode simulation actif.</strong> Les vœux/indispos sont fictifs. Le bouton « pousser vers l\'app principale » est désactivé.';
    } else {
      banner.style.background = '';
      banner.style.borderColor = '';
      banner.innerHTML = '<strong>Mode auto-distribution.</strong> Génère un planning à partir des objectifs, indispos et vœux de chacun. À tester avant de pousser vers l\'app principale.';
    }
  }
}

function applySimulation() {
  const seedRaw = parseInt(document.getElementById('sim-seed').value, 10);
  const seed = Number.isFinite(seedRaw) ? seedRaw : Math.floor(Math.random() * 1e9);
  const targetRaw = parseInt(document.getElementById('sim-target').value, 10);
  const target = Number.isFinite(targetRaw) ? Math.max(0, targetRaw) : 50;
  if (!autoState.doctors.length) {
    alert('Données médecins pas chargées. Recharge la page.');
    return;
  }
  if (!autoState.realVoeuxByDoctor) {
    autoState.realVoeuxByDoctor = autoState.voeuxByDoctor;
  }
  const { fake, stats } = generateRealisticIndispos(seed, target);
  autoState.voeuxByDoctor = fake;
  setSimulationMode(true);
  renderCoverageTable();
  renderAutoCalendar();
  autoState.proposed = {};
  autoState.failures = [];
  autoState.remainingAfter = {};
  const cb = document.getElementById('commit-btn');
  if (cb) cb.remove();

  // Stats détaillées
  const totalBlocked = Object.values(fake).reduce(
    (acc, m) => acc + Object.values(m).filter(v => v === 'blocked').length, 0);
  const avgBlocked = (totalBlocked / autoState.doctors.length).toFixed(1);
  const status = document.getElementById('sim-status');
  if (status) {
    const warn = stats.blocksFailed > 0
      ? ` <span style="color:#b91c1c">⚠ ${stats.blocksFailed} bloc(s) de congé n'ont pas pu être placés (contrainte HMN).</span>` : '';
    status.innerHTML = `
      ✓ Seed <strong>${seed}</strong> — ${totalBlocked} indispos au total (≈ ${avgBlocked}/médecin).
      Max simultané HMN-only absents : <strong>${stats.maxHmnSimul}/${stats.hmnOnlyCount}</strong>
      (limite ${stats.maxHmnAbsentAllowed}, soit min ${stats.hmnOnlyCount - stats.maxHmnAbsentAllowed} présents).${warn}
      <br>Clique <strong>⚡ Générer le planning</strong> pour tester l'algo.
    `;
  }
  document.getElementById('algo-status').innerHTML =
    `<p><strong>🧪 Simulation réaliste prête.</strong> Lance l'algorithme pour voir comment il s'en sort.</p>`;
}

function restoreRealData() {
  if (!autoState.realVoeuxByDoctor) return;
  autoState.voeuxByDoctor = autoState.realVoeuxByDoctor;
  autoState.realVoeuxByDoctor = null;
  setSimulationMode(false);
  renderCoverageTable();
  renderAutoCalendar();
  autoState.proposed = {};
  autoState.failures = [];
  autoState.remainingAfter = {};
  const cb = document.getElementById('commit-btn');
  if (cb) cb.remove();
  const status = document.getElementById('sim-status');
  if (status) status.textContent = '↻ Données réelles restaurées.';
  document.getElementById('algo-status').innerHTML =
    `<p><strong>✓ Données réelles restaurées.</strong> ${autoState.doctors.length} médecins.</p>`;
}

// ============================================================
// ÉDITEUR D'INDISPOS PAR MÉDECIN (modale)
// ============================================================
let _editorDoctor = null;

// Mapping affichage L M M J V S D ↔ Date.getDay() (0=Dim..6=Sam)
const DOW_LABELS = ['L','M','M','J','V','S','D'];
const DOW_GETDAY = [1, 2, 3, 4, 5, 6, 0];   // index → Date.getDay()
const SEM_INDICES = [0,1,2,3,4];   // L,M,M,J,V
const WE_INDICES  = [5,6];          // S,D

function openDoctorEditor(doctorName) {
  _editorDoctor = doctorName;
  const backdrop = document.getElementById('doctor-editor-backdrop');
  document.getElementById('doctor-editor-title').textContent = doctorName;
  renderDoctorEditor();
  renderEditorPrefs();
  backdrop.hidden = false;
}

function renderEditorPrefs() {
  if (!_editorDoctor) return;
  const prefs = getPrefs(_editorDoctor);
  const rows = [
    { key: 'blockedHMN', kind: 'block',  indices: [0,1,2,3,4,5,6] },
    { key: 'blockedACH', kind: 'block',  indices: [0,1,2,3,4,5,6] },
    { key: 'preferSem',  kind: 'prefer', indices: SEM_INDICES },
    { key: 'preferWe',   kind: 'prefer', indices: WE_INDICES },
  ];
  rows.forEach(r => {
    const container = document.querySelector(`.dow-chips[data-pref="${r.key}"]`);
    if (!container) return;
    container.innerHTML = '';
    r.indices.forEach(idx => {
      const dow = DOW_GETDAY[idx];
      const chip = document.createElement('div');
      chip.className = 'dow-chip ' + r.kind;
      chip.textContent = DOW_LABELS[idx];
      if (prefs[r.key].includes(dow)) chip.classList.add('active');
      chip.addEventListener('click', () => {
        const arr = prefs[r.key];
        const i = arr.indexOf(dow);
        if (i >= 0) arr.splice(i, 1); else arr.push(dow);
        renderEditorPrefs();
      });
      container.appendChild(chip);
    });
  });
}

function clearEditorPrefs() {
  if (!_editorDoctor) return;
  if (!confirm(`Effacer toutes les préférences récurrentes de ${_editorDoctor} ?`)) return;
  const p = getPrefs(_editorDoctor);
  p.blockedHMN = []; p.blockedACH = [];
  p.preferSem = []; p.preferWe = [];
  renderEditorPrefs();
}

function closeDoctorEditor() {
  _editorDoctor = null;
  document.getElementById('doctor-editor-backdrop').hidden = true;
  // Re-render des vues principales pour refléter les changements
  renderCoverageTable();
  if (Object.keys(autoState.proposed).length === 0) {
    renderAutoCalendar();
  }
}

function renderDoctorEditor() {
  if (!_editorDoctor) return;
  const name = _editorDoctor;
  const doc = autoState.doctors.find(d => d.name === name);
  if (!doc) return;
  const map = autoState.voeuxByDoctor[name] || (autoState.voeuxByDoctor[name] = {});
  const blockedCount = Object.values(map).filter(v => v === 'blocked').length;
  document.getElementById('doctor-editor-stats').innerHTML =
    `Objectifs : <strong>ACH</strong> ${doc.ACH.sem}sem + ${doc.ACH.we}WE — <strong>HMN</strong> ${doc.HMN.sem}sem + ${doc.HMN.we}WE
     · <strong>${blockedCount}</strong> jour${blockedCount > 1 ? 's' : ''} d'indispo`;

  const c = document.getElementById('doctor-editor-calendar');
  c.innerHTML = '';
  const months = [];
  let cur = null;
  for (const d of iterDates(PERIOD_START, PERIOD_END)) {
    const dt = parseYMD(d);
    const k = dt.getFullYear() + '-' + dt.getMonth();
    if (!cur || cur.key !== k) { cur = { key: k, days: [] }; months.push(cur); }
    cur.days.push(d);
  }
  months.forEach(m => {
    const monthEl = document.createElement('div');
    monthEl.className = 'month';
    const fd = parseYMD(m.days[0]);
    const h4 = document.createElement('h4');
    h4.textContent = MONTHS_FR[fd.getMonth()] + ' ' + fd.getFullYear();
    monthEl.appendChild(h4);
    const wkEl = document.createElement('div');
    wkEl.className = 'weekdays';
    WEEKDAYS_HEADER.forEach(w => { const s = document.createElement('div'); s.textContent = w; wkEl.appendChild(s); });
    monthEl.appendChild(wkEl);
    const daysEl = document.createElement('div');
    daysEl.className = 'days';
    const firstDow = (fd.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) {
      const e = document.createElement('div'); e.className = 'day empty'; daysEl.appendChild(e);
    }
    m.days.forEach(d => {
      const cell = document.createElement('div');
      cell.className = 'day';
      const t = dayType(d);
      if (t === 'holiday') cell.classList.add('holiday');
      else if (t === 'sunday' || t === 'saturday') cell.classList.add('weekend');
      cell.textContent = parseYMD(d).getDate();
      if (map[d] === 'blocked') cell.classList.add('blocked');
      cell.addEventListener('click', () => toggleEditorDay(d));
      daysEl.appendChild(cell);
    });
    monthEl.appendChild(daysEl);
    c.appendChild(monthEl);
  });
}

function toggleEditorDay(date) {
  if (!_editorDoctor) return;
  const map = autoState.voeuxByDoctor[_editorDoctor] || (autoState.voeuxByDoctor[_editorDoctor] = {});
  if (map[date] === 'blocked') {
    delete map[date];
  } else {
    map[date] = 'blocked';
  }
  renderDoctorEditor();
}

function clearEditorDoctor() {
  if (!_editorDoctor) return;
  if (!confirm(`Effacer toutes les indispos de ${_editorDoctor} ?`)) return;
  const map = autoState.voeuxByDoctor[_editorDoctor] || {};
  Object.keys(map).forEach(date => {
    if (map[date] === 'blocked') delete map[date];
  });
  renderDoctorEditor();
}

async function commitToMainPlanning() {
  if (autoState.simulationMode) {
    alert('🧪 Mode simulation actif — impossible de pousser des données fictives en BDD. Restaure les données réelles d\'abord.');
    return;
  }
  if (!confirm('Pousser ce planning généré dans l\'app principale ?\n\n⚠ Ça ÉCRASE toutes les assignations existantes.')) return;
  // Effacer tout
  await sb().from('assignments').delete().neq('date', '1900-01-01');
  // Insert
  const rows = [];
  Object.entries(autoState.proposed).forEach(([date, slots]) => {
    Object.entries(slots).forEach(([site, doctor]) => {
      rows.push({ date, site, doctor_name: doctor, updated_by: window.currentUser.id });
    });
  });
  if (rows.length) {
    const { error } = await sb().from('assignments').insert(rows);
    if (error) { alert('Erreur insert : ' + error.message); return; }
  }
  // Aussi reset session_state pour repartir d'un tour propre côté app principale
  await sb().from('session_state').update({
    picker_cursor: 0,
    current_tour: 1,
    current_turn_pick_count: 0,
    forced_next_picker: null,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  alert('✓ Planning poussé. L\'app principale est mise à jour en temps réel.');
}

let _initialised = false;
async function initAutoApp() {
  if (_initialised) return;
  _initialised = true;
  try {
    await loadAllForAuto();
  } catch (e) {
    document.getElementById('algo-status').innerHTML = `<p style="color:#b91c1c">Erreur de chargement : ${e.message || e}</p>`;
    return;
  }
  renderObjectivesCheck();
  renderCoverageTable();
  renderAutoCalendar();
  document.getElementById('algo-status').innerHTML = `
    <p><strong>✓ Données chargées.</strong> ${autoState.doctors.length} médecins, ${Object.keys(autoState.voeuxByDoctor).length} ont posé des vœux/indispos.</p>
    <p class="hint">Clique <strong>⚡ Générer le planning</strong> pour lancer l'algorithme.</p>
  `;
}
window.initAutoApp = initAutoApp;

// Bindings robustes : se font au chargement du DOM, indépendamment du chargement des données
function bindAutoButtons() {
  console.log('[auto] bindAutoButtons appelée');
  const genBtn = document.getElementById('generate-btn');
  if (!genBtn) { console.error('[auto] #generate-btn introuvable'); return; }
  genBtn.disabled = false;
  genBtn.removeAttribute('disabled');
  genBtn.onclick = () => {
    console.log('[auto] click Générer — doctors=', autoState.doctors.length);
    if (!autoState.doctors || autoState.doctors.length === 0) {
      alert('Données pas chargées. Ouvre la console pour voir l\'erreur, puis recharge.');
      return;
    }
      const status = document.getElementById('algo-status');
      status.innerHTML = '<p>⏳ Génération en cours…</p>';
      setTimeout(() => {
        try {
          generatePlanning();
          renderProposedCalendar();
          renderAlgoStatus();
          if (!document.getElementById('commit-btn')) {
            const btn = document.createElement('button');
            btn.id = 'commit-btn';
            btn.className = 'primary-action';
            btn.textContent = '💾 Pousser ce planning vers l\'app principale';
            btn.style.background = '#15803d';
            btn.style.borderColor = '#15803d';
            btn.onclick = commitToMainPlanning;
            document.querySelector('.auto-actions').appendChild(btn);
          }
        } catch (e) {
          console.error(e);
          status.innerHTML = `<p style="color:#b91c1c">Erreur algo : ${e.message}</p>`;
        }
    }, 40);
  };
  const reloadBtn = document.getElementById('reload-btn');
  if (reloadBtn) reloadBtn.onclick = () => location.reload();
  const simGenBtn = document.getElementById('sim-generate-btn');
  if (simGenBtn) simGenBtn.onclick = applySimulation;
  const simRestoreBtn = document.getElementById('sim-restore-btn');
  if (simRestoreBtn) simRestoreBtn.onclick = restoreRealData;
  const editorClose = document.getElementById('doctor-editor-close');
  if (editorClose) editorClose.onclick = closeDoctorEditor;
  const editorClear = document.getElementById('doctor-editor-clear');
  if (editorClear) editorClear.onclick = clearEditorDoctor;
  const editorClearPrefs = document.getElementById('doctor-editor-clear-prefs');
  if (editorClearPrefs) editorClearPrefs.onclick = clearEditorPrefs;
  const editorBack = document.getElementById('doctor-editor-backdrop');
  if (editorBack) editorBack.addEventListener('click', e => {
    if (e.target === editorBack) closeDoctorEditor();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _editorDoctor) closeDoctorEditor();
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindAutoButtons);
} else {
  bindAutoButtons();
}
