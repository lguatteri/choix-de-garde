'use strict';

// ============================================================
// App Auto-distribution — chargement données + affichage
// (algo de génération à venir)
// ============================================================

const sb = () => window.supabaseClient;

const PERIOD_START = '2026-06-01';
const PERIOD_END   = '2026-09-30';
const MONTHS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const WEEKDAYS_HEADER = ['L','M','M','J','V','S','D'];

let autoState = {
  doctors: [],
  holidays: [],
  voeuxByDoctor: {},
  proposed: {},      // dateStr -> { HMN: name, ACH: name }
  failures: [],      // [{ date, site, reason }]
  remainingAfter: {}, // doctorName -> { ACH:{sem,we}, HMN:{sem,we} } restants après gen
};

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
      <td><strong>${d.name}</strong></td>
      <td>${d.ACH.sem}</td><td>${d.ACH.we}</td>
      <td>${d.HMN.sem}</td><td>${d.HMN.we}</td>
      <td>${nVoeux}</td><td>${nBlocked}</td>
      <td>${badge}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  t.innerHTML = html;
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
      // Diagnostic : pourquoi ?
      const reasons = [];
      autoState.doctors.forEach(d => {
        const r = rem[d.name];
        const b = bucketOf(slot.date);
        if (r[slot.site][b] <= 0) return;
        if ((autoState.voeuxByDoctor[d.name] || {})[slot.date] === 'blocked') return;
        reasons.push(d.name + ' (adjacence)');
      });
      failures.push({
        date: slot.date,
        site: slot.site,
        reason: reasons.length === 0
          ? 'Aucun médecin avec objectif restant et non bloqué'
          : 'Tous bloqués par contrainte d\'adjacence',
      });
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

async function commitToMainPlanning() {
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
  renderCoverageTable();
  renderAutoCalendar();
  document.getElementById('reload-btn').onclick = () => location.reload();
  const genBtn = document.getElementById('generate-btn');
  genBtn.disabled = false;
  genBtn.title = '';
  genBtn.onclick = () => {
    document.getElementById('algo-status').innerHTML = '<p>⏳ Génération en cours…</p>';
    setTimeout(() => {
      try {
        generatePlanning();
        renderProposedCalendar();
        renderAlgoStatus();
        // Ajout d'un bouton commit s'il n'existe pas
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
        document.getElementById('algo-status').innerHTML = `<p style="color:#b91c1c">Erreur algo : ${e.message}</p>`;
      }
    }, 30); // léger délai pour laisser l'UI mettre à jour
  };
  document.getElementById('algo-status').innerHTML = `
    <p><strong>Données chargées.</strong> ${autoState.doctors.length} médecins, ${Object.keys(autoState.voeuxByDoctor).length} ont posé des vœux/indispos.</p>
    <p class="hint">Clique <strong>⚡ Générer le planning</strong> pour lancer l'algorithme.</p>
  `;
}
window.initAutoApp = initAutoApp;
