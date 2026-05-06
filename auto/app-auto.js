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
  proposed: {},  // dateStr -> { HMN: name, ACH: name } généré par l'algo (pas committé)
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
  // Le bouton générer reste désactivé tant que l'algo n'est pas codé
  document.getElementById('algo-status').innerHTML = `
    <p><strong>Données chargées.</strong> ${autoState.doctors.length} médecins, ${Object.keys(autoState.voeuxByDoctor).length} ont posé des vœux/indispos.</p>
    <p class="hint">L'algo de génération sera ajouté dans la prochaine itération. Il prendra en compte : objectifs sem/WE par site, indispos personnelles, contrainte d'adjacence (pas de garde la veille/lendemain), et préférences de vœux.</p>
  `;
}
window.initAutoApp = initAutoApp;
