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
  maxWished: 5,               // plafond global de dates voulues 💙 par médecin (admin)
  maxIndispo: 30,             // plafond global d'indispos déclarées pour l'auto (admin)
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

function periodLabel() {
  const s = parseYMD(PERIOD_START), e = parseYMD(PERIOD_END);
  const sy = s.getFullYear(), ey = e.getFullYear();
  if (sy === ey) return `${MONTHS_FR[s.getMonth()]} – ${MONTHS_FR[e.getMonth()]} ${ey}`;
  return `${MONTHS_FR[s.getMonth()]} ${sy} – ${MONTHS_FR[e.getMonth()]} ${ey}`;
}

async function loadAllForAuto() {
  // L'algo lit la COPIE auto (auto_declarations), importée du Perso par chaque
  // médecin, + les vraies préférences.
  const [doctors, holidays, profiles, decls, prefs, sess] = await Promise.all([
    sb().from('doctors').select('*').order('name'),
    sb().from('holidays').select('date'),
    sb().from('profiles').select('*'),
    sb().from('auto_declarations').select('*'),
    sb().from('preferences').select('*'),
    sb().from('session_state').select('max_wished, max_indispo, period_start, period_end').eq('id', 1).maybeSingle(),
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
  (decls.data || []).forEach(row => {
    const dn = profByUid[row.user_id];
    if (!dn) return;
    if (!autoState.voeuxByDoctor[dn]) autoState.voeuxByDoctor[dn] = {};
    autoState.voeuxByDoctor[dn][row.date] = row.voeu;
  });
  // Préférences récurrentes réelles
  autoState.prefsByDoctor = {};
  (prefs.data || []).forEach(row => {
    const dn = profByUid[row.user_id];
    if (!dn) return;
    autoState.prefsByDoctor[dn] = {
      blockedHMN: row.blocked_hmn || [], blockedACH: row.blocked_ach || [],
      preferSem:  row.prefer_sem  || [], preferWe:   row.prefer_we   || [],
    };
  });
  // Limites + période (défauts si colonnes/données absentes)
  if (sess && sess.data) {
    if (sess.data.max_wished != null)  autoState.maxWished  = sess.data.max_wished;
    if (sess.data.max_indispo != null) autoState.maxIndispo = sess.data.max_indispo;
    if (sess.data.period_start) PERIOD_START = sess.data.period_start;
    if (sess.data.period_end)   PERIOD_END   = sess.data.period_end;
  }
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

// Respect des dates voulues 💙 : une date voulue est "honorée" si le médecin
// est bien de garde ce jour-là dans le planning proposé (sur le site souhaité
// pour wishedHMN/wishedACH, n'importe quel site pour wishedBoth).
function computeWishedRespect() {
  let total = 0, honored = 0;
  const perDoctor = {};
  Object.entries(autoState.voeuxByDoctor).forEach(([name, map]) => {
    Object.entries(map).forEach(([date, v]) => {
      if (!v || !v.startsWith('wished')) return;
      total++;
      if (!perDoctor[name]) perDoctor[name] = { total: 0, honored: 0 };
      perDoctor[name].total++;
      const a = autoState.proposed[date];
      let ok = false;
      if (a) {
        if (v === 'wishedHMN') ok = a.HMN === name;
        else if (v === 'wishedACH') ok = a.ACH === name;
        else ok = (a.HMN === name || a.ACH === name);   // wishedBoth
      }
      if (ok) { honored++; perDoctor[name].honored++; }
    });
  });
  return { total, honored, perDoctor };
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
    else {
      const parts = [];
      if (r.ACH.sem) parts.push(`ACH sem ${r.ACH.sem}`);
      if (r.ACH.we)  parts.push(`ACH WE ${r.ACH.we}`);
      if (r.HMN.sem) parts.push(`HMN sem ${r.HMN.sem}`);
      if (r.HMN.we)  parts.push(`HMN WE ${r.HMN.we}`);
      status = parts.join(' · ');
      color = '#b91c1c'; allOk = false;
    }
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
  // Récap global des objectifs non placés, par site + bucket
  const manque = { ACH: { sem: 0, we: 0 }, HMN: { sem: 0, we: 0 } };
  doctors.forEach(d => {
    const r = rem[d.name];
    manque.ACH.sem += r.ACH.sem; manque.ACH.we += r.ACH.we;
    manque.HMN.sem += r.HMN.sem; manque.HMN.we += r.HMN.we;
  });
  const totalManque = manque.ACH.sem + manque.ACH.we + manque.HMN.sem + manque.HMN.we;
  let manqueHtml = '';
  if (totalManque > 0) {
    const cell = n => n > 0
      ? `<span style="color:#b91c1c;font-weight:700">${n}</span>`
      : `<span style="color:#15803d">0</span>`;
    manqueHtml = `<p style="margin-top:10px">⚠ <strong>Objectifs non placés : ${totalManque}</strong></p>
      <table style="border-collapse:collapse;font-size:12px;margin-top:4px">
        <thead><tr>
          <th style="text-align:left;padding:2px 10px 2px 0"></th>
          <th style="padding:2px 10px">semaine</th><th style="padding:2px 10px">WE+fériés</th>
        </tr></thead><tbody>
        <tr><td style="padding:2px 10px 2px 0"><strong>ACH</strong></td>
          <td style="text-align:center">${cell(manque.ACH.sem)}</td>
          <td style="text-align:center">${cell(manque.ACH.we)}</td></tr>
        <tr><td style="padding:2px 10px 2px 0"><strong>HMN</strong></td>
          <td style="text-align:center">${cell(manque.HMN.sem)}</td>
          <td style="text-align:center">${cell(manque.HMN.we)}</td></tr>
      </tbody></table>`;
  }
  // Respect des dates voulues
  const wr = computeWishedRespect();
  let wishedHtml = '';
  if (wr.total > 0) {
    const pct = Math.round((wr.honored / wr.total) * 100);
    const color = pct >= 80 ? '#15803d' : pct >= 50 ? '#92400e' : '#b91c1c';
    wishedHtml = `<p style="margin-top:10px">💙 <strong>Dates voulues respectées : <span style="color:${color}">${wr.honored}/${wr.total} (${pct}%)</span></strong></p>`;
    const misses = Object.entries(wr.perDoctor).filter(([, s]) => s.honored < s.total);
    if (misses.length) {
      misses.sort((a, b) => (a[1].honored - a[1].total) - (b[1].honored - b[1].total));
      wishedHtml += `<ul style="font-size:12px;color:#7f1d1d;margin:4px 0 0">`;
      misses.forEach(([name, s]) => {
        wishedHtml += `<li>${name} : ${s.honored}/${s.total} respectées</li>`;
      });
      wishedHtml += `</ul>`;
    }
  }
  el.innerHTML = `
    <p><strong>${allOk && !autoState.failures.length ? '✓ Génération réussie' : '⚠ Génération partielle'}</strong> — ${Object.keys(autoState.proposed).length} jours assignés, ${autoState.failures.length} créneau(x) en échec.</p>
    ${manqueHtml}
    ${wishedHtml}
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

  const stats = { totalVacDays: 0, totalScattered: 0, blocksPlaced: 0, blocksFailed: 0, totalWished: 0 };

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

    // Dates voulues fictives (💙) : sur des jours où le médecin a un objectif,
    // jamais sur une de ses indispos, plafonnées au max global.
    const wishMax = autoState.maxWished;
    if (wishMax > 0) {
      const hasSem = (doc.ACH.sem + doc.HMN.sem) > 0;
      const hasWe  = (doc.ACH.we  + doc.HMN.we)  > 0;
      const wishCands = allDates.filter(date => {
        if (fake[doc.name][date]) return false;        // déjà indispo
        return isWE(date) ? hasWe : hasSem;            // bucket cohérent avec ses objectifs
      });
      shuffleInPlace(wishCands, rand);
      const wishCount = Math.min(wishMax, wishCands.length,
        Math.round(wishMax * (0.4 + rand() * 0.6)));   // 40–100% du max
      for (let i = 0; i < wishCount; i++) {
        fake[doc.name][wishCands[i]] = 'wishedBoth';
        stats.totalWished++;
      }
    }
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
      💙 <strong>${stats.totalWished}</strong> dates voulues générées (max ${autoState.maxWished}/médecin).
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
let _editorMode = 'blocked';   // 'blocked' (🚫 indispo) | 'wished' (💙 date voulue)

function countWished(map) {
  return Object.values(map || {}).filter(v => v && v.startsWith('wished')).length;
}

function setEditorMode(mode) {
  _editorMode = mode;
  document.querySelectorAll('.editor-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  const hint = document.getElementById('doctor-editor-hint');
  if (hint) hint.textContent = mode === 'blocked'
    ? 'Clic sur une case = 🚫 indispo (re-clic = annuler).'
    : 'Clic sur une case = 💙 date voulue : le médecin sera privilégié sur cette date si possible (re-clic = annuler).';
}

// Mapping affichage L M M J V S D ↔ Date.getDay() (0=Dim..6=Sam)
const DOW_LABELS = ['L','M','M','J','V','S','D'];
const DOW_GETDAY = [1, 2, 3, 4, 5, 6, 0];   // index → Date.getDay()
const SEM_INDICES = [0,1,2,3,4];   // L,M,M,J,V
const WE_INDICES  = [5,6];          // S,D

function openDoctorEditor(doctorName) {
  _editorDoctor = doctorName;
  const backdrop = document.getElementById('doctor-editor-backdrop');
  document.getElementById('doctor-editor-title').textContent = doctorName;
  setEditorMode('blocked');               // toujours rouvrir en mode indispo
  const maxInput = document.getElementById('wished-max');
  if (maxInput) maxInput.value = autoState.maxWished;
  renderDoctorEditor();
  renderEditorPrefs();
  backdrop.hidden = false;
}

function renderEditorPrefs() {
  if (!_editorDoctor) return;
  const prefs = getPrefs(_editorDoctor);
  // « Pas de garde HMN/ACH le… » sert à orienter vers un site : n'a de sens que
  // pour les médecins qui ont des objectifs sur les DEUX sites.
  const doc = autoState.doctors.find(d => d.name === _editorDoctor);
  const hasBothSites = !!doc
    && (doc.HMN.sem + doc.HMN.we) > 0
    && (doc.ACH.sem + doc.ACH.we) > 0;
  const rows = [
    { key: 'blockedHMN', kind: 'block',  indices: [0,1,2,3,4,5,6], onlyBothSites: true },
    { key: 'blockedACH', kind: 'block',  indices: [0,1,2,3,4,5,6], onlyBothSites: true },
    { key: 'preferSem',  kind: 'prefer', indices: SEM_INDICES },
    { key: 'preferWe',   kind: 'prefer', indices: WE_INDICES },
  ];
  rows.forEach(r => {
    const container = document.querySelector(`.dow-chips[data-pref="${r.key}"]`);
    if (!container) return;
    // Masquer la ligne entière si la préférence ne s'applique pas à ce médecin
    const prefRow = container.closest('.pref-row');
    if (r.onlyBothSites && !hasBothSites) {
      if (prefRow) prefRow.hidden = true;
      if (prefs[r.key].length) prefs[r.key] = [];  // purge une valeur devenue invalide
      container.innerHTML = '';
      return;
    }
    if (prefRow) prefRow.hidden = false;
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
  const wishedCount = countWished(map);
  document.getElementById('doctor-editor-stats').innerHTML =
    `Objectifs : <strong>ACH</strong> ${doc.ACH.sem}sem + ${doc.ACH.we}WE — <strong>HMN</strong> ${doc.HMN.sem}sem + ${doc.HMN.we}WE
     · 🚫 <strong>${blockedCount}</strong> indispo${blockedCount > 1 ? 's' : ''}
     · 💙 <strong>${wishedCount}/${autoState.maxWished}</strong> voulue${wishedCount > 1 ? 's' : ''}`;

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
      else if (map[d] && map[d].startsWith('wished')) cell.classList.add('wished');
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
  const cur = map[date];
  if (_editorMode === 'blocked') {
    if (cur === 'blocked') delete map[date];
    else map[date] = 'blocked';                 // écrase un éventuel vœu (exclusifs)
  } else {                                        // mode 'wished'
    if (cur && cur.startsWith('wished')) {
      delete map[date];
    } else {
      if (countWished(map) >= autoState.maxWished) {
        alert(`Maximum de ${autoState.maxWished} date(s) voulue(s) par médecin atteint.\n\n` +
              `Retire-en une avant d'en ajouter une autre, ou augmente le max global.`);
        return;
      }
      map[date] = 'wishedBoth';                   // écrase une éventuelle indispo (exclusifs)
    }
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

function clearEditorWished() {
  if (!_editorDoctor) return;
  if (!confirm(`Effacer toutes les dates voulues de ${_editorDoctor} ?`)) return;
  const map = autoState.voeuxByDoctor[_editorDoctor] || {};
  Object.keys(map).forEach(date => {
    if (map[date] && map[date].startsWith('wished')) delete map[date];
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

async function saveAutoLimits() {
  const w = parseInt(document.getElementById('limit-wished').value, 10);
  const i = parseInt(document.getElementById('limit-indispo').value, 10);
  if (Number.isFinite(w) && w >= 0) autoState.maxWished = w;
  if (Number.isFinite(i) && i >= 0) autoState.maxIndispo = i;
  const status = document.getElementById('limits-status');
  const { error } = await sb().from('session_state').update({
    max_wished: autoState.maxWished, max_indispo: autoState.maxIndispo,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (status) status.textContent = error ? '⚠ ' + error.message : '✓ Limites enregistrées.';
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
  const lw = document.getElementById('limit-wished'); if (lw) lw.value = autoState.maxWished;
  const li = document.getElementById('limit-indispo'); if (li) li.value = autoState.maxIndispo;
  const apl = document.getElementById('auto-period-label'); if (apl) apl.textContent = periodLabel() + ' — mode algorithme';
  renderObjectivesCheck();
  renderCoverageTable();
  renderAutoCalendar();
  document.getElementById('algo-status').innerHTML = `
    <p><strong>✓ Données chargées.</strong> ${autoState.doctors.length} médecins, ${Object.keys(autoState.voeuxByDoctor).length} ont posé des vœux/indispos.</p>
    <p class="hint">Clique <strong>⚡ Générer le planning</strong> pour lancer l'algorithme.</p>
  `;
}
window.initAutoApp = initAutoApp;

// ============================================================
// PAGE PERSO (médecin) — saisie indispos / dates voulues / préférences
// Persiste : vœux → table `voeux`, préférences → table `preferences`.
// Réutilise les helpers globaux (iterDates, dayType, isWE, DOW_*, …).
// ============================================================
let persoState = {
  myName: null, userId: null,
  objectives: { ACH: { sem: 0, we: 0 }, HMN: { sem: 0, we: 0 } },
  persoVoeux: {},            // COPIE auto (table auto_declarations) — éditable, séparée du Perso
  prefs: { blockedHMN: [], blockedACH: [], preferSem: [], preferWe: [] },
  maxWished: 5, maxIndispo: 30,
  mode: 'blocked',           // 'blocked' 🚫 | 'wished' 💙 (édition directe)
  prefsTableMissing: false,
  declTableMissing: false,   // auto_declarations absente
};

function persoMissTable(err) {
  return err && (err.code === '42P01' || /does not exist/i.test(err.message || ''));
}
function countBlocked(map) { return Object.values(map).filter(v => v === 'blocked').length; }
function countWishedMap(map) { return Object.values(map).filter(v => v && v.startsWith('wished')).length; }

async function initPersoApp() {
  const prof = window.currentProfile;
  if (!prof || !prof.doctor_name) {
    document.querySelector('#perso-root main').innerHTML =
      '<p class="hint" style="padding:20px">Tu dois d\'abord choisir ton nom de médecin dans <a href="../">l\'app principale</a> (à la première connexion), puis revenir ici.</p>';
    return;
  }
  persoState.myName = prof.doctor_name;
  persoState.userId = window.currentUser.id;
  document.getElementById('perso-name').textContent = persoState.myName;
  try {
    const [doc, hols, decl, prefs, sess] = await Promise.all([
      sb().from('doctors').select('*').eq('name', persoState.myName).maybeSingle(),
      sb().from('holidays').select('date'),
      sb().from('auto_declarations').select('*').eq('user_id', persoState.userId),
      sb().from('preferences').select('*').eq('user_id', persoState.userId).maybeSingle(),
      sb().from('session_state').select('max_wished, max_indispo, period_start, period_end').eq('id', 1).maybeSingle(),
    ]);
    if (doc.data) persoState.objectives = {
      ACH: { sem: doc.data.ach_sem | 0, we: doc.data.ach_we | 0 },
      HMN: { sem: doc.data.hmn_sem | 0, we: doc.data.hmn_we | 0 },
    };
    autoState.holidays = (hols.data || []).map(h => h.date);  // pour dayType/isWE partagés
    persoState.persoVoeux = {};
    if (persoMissTable(decl.error)) persoState.declTableMissing = true;
    else (decl.data || []).forEach(r => { persoState.persoVoeux[r.date] = r.voeu; });
    if (persoMissTable(prefs.error)) persoState.prefsTableMissing = true;
    else if (prefs.data) {
      persoState.prefs = {
        blockedHMN: prefs.data.blocked_hmn || [],
        blockedACH: prefs.data.blocked_ach || [],
        preferSem:  prefs.data.prefer_sem  || [],
        preferWe:   prefs.data.prefer_we   || [],
      };
    }
    if (sess && sess.data) {
      if (sess.data.max_wished != null)  persoState.maxWished  = sess.data.max_wished;
      if (sess.data.max_indispo != null) persoState.maxIndispo = sess.data.max_indispo;
      if (sess.data.period_start) PERIOD_START = sess.data.period_start;
      if (sess.data.period_end)   PERIOD_END   = sess.data.period_end;
    }
  } catch (e) { console.error('initPersoApp', e); }
  renderPerso();
}
window.initPersoApp = initPersoApp;

// Bascule entre l'atelier admin et la page médecin (les admins ont les deux)
let _persoInitDone = false;
function showAdminWorkbench() {
  const p = document.getElementById('perso-root'); if (p) p.hidden = true;
  const a = document.getElementById('app-root'); if (a) a.hidden = false;
}
function showPersoPage() {
  const a = document.getElementById('app-root'); if (a) a.hidden = true;
  const p = document.getElementById('perso-root'); if (p) p.hidden = false;
  if (!_persoInitDone) { _persoInitDone = true; initPersoApp(); }
}
window.showAdminWorkbench = showAdminWorkbench;
window.showPersoPage = showPersoPage;

function renderPerso() {
  renderPersoObjectives();
  renderPersoPrefs();
  setPersoMode(persoState.mode);
  renderPersoDecl();
  renderPersoTrim();
}

function setPersoMode(mode) {
  persoState.mode = mode;
  document.querySelectorAll('.perso-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
}

function renderPersoObjectives() {
  const o = persoState.objectives;
  const el = document.getElementById('perso-objectives');
  if (!el) return;
  el.innerHTML = `
    <table style="border-collapse:collapse;font-size:13px">
      <thead><tr><th style="text-align:left;padding:4px 14px 4px 0"></th>
        <th style="padding:4px 14px">semaine</th><th style="padding:4px 14px">WE + fériés</th></tr></thead>
      <tbody>
        <tr><td style="padding:4px 14px 4px 0"><strong>ACH</strong></td>
          <td style="text-align:center">${o.ACH.sem}</td><td style="text-align:center">${o.ACH.we}</td></tr>
        <tr><td style="padding:4px 14px 4px 0"><strong>HMN</strong></td>
          <td style="text-align:center">${o.HMN.sem}</td><td style="text-align:center">${o.HMN.we}</td></tr>
        <tr style="border-top:1px solid var(--border,#e2e8f0);font-weight:700">
          <td style="padding:4px 14px 4px 0">Total</td>
          <td style="text-align:center">${o.ACH.sem + o.HMN.sem}</td>
          <td style="text-align:center">${o.ACH.we + o.HMN.we}</td></tr>
      </tbody>
    </table>`;
}

// --- Déclaration pour le planning auto (modèle synchronisé) --
// Ensemble auto = persoVoeux MOINS les dates exclues.
function persoAutoCounts() {
  let ind = 0, wish = 0;
  Object.entries(persoState.persoVoeux).forEach(([date, v]) => {
    if (v === 'blocked') ind++;
    else if (v && v.startsWith('wished')) wish++;
  });
  return { ind, wish };
}

function renderPersoDecl() {
  const { ind, wish } = persoAutoCounts();
  const info = document.getElementById('perso-decl-info');
  if (info) info.innerHTML =
    `Comptés pour l'auto : <strong>${ind}</strong> indispo(s), <strong>${wish}</strong> vœu(x) ` +
    `(limites : ${persoState.maxIndispo} indispos, ${persoState.maxWished} vœux).`;
  const state = document.getElementById('perso-decl-state');
  if (state) {
    if (persoState.declTableMissing) {
      state.innerHTML = '<span style="color:#b91c1c">⚠ Le planning auto n\'est pas encore activé (table à créer côté admin).</span>';
    } else {
      const within = ind <= persoState.maxIndispo && wish <= persoState.maxWished;
      state.innerHTML = within
        ? '✅ Pris en compte pour le planning auto, dans les limites.'
        : '<span style="color:#b45309">⚠ Hors limites — retire des cases pour rentrer dans les limites.</span>';
    }
  }
}

function renderPersoTrim() {
  const { ind, wish } = persoAutoCounts();
  const indOk = ind <= persoState.maxIndispo, wishOk = wish <= persoState.maxWished;
  const counts = document.getElementById('perso-trim-counts');
  if (counts) counts.innerHTML =
    `Indispos comptées : <strong style="color:${indOk ? '#15803d' : '#b91c1c'}">${ind}/${persoState.maxIndispo}</strong> &nbsp;·&nbsp; ` +
    `Vœux comptés : <strong style="color:${wishOk ? '#15803d' : '#b91c1c'}">${wish}/${persoState.maxWished}</strong>`;
  const validateBtn = document.getElementById('perso-validate-btn');
  if (validateBtn) validateBtn.disabled = !(indOk && wishOk);
  const err = document.getElementById('perso-decl-error');
  if (err) {
    err.hidden = (indOk && wishOk);
    if (!(indOk && wishOk)) {
      const parts = [];
      if (!indOk)  parts.push(`<strong>indispos</strong> : ${ind} pour ${persoState.maxIndispo} max`);
      if (!wishOk) parts.push(`<strong>vœux</strong> : ${wish} pour ${persoState.maxWished} max`);
      err.innerHTML = `⚠ Tu dépasses pour ${parts.join(' et ')}. Désélectionne ${!indOk && !wishOk ? 'des cases' : (!indOk ? 'des indispos' : 'des vœux')} pour pouvoir valider.`;
    }
  }

  const c = document.getElementById('perso-trim-calendar');
  if (!c) return;
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
    const wkEl = document.createElement('div'); wkEl.className = 'weekdays';
    WEEKDAYS_HEADER.forEach(w => { const s = document.createElement('div'); s.textContent = w; wkEl.appendChild(s); });
    monthEl.appendChild(wkEl);
    const daysEl = document.createElement('div'); daysEl.className = 'days';
    const firstDow = (fd.getDay() + 6) % 7;
    for (let i = 0; i < firstDow; i++) { const e = document.createElement('div'); e.className = 'day empty'; daysEl.appendChild(e); }
    m.days.forEach(d => {
      const cell = document.createElement('div');
      cell.className = 'day';
      const t = dayType(d);
      if (t === 'holiday') cell.classList.add('holiday');
      else if (t === 'sunday' || t === 'saturday') cell.classList.add('weekend');
      const dayNum = parseYMD(d).getDate();
      const v = persoState.persoVoeux[d];
      if (v === 'blocked') {
        cell.classList.add('blocked');
        cell.textContent = dayNum;
      } else if (v && v.startsWith('wished')) {
        cell.classList.add('wished');
        const mark = v === 'wishedHMN' ? 'HMN' : v === 'wishedACH' ? 'ACH' : '2 sites';
        cell.innerHTML = `${dayNum}<span class="wish-mark">${mark}</span>`;
      } else {
        cell.textContent = dayNum;
      }
      cell.addEventListener('click', () => persoEditDay(d));
      daysEl.appendChild(cell);
    });
    monthEl.appendChild(daysEl);
    c.appendChild(monthEl);
  });
}

// Édition directe d'une indispo/vœu DANS LA COPIE AUTO (table auto_declarations).
// N'écrit jamais dans `voeux` → ne modifie pas le Perso de l'app principale.
async function persoEditDay(date) {
  if (persoState.declTableMissing) { alert('Planning auto non activé (table manquante côté admin).'); return; }
  const cur = persoState.persoVoeux[date];
  const { ind, wish } = persoAutoCounts();
  let next;
  if (persoState.mode === 'blocked') {
    if (cur === 'blocked') next = null;
    else {
      if (ind >= persoState.maxIndispo) { alert(`Maximum ${persoState.maxIndispo} indispos pour le planning auto.`); return; }
      next = 'blocked';
    }
  } else {
    const o = persoState.objectives;
    const hasBoth = (o.HMN.sem + o.HMN.we) > 0 && (o.ACH.sem + o.ACH.we) > 0;
    const isWished = cur && cur.startsWith('wished');
    if (!isWished) {
      if (wish >= persoState.maxWished) { alert(`Maximum ${persoState.maxWished} dates voulues.`); return; }
      // mono-site : sur son seul site ; bi-site : démarre sur HMN, re-clic pour changer
      next = hasBoth ? 'wishedHMN' : ((o.HMN.sem + o.HMN.we) > 0 ? 'wishedHMN' : 'wishedACH');
    } else if (!hasBoth) {
      next = null;                                   // mono-site : un seul état → retirer
    } else {
      // bi-site : HMN → ACH → les deux → retirer
      next = cur === 'wishedHMN' ? 'wishedACH' : cur === 'wishedACH' ? 'wishedBoth' : null;
    }
  }
  const status = document.getElementById('perso-decl-status');
  let res;
  if (next) {
    persoState.persoVoeux[date] = next;
    res = await sb().from('auto_declarations').upsert({ user_id: persoState.userId, date, voeu: next });
  } else {
    delete persoState.persoVoeux[date];
    res = await sb().from('auto_declarations').delete().eq('user_id', persoState.userId).eq('date', date);
  }
  if (res && res.error && status) status.textContent = '⚠ ' + res.error.message;
  renderPersoTrim();
  renderPersoDecl();
}

function validatePersoDeclaration() {
  if (persoState.declTableMissing) { alert('Planning auto non activé (table manquante côté admin).'); return; }
  const { ind, wish } = persoAutoCounts();
  const status = document.getElementById('perso-decl-status');
  if (ind > persoState.maxIndispo || wish > persoState.maxWished) {
    const parts = [];
    if (ind > persoState.maxIndispo) parts.push(`indispos (max ${persoState.maxIndispo})`);
    if (wish > persoState.maxWished) parts.push(`vœux (max ${persoState.maxWished})`);
    alert(`Encore trop de ${parts.join(' et de ')}. Retire des cases d'abord.`);
    return;
  }
  // Les données sont déjà enregistrées en direct ; ceci confirme juste.
  if (status) status.textContent = '✓ C\'est bon — tes indispos/vœux sont pris en compte pour le planning auto.';
}

function renderPersoPrefs() {
  const missing = document.getElementById('perso-prefs-missing');
  if (missing) {
    missing.hidden = !persoState.prefsTableMissing;
    if (persoState.prefsTableMissing) {
      missing.innerHTML = '⚠ Les préférences ne sont pas encore activées (table à créer côté admin). Tes indispos et dates voulues, elles, sont bien enregistrées.';
    }
  }
  const o = persoState.objectives;
  const hasBoth = (o.HMN.sem + o.HMN.we) > 0 && (o.ACH.sem + o.ACH.we) > 0;
  const rows = [
    { key: 'blockedHMN', kind: 'block',  indices: [0,1,2,3,4,5,6], onlyBoth: true },
    { key: 'blockedACH', kind: 'block',  indices: [0,1,2,3,4,5,6], onlyBoth: true },
    { key: 'preferSem',  kind: 'prefer', indices: SEM_INDICES },
    { key: 'preferWe',   kind: 'prefer', indices: WE_INDICES },
  ];
  rows.forEach(r => {
    const container = document.querySelector(`.dow-chips[data-pref-perso="${r.key}"]`);
    if (!container) return;
    const prefRow = container.closest('.pref-row');
    if (r.onlyBoth && !hasBoth) {
      if (prefRow) prefRow.hidden = true;
      if (persoState.prefs[r.key].length) persoState.prefs[r.key] = [];
      container.innerHTML = '';
      return;
    }
    if (prefRow) prefRow.hidden = false;
    container.innerHTML = '';
    r.indices.forEach(idx => {
      const dow = DOW_GETDAY[idx];
      const chip = document.createElement('div');
      chip.className = 'dow-chip ' + r.kind;
      chip.textContent = DOW_LABELS[idx];
      if (persoState.prefs[r.key].includes(dow)) chip.classList.add('active');
      chip.addEventListener('click', () => {
        const arr = persoState.prefs[r.key];
        const i = arr.indexOf(dow);
        if (i >= 0) arr.splice(i, 1); else arr.push(dow);
        renderPersoPrefs();
        persoSavePrefs();
      });
      container.appendChild(chip);
    });
  });
}

async function persoSavePrefs() {
  if (persoState.prefsTableMissing) return;
  const p = persoState.prefs;
  const s = document.getElementById('perso-save-status');
  const { error } = await sb().from('preferences').upsert({
    user_id: persoState.userId,
    blocked_hmn: p.blockedHMN, blocked_ach: p.blockedACH,
    prefer_sem: p.preferSem, prefer_we: p.preferWe,
    updated_at: new Date().toISOString(),
  });
  if (s) s.textContent = error ? '⚠ Préférences non enregistrées : ' + error.message : '✓ Enregistré.';
}

function bindPersoUI() {
  document.querySelectorAll('.perso-mode-btn').forEach(btn => {
    btn.onclick = () => setPersoMode(btn.dataset.mode);
  });
  const gotoAdmin = document.getElementById('goto-admin-btn');
  if (gotoAdmin) gotoAdmin.onclick = showAdminWorkbench;
  const validateBtn = document.getElementById('perso-validate-btn');
  if (validateBtn) validateBtn.onclick = validatePersoDeclaration;
  const lo = document.getElementById('perso-logout-btn');
  if (lo) lo.onclick = () => { if (typeof logoutAuto === 'function') logoutAuto(); };
}

// Bindings robustes : se font au chargement du DOM, indépendamment du chargement des données
function bindAutoButtons() {
  bindPersoUI();
  // Sous-onglets de l'atelier admin (Génération / Simulation)
  document.querySelectorAll('.subtab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.subtab').forEach(b => b.classList.toggle('active', b === btn));
      const gen = document.getElementById('admin-tab-gen');
      const sim = document.getElementById('admin-tab-sim');
      if (gen) gen.hidden = btn.dataset.subtab !== 'gen';
      if (sim) sim.hidden = btn.dataset.subtab !== 'sim';
    };
  });
  const gotoPerso = document.getElementById('goto-perso-btn');
  if (gotoPerso) gotoPerso.onclick = showPersoPage;
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
  const editorClearWished = document.getElementById('doctor-editor-clear-wished');
  if (editorClearWished) editorClearWished.onclick = clearEditorWished;
  const editorClearPrefs = document.getElementById('doctor-editor-clear-prefs');
  if (editorClearPrefs) editorClearPrefs.onclick = clearEditorPrefs;
  // Sélecteur de mode au clic (🚫 indispo / 💙 date voulue)
  document.querySelectorAll('.editor-mode-btn').forEach(btn => {
    btn.onclick = () => setEditorMode(btn.dataset.mode);
  });
  // Plafond global de dates voulues
  const wishedMax = document.getElementById('wished-max');
  if (wishedMax) wishedMax.onchange = () => {
    const n = parseInt(wishedMax.value, 10);
    autoState.maxWished = Number.isFinite(n) && n >= 0 ? n : 0;
    wishedMax.value = autoState.maxWished;
    if (_editorDoctor) renderDoctorEditor();   // rafraîchir le compteur x/max
  };
  const limitsSaveBtn = document.getElementById('limits-save');
  if (limitsSaveBtn) limitsSaveBtn.onclick = saveAutoLimits;
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
