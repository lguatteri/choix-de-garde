// ================= Harnais de simulation du CHOIX ASSISTÉ =================
// Neutralise les effets de bord DB/rendu
var _syncSessionCalls = 0;
syncSite = async function(){};
syncSession = async function(){ _syncSessionCalls++; };
syncVoeu = async function(){};
render = function(){};

// Période de test : ~4 mois
PERIOD_START = '2026-06-01';
PERIOD_END   = '2026-09-30';
state.holidays = [];

// 30 médecins fictifs : mix mono / double-site, objectifs sem + we
var rng = (function(){ var a=987654321>>>0; return function(){ a=(a+0x6D2B79F5)>>>0; var t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; })();
function ri(n){ return Math.floor(rng()*n); }
var docs=[];
for (var i=0;i<30;i++){
  var mode = ri(3); // 0=double,1=HMN only,2=ACH only
  var HMN = { sem: (mode===2?0:1+ri(3)), we:(mode===2?0:ri(2)) };
  var ACH = { sem: (mode===1?0:1+ri(3)), we:(mode===1?0:ri(2)) };
  if (HMN.sem+HMN.we+ACH.sem+ACH.we===0) HMN.sem=2;
  docs.push({ name:'Dr'+(i<10?'0':'')+i, HMN:HMN, ACH:ACH });
}
state.doctors = docs.sort((a,b)=>a.name.localeCompare(b.name));
state.allVoeux = {};
// quelques indispos aléatoires (≈4/médecin) pour créer des contraintes réalistes
var allDates=[...iterDates(PERIOD_START,PERIOD_END)];
docs.forEach(d=>{ var m={}; for(var k=0;k<4;k++){ m[allDates[ri(allDates.length)]]='blocked'; } state.allVoeux[d.name]=m; });

// Init du tour
state.currentTour=1; state.tourStartIdx=ri(30); state.tourDirection=1;
state.pickerCursor=0; state.currentTurnSlots=[]; state.currentTurnPickCount=0;
state.returnCursor=null; state.manualPick=null; state.forcedNextPicker=null; state.neutralView=false;
state.assignments={}; state.history=[];

// ---- helpers de la simulation ----
function freeSitesFor(name,date){
  var d=findDoctor(name), a=state.assignments[date]||{}, elig=eligibleSites(d), r=objectivesRemaining(d), b=objectiveBucket(date);
  return elig.filter(s=>!a[s] && r[s][b]>0);
}
function suggestedDatesFor(name){ return allDates.filter(dt=>isDateSuggestedFor(name,dt)); }

// ---- BUG 2 : détecter « on ne propose que des WE alors qu'une semaine est prenable » ----
var bug2Violations=0, bug2Examples=[];
function checkBug2(name){
  var d=findDoctor(name), r=objectivesRemaining(d);
  var rem=getRemainingTurnQuota(name).remaining;
  var semObj = r.HMN.sem + r.ACH.sem;                 // objectifs semaine restants
  var quotaAllowsWeekday = (rem.semaine||0)>0 || (rem.vendredi||0)>0 || (rem.libre||0)>0;
  if (semObj<=0 || !quotaAllowsWeekday) return;       // pas censé prendre une semaine ce tour
  // existe-t-il un créneau semaine/vendredi libre et éligible avec objectif ?
  var weekdayTakeable = allDates.some(dt=>{ var t=tourSlotType(dt); if(t==='we') return false;
    if((state.allVoeux[name]||{})[dt]==='blocked') return false;
    if(hasGardeOnOrNearby(name,dt)) return false;
    return freeSitesFor(name,dt).length>0; });
  if (!weekdayTakeable) return;
  // alors AU MOINS une date suggérée doit être un jour de semaine/vendredi
  var sugg = suggestedDatesFor(name);
  var anyWeekdaySuggested = sugg.some(dt=>tourSlotType(dt)!=='we');
  if (!anyWeekdaySuggested && sugg.length>0){
    bug2Violations++;
    if (bug2Examples.length<5) bug2Examples.push(name+' tour'+state.currentTour+' : '+sugg.length+' suggérées, toutes WE, alors qu\'une semaine était prenable');
  }
}

// ---- boucle principale : dérouler tous les tours ----
var picks=0, tours=1, guard=200000, notSuggestedPick=0, maxTours=60;
while (guard-->0){
  var cur = currentPickerInfo();
  if (!cur){
    // fin de tour : tout le monde a fini ce tour
    var anyLeft = state.doctors.some(d=>objectivesRemaining(d).total>0);
    if (!anyLeft) break;
    advanceTour(); tours++;
    if (tours>maxTours){ print('!! STOP : trop de tours ('+tours+') — curseur probablement bloqué'); break; }
    continue;
  }
  checkBug2(cur.name);
  var sugg = suggestedDatesFor(cur.name);
  if (sugg.length===0){
    // ce choisisseur ne peut rien prendre ce tour → l'admin le passe
    state.pickerCursor = cur.cursor+1; state.currentTurnSlots=[]; state.currentTurnPickCount=0; state.manualPick=null;
    continue;
  }
  // le picker prend la 1re date suggérée (invariant : elle DOIT être suggérée)
  var dt = sugg[0]; var sites = freeSitesFor(cur.name, dt);
  if (sites.length===0){ notSuggestedPick++; state.pickerCursor=cur.cursor+1; state.currentTurnSlots=[]; state.currentTurnPickCount=0; continue; }
  if (!isDateSuggestedFor(cur.name, dt)) notSuggestedPick++;
  setAssignment(dt, sites[0], cur.name, null);
  picks++;
}

// ---- bilan ----
var unmet=0, doneCount=0;
state.doctors.forEach(d=>{ var t=objectivesRemaining(d).total; unmet+=Math.max(0,t); if(t<=0) doneCount++; });
var totalObj = docs.reduce((s,d)=>s+d.HMN.sem+d.HMN.we+d.ACH.sem+d.ACH.we,0);
print('=== SIMULATION CHOIX ASSISTÉ (30 médecins) ===');
print('Objectifs totaux:', totalObj, '| picks effectués:', picks, '| tours utilisés:', tours);
print('Médecins avec objectifs atteints:', doneCount+'/30', '| objectifs non placés:', unmet);
print('Picks non-suggérés (devrait être 0):', notSuggestedPick);
print('BUG 2 (que des WE alors qu\'une semaine prenable) — violations:', bug2Violations);
bug2Examples.forEach(e=>print('   • '+e));

// ================= TESTS UNITAIRES BUG 3 =================
print('\n=== BUG 3 ===');
// (a) MODE LIBRE gèle le tour : setAssignment ne bouge pas le curseur ni ne push session
state.neutralView=true;
// trouver une date libre pour un médecin
var dLibre = state.doctors[3].name;
var freeDate = allDates.find(dt=>freeSitesFor(dLibre,dt).length>0) || allDates[0];
var siteLibre = (freeSitesFor(dLibre,freeDate)[0])||'HMN';
var cursorBefore = state.pickerCursor, tourBefore = state.currentTour; _syncSessionCalls=0;
setAssignment(freeDate, siteLibre, dLibre, null);
print('mode libre → curseur inchangé:', state.pickerCursor===cursorBefore, '| tour inchangé:', state.currentTour===tourBefore, '| session NON poussée:', _syncSessionCalls===0);
state.neutralView=false;

// (b) returnCursor : retour en arrière → advance revient au front
// État FRAIS (assignments vides → tout le monde a encore des objectifs, donc le
// front s'arrête bien à sa place au lieu de sauter les gens « finis »).
state.assignments={}; state.history=[];
state.currentTour=2; state.tourStartIdx=0; state.tourDirection=1; state.returnCursor=null; state.manualPick=null;
state.pickerCursor=8; state.currentTurnSlots=[]; state.currentTurnPickCount=0;
var backDoc = pickerAt(3).name;                 // quelqu'un derrière le front (cursor 3 < 8)
setCurrentPickerManually(backDoc);
var okBack = (state.pickerCursor===3 && state.returnCursor===8);
// on simule que ce médecin a fini son tour → advance doit sauter au front (8)
state.currentTurnPickCount = quotaSum(findDoctor(backDoc), state.currentTour);
advanceCursorIfNeeded();
var okReturn = (state.pickerCursor===8 && state.returnCursor===null);
print('retour arrière mémorise le front:', okBack, '| après correction, revient au front:', okReturn);
