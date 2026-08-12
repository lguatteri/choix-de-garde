// Médecins et objectifs (juin-sept 2026)
// Source : Objectifs gardes juin 2026.pdf
// ACH = Albert Chenevier, HMN = Henri Mondor
// Vérifier ces chiffres dans l'onglet Réglages avant la séance.
const DOCTORS = [
  { name: "BELFQUIH Oumayma",     ACH: { sem: 4, we: 2 }, HMN: { sem: 2, we: 1 } },
  { name: "BENMANSOUR Safiyah",   ACH: { sem: 3, we: 1 }, HMN: { sem: 1, we: 2 } },
  { name: "BOUKHARI Ghassene",    ACH: { sem: 3, we: 2 }, HMN: { sem: 4, we: 2 } },
  { name: "BOUZAABIA Zeineb",     ACH: { sem: 3, we: 2 }, HMN: { sem: 4, we: 1 } },
  { name: "CHABERT Jonathan",     ACH: { sem: 2, we: 1 }, HMN: { sem: 2, we: 1 } },
  { name: "FERCHIOU Aziz",        ACH: { sem: 5, we: 0 }, HMN: { sem: 0, we: 0 } },
  { name: "GERENTES Mona",        ACH: { sem: 0, we: 0 }, HMN: { sem: 6, we: 3 } },
  { name: "GERVOT Cyrielle",      ACH: { sem: 0, we: 0 }, HMN: { sem: 4, we: 3 } },
  { name: "GUATTERI Laura",       ACH: { sem: 3, we: 2 }, HMN: { sem: 4, we: 1 } },
  { name: "HOTIER Sevan",         ACH: { sem: 2, we: 2 }, HMN: { sem: 2, we: 0 } },
  { name: "JAGARAJ Praveen",      ACH: { sem: 3, we: 1 }, HMN: { sem: 2, we: 0 } },
  { name: "JEANNIN Juliette",     ACH: { sem: 0, we: 0 }, HMN: { sem: 7, we: 4 } },
  { name: "KABA Zuleyha",         ACH: { sem: 4, we: 2 }, HMN: { sem: 3, we: 2 } },
  { name: "LADEA Maria",          ACH: { sem: 5, we: 1 }, HMN: { sem: 0, we: 0 } },
  { name: "LAIDI Charles",        ACH: { sem: 3, we: 2 }, HMN: { sem: 1, we: 0 } },
  { name: "LANGRENNE Clémentine", ACH: { sem: 4, we: 2 }, HMN: { sem: 3, we: 2 } },
  { name: "LORIC Marie",          ACH: { sem: 0, we: 0 }, HMN: { sem: 5, we: 2 } },
  { name: "MACONE Alexandre",     ACH: { sem: 4, we: 2 }, HMN: { sem: 2, we: 1 } },
  { name: "NEU Nathan",           ACH: { sem: 4, we: 2 }, HMN: { sem: 3, we: 2 } },
  { name: "NKAM Irène",           ACH: { sem: 5, we: 0 }, HMN: { sem: 0, we: 0 } },
  { name: "OUCHIHA Lilia",        ACH: { sem: 0, we: 0 }, HMN: { sem: 7, we: 4 } },
  { name: "PIGNON Baptiste",      ACH: { sem: 3, we: 1 }, HMN: { sem: 2, we: 0 } },
  { name: "POPA Daniela",         ACH: { sem: 4, we: 1 }, HMN: { sem: 2, we: 0 } },
  { name: "RABU Corentin",        ACH: { sem: 0, we: 0 }, HMN: { sem: 3, we: 2 } },
  { name: "SAHNOUN Chema",        ACH: { sem: 5, we: 1 }, HMN: { sem: 0, we: 0 } },
  { name: "SANDRONI Veronica",    ACH: { sem: 4, we: 2 }, HMN: { sem: 3, we: 2 } },
  { name: "SAYOUS Romain",        ACH: { sem: 2, we: 0 }, HMN: { sem: 5, we: 2 } },
  { name: "SZOKE Andrei",         ACH: { sem: 5, we: 0 }, HMN: { sem: 0, we: 0 } },
  { name: "ZAGHBIB Karim",        ACH: { sem: 0, we: 0 }, HMN: { sem: 5, we: 0 } },
  { name: "ZERDAZI El-Hadi",      ACH: { sem: 0, we: 1 }, HMN: { sem: 5, we: 0 } },
].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

// Période (valeurs par défaut ; écrasées par session_state au chargement)
let PERIOD_START = "2026-06-01";
let PERIOD_END   = "2026-09-30";

// Vrai si la date (YYYY-MM-DD) appartient au quadrimestre courant. Les
// enregistrements (assignations/vœux/indispos) hors de cette fenêtre ne sont
// pas comptés : changer de quadrimestre remet objectifs/vœux/indispos à zéro.
function inPeriod(dateStr) { return dateStr >= PERIOD_START && dateStr <= PERIOD_END; }

// Jours fériés dans la période (FR métropole)
const HOLIDAYS = [
  "2026-07-14", // Fête nationale (mardi)
  "2026-08-15", // Assomption (samedi)
];
