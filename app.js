/* TriTrack — offline marathon & Ironman training companion */
"use strict";

/* ============================== Utils ============================== */

const $ = (sel) => document.querySelector(sel);
const DAY = 86400000;

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now());

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtDur(secs) {
  secs = Math.max(0, Math.round(secs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const fmtKM = (km) => (km === Math.round(km) ? `${km} km` : `${km.toFixed(1)} km`);

const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

const fmtDateLong = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function toLocalDT(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toLocalDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const SPORTS = {
  run: { label: "Run", emoji: "🏃", hex: "#ff9440" },
  bike: { label: "Bike", emoji: "🚴", hex: "#4dd9e6" },
  swim: { label: "Swim", emoji: "🏊", hex: "#669eff" },
  strength: { label: "Strength", emoji: "🏋️", hex: "#c28cff" },
  rest: { label: "Hvile", emoji: "😴", hex: "#8a8a98" },
};

const CATEGORIES = ["Legs", "Push", "Pull", "Core", "Full Body", "Mobility", "Other"];

/* The app's default backend (Cloudflare Worker) — powers one-tap Strava connect
   and the AI coach for every user. Each user still authorizes their own Strava
   account; the backend never mixes people's data. Overridable in Coach → ⚙. */
const DEFAULT_WORKER_URL = "https://tritrack-strava.hehaaberhassing.workers.dev";

function sportIcon(sport, size = 38) {
  const s = SPORTS[sport] || SPORTS.run;
  return `<div class="sport-ico" style="width:${size}px;height:${size}px;background:${s.hex}2b">${s.emoji}</div>`;
}

function paceText(c) {
  if (!c.distanceKM || !c.durationSeconds) return "—";
  const pace = c.durationSeconds / c.distanceKM;
  if (c.sport === "bike") return (c.distanceKM / (c.durationSeconds / 3600)).toFixed(1) + " km/h";
  if (c.sport === "swim") return fmtDur(pace / 10) + " /100m";
  return fmtDur(pace) + " /km";
}

/* ============================== Store (multi-profile) ==============================
   Each person who uses this browser gets their own profile. Data lives only in
   this device's localStorage and is never uploaded — so on someone else's phone
   or laptop they automatically see only their own data. Profiles add separation
   when several people share ONE browser. */

const LEGACY_KEY = "tritrack-data";          // single-profile key from before profiles existed
const PROFILES_KEY = "tritrack:profiles";    // [{ id, name }]
const CURRENT_KEY = "tritrack:current";       // active profile id
const dataKey = (id) => `tritrack:data:${id}`;

let state = null;
let profiles = [];
let currentId = null;

const currentProfile = () => profiles.find((p) => p.id === currentId) || profiles[0];

function save() {
  if (currentId) localStorage.setItem(dataKey(currentId), JSON.stringify(state));
}

function saveProfiles() {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  localStorage.setItem(CURRENT_KEY, currentId);
}

/* Keep older saves working: refresh the plan to the personal program without
   touching logged runs/workouts. */
function migratePlan(snap) {
  if (snap.planMeta) return snap; // a coach/AI-built plan is personal — never overwrite it
  if (!snap.planVersion || snap.planVersion < PLAN_VERSION) {
    snap.plan = generatePlan();
    snap.planStartDate = PLAN_START_DEFAULT;
    snap.planVersion = PLAN_VERSION;
  }
  return snap;
}

function readData(id) {
  try {
    const raw = localStorage.getItem(dataKey(id));
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !Array.isArray(snap.exercises)) return null;
    return migratePlan(snap);
  } catch {
    return null;
  }
}

function initProfiles() {
  try {
    const rawProfiles = localStorage.getItem(PROFILES_KEY);
    if (rawProfiles) {
      profiles = JSON.parse(rawProfiles) || [];
      currentId = localStorage.getItem(CURRENT_KEY);
      if (!profiles.length) profiles = [{ id: uid(), name: "Me" }];
      if (!currentId || !profiles.some((p) => p.id === currentId)) currentId = profiles[0].id;
      state = readData(currentId) || seed();
    } else {
      // First launch on the profile-aware version: adopt any pre-existing
      // single-profile data so nothing is lost.
      const id = uid();
      profiles = [{ id, name: "Me" }];
      currentId = id;
      let legacy = null;
      try {
        const raw = localStorage.getItem(LEGACY_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          if (s && Array.isArray(s.exercises)) legacy = migratePlan(s);
        }
      } catch {}
      state = legacy || seed();
    }
  } catch {
    const id = uid();
    profiles = [{ id, name: "Me" }];
    currentId = id;
    state = seed();
  }
  save();
  saveProfiles();
}

/* ============================== Training plan ============================== */
/* The user's detailed 20-week marathon program: 3 run + 3 strength + 1 rest per
   week. BACK-SAFE — Wed "Legs + core" uses unilateral/supported moves (goblet
   squat, split squat, step-up, hip thrust) instead of axially loading Squat/RDL,
   until the chiropractor clears heavier spinal loading. Phases: Opbygning (home
   gym, wks 1–9) → Specifik (traveling, bodyweight/band, 10–15) → Top (16–18) →
   Nedtrapning (taper + race, 19–20). Working goal 3:45. Plan starts Mon 15 Jun
   2026; race day Sun 1 Nov 2026. */

const PLAN_START_DEFAULT = new Date(2026, 5, 15).getTime(); // Mon 15 Jun 2026
const PLAN_VERSION = 3;

function phase(week) {
  if (week <= 9) return "Opbygning";
  if (week <= 15) return "Specifik";
  if (week <= 18) return "Top";
  return "Nedtrapning";
}

const PHASE_COLORS = { Opbygning: "#5ce6b8", Specifik: "#ff9440", Top: "#ff5a5a", Nedtrapning: "#669eff" };

/* Weekly running volume targets (km) */
const WEEK_KM = [20, 23, 26, 22, 28, 32, 36, 30, 38, 38, 42, 34, 44, 48, 40, 50, 55, 38, 28, 12];

/* Strength templates — home (full gym) and travel (bodyweight/band). */
const PUSH_HOME = "Bænkpres 4x8, Incline DB press 3x10, Skulder DB press 3x10, Lateral raises 3x12, Triceps pushdown 3x12, Face pulls 3x15";
const PULL_HOME = "Pull-ups/lat pulldown 4x8, Rows 3x10, Seated cable row 3x12, Bicep curl 3x12, Hammer curl 3x12, Rear delt fly 3x15";
const LEGS_HOME = "Goblet squat 4x10, Bulgarian split squat 3x10/side, Step-up 3x10/side, Hip thrust 3x12, Dead bug 3x12, Bird-dog 3x10/side";
const PUSH_TRAVEL = "Push-ups 4x12, Incline push-ups 3x12, Pike push-ups 3x10, Diamond push-ups 3x10, Dips 3x12, Band face pulls 3x15";
const PULL_TRAVEL = "Pull-ups el. band rows 4x10, Inverted rows 3x10, Band bicep curl 3x12, Band rear delt fly 3x15";
const LEGS_TRAVEL = "Goblet squat (rygsæk) 4x12, Bulgarian split squat 3x12/side, Step-up 3x12/side, Glute bridge 3x15, Dead bug 3x12, Bird-dog 3x10/side";
const DL = " — deload: −1 sæt hver";
const LT = " — let: −1 sæt hver";

/* [day 1-7, sport, title, detail] per week */
const PLAN_WEEKS = [
  /* Uge 1 – OPBYGNING · 20 km */ [
    [1, "strength", "Push", PUSH_HOME],
    [2, "run", "Easy run · 5 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core", LEGS_HOME],
    [4, "run", "Intervaller", "400m x8 (jog 200m mellem) – ca. 7 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull", PULL_HOME],
    [7, "run", "Long run · 8 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 2 – OPBYGNING · 23 km */ [
    [1, "strength", "Push", PUSH_HOME],
    [2, "run", "Easy run · 6 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core", LEGS_HOME],
    [4, "run", "Intervaller", "600m x6 (jog 200m mellem) – ca. 8 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull", PULL_HOME],
    [7, "run", "Long run · 9 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 3 – OPBYGNING · 26 km */ [
    [1, "strength", "Push", PUSH_HOME],
    [2, "run", "Easy run · 7 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core", LEGS_HOME],
    [4, "run", "Intervaller", "800m x6 (jog 300m mellem) – ca. 9 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull", PULL_HOME],
    [7, "run", "Long run · 10 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 4 – OPBYGNING (deload) · 22 km */ [
    [1, "strength", "Push (deload)", PUSH_HOME + DL],
    [2, "run", "Easy run · 6 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (deload)", LEGS_HOME + DL],
    [4, "run", "Rolig løb + stigninger", "7 km + 4x20 sek. stigninger"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (deload)", PULL_HOME + DL],
    [7, "run", "Long run · 9 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 5 – OPBYGNING · 28 km */ [
    [1, "strength", "Push", PUSH_HOME],
    [2, "run", "Easy run · 8 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core", LEGS_HOME],
    [4, "run", "Tempo", "2km opvarmning + 10 min @ 4:50–5:00/km + 2km nedkøling – ca. 9 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull", PULL_HOME],
    [7, "run", "Long run · 11 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 6 – OPBYGNING · 32 km */ [
    [1, "strength", "Push", PUSH_HOME],
    [2, "run", "Easy run · 9 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core", LEGS_HOME],
    [4, "run", "Tempo", "2km opvarmning + 15 min @ 4:50–5:00/km + 2km nedkøling – ca. 10 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull", PULL_HOME],
    [7, "run", "Long run · 13 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 7 – OPBYGNING · 36 km */ [
    [1, "strength", "Push", PUSH_HOME],
    [2, "run", "Easy run · 10 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core", LEGS_HOME],
    [4, "run", "Tempo", "2km opvarmning + 20 min @ 4:50–5:00/km + 2km nedkøling – ca. 12 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull", PULL_HOME],
    [7, "run", "Long run · 14 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 8 – OPBYGNING (deload) · 30 km */ [
    [1, "strength", "Push (deload)", PUSH_HOME + DL],
    [2, "run", "Easy run · 9 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (deload)", LEGS_HOME + DL],
    [4, "run", "Rolig løb + stigninger", "10 km + 4x20 sek. stigninger"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (deload)", PULL_HOME + DL],
    [7, "run", "Long run · 11 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 9 – OPBYGNING · 38 km */ [
    [1, "strength", "Push", "⚠ Kiropraktor-tjek før afgang denne uge. " + PUSH_HOME],
    [2, "run", "Easy run · 10 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core", LEGS_HOME],
    [4, "run", "Tempo", "2km opvarmning + 20 min @ 4:50–5:00/km + 2km nedkøling – ca. 12 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull", PULL_HOME],
    [7, "run", "Long run · 16 km", "Roligt og kontrolleret (5:50–6:15/km)"],
  ],
  /* Uge 10 – SPECIFIK · 38 km (rejse starter) */ [
    [1, "strength", "Push (rejse)", PUSH_TRAVEL],
    [2, "run", "Easy run · 10 km", "Samtale-tempo — løb efter fornemmelse i varmen"],
    [3, "strength", "Legs + core (rejse)", LEGS_TRAVEL],
    [4, "run", "Rolig løb", "12 km — tilpas til varme/jetlag"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse)", PULL_TRAVEL],
    [7, "run", "Long run · 16 km", "Roligt og kontrolleret — opdel ruten hvis nødvendigt"],
  ],
  /* Uge 11 – SPECIFIK · 42 km */ [
    [1, "strength", "Push (rejse)", PUSH_TRAVEL],
    [2, "run", "Easy run · 11 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse)", LEGS_TRAVEL],
    [4, "run", "Fartlek", "6 x 3 min hurtigt / 2 min roligt – ca. 13 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse)", PULL_TRAVEL],
    [7, "run", "Long run · 18 km", "Roligt og kontrolleret"],
  ],
  /* Uge 12 – SPECIFIK (deload/rejse-reset) · 34 km */ [
    [1, "strength", "Push (rejse, deload)", PUSH_TRAVEL + DL],
    [2, "run", "Easy run · 10 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse, deload)", LEGS_TRAVEL + DL],
    [4, "run", "Rolig løb", "10 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse, deload)", PULL_TRAVEL + DL],
    [7, "run", "Long run · 14 km", "Roligt og kontrolleret"],
  ],
  /* Uge 13 – SPECIFIK · 44 km */ [
    [1, "strength", "Push (rejse)", PUSH_TRAVEL],
    [2, "run", "Easy run · 11 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse)", LEGS_TRAVEL],
    [4, "run", "MP-intervaller", "2km opvarmning + 3x10 min @ 5:10–5:25/km (jog 2 min mellem) + 2km nedkøling – ca. 13 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse)", PULL_TRAVEL],
    [7, "run", "Long run · 20 km", "Roligt og kontrolleret"],
  ],
  /* Uge 14 – SPECIFIK · 48 km */ [
    [1, "strength", "Push (rejse)", PUSH_TRAVEL],
    [2, "run", "Easy run · 12 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse)", LEGS_TRAVEL],
    [4, "run", "Tempo", "2km opvarmning + 25 min @ 4:50–5:00/km + 2km nedkøling – ca. 14 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse)", PULL_TRAVEL],
    [7, "run", "Long run · 22 km", "Roligt og kontrolleret"],
  ],
  /* Uge 15 – SPECIFIK (deload) · 40 km */ [
    [1, "strength", "Push (rejse, deload)", PUSH_TRAVEL + DL],
    [2, "run", "Easy run · 12 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse, deload)", LEGS_TRAVEL + DL],
    [4, "run", "Rolig løb", "12 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse, deload)", PULL_TRAVEL + DL],
    [7, "run", "Long run · 16 km", "Roligt og kontrolleret"],
  ],
  /* Uge 16 – TOP · 50 km */ [
    [1, "strength", "Push (rejse)", "⚠ Kiropraktor-tjek før peak-load. " + PUSH_TRAVEL],
    [2, "run", "Easy run · 11 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse)", LEGS_TRAVEL],
    [4, "run", "MP-intervaller", "2km opvarmning + 3x10 min @ 5:10–5:25/km + 2km nedkøling – ca. 13 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse)", PULL_TRAVEL],
    [7, "run", "Long run · 26 km", "Roligt — sidste 5 km @ maratontempo (5:10–5:25/km)"],
  ],
  /* Uge 17 – TOP (længste uge) · 55 km */ [
    [1, "strength", "Push (rejse)", PUSH_TRAVEL],
    [2, "run", "Easy run · 12 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse)", LEGS_TRAVEL],
    [4, "run", "MP-intervaller", "2km opvarmning + 3x12 min @ 5:10–5:25/km + 2km nedkøling – ca. 14 km"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse)", PULL_TRAVEL],
    [7, "run", "Long run · 29 km ⭐", "Længste løb. Roligt — sidste 8 km @ maratontempo (5:10–5:25/km)"],
  ],
  /* Uge 18 – TOP→NEDTRAPNING · 38 km */ [
    [1, "strength", "Push (rejse, let)", PUSH_TRAVEL + LT],
    [2, "run", "Easy run · 10 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "strength", "Legs + core (rejse, let)", LEGS_TRAVEL + LT],
    [4, "run", "Let løb + MP-berøring", "10 km, inkl. 4x3 min @ maratontempo"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (rejse, let)", PULL_TRAVEL + LT],
    [7, "run", "Long run · 18 km", "Roligt — sidste 3 km @ maratontempo"],
  ],
  /* Uge 19 – NEDTRAPNING · 28 km (Legs+core på pause) */ [
    [1, "strength", "Push (let)", "Samme øvelser som tidligere, −1 sæt hver"],
    [2, "run", "Easy run · 8 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "rest", "Hvile", "Ekstra restitution før taper — Legs + core på pause denne uge"],
    [4, "run", "Let løb + skarphed", "8 km, inkl. 4x20 sek. @ maratontempo"],
    [5, "rest", "Hvile", "Aktiv restitution eller total hvile"],
    [6, "strength", "Pull (let)", "Samme øvelser som tidligere, −1 sæt hver"],
    [7, "run", "Long run · 12 km", "Roligt og kontrolleret"],
  ],
  /* Uge 20 – NEDTRAPNING · RACE WEEK */ [
    [1, "strength", "Push (meget let)", "Samme øvelser, halvt volumen, kun let belastning"],
    [2, "run", "Easy run · 5 km", "Samtale-tempo (5:55–6:20/km)"],
    [3, "rest", "Hvile", "Total hvile"],
    [4, "run", "Easy run · 4 km", "Inkl. 4x20 sek. stigninger"],
    [5, "rest", "Hvile", "Total hvile"],
    [6, "run", "Shakeout · 3 km", "Let jog + mobilitet, lige ud af benene"],
    [7, "run", "🏁 RACE DAY — Marathon 42,2 km", "Maratontempo (5:10–5:25/km), start 30–60 sek/km langsommere de første 5 km. Nyd det!"],
  ],
];

function generatePlan() {
  const out = [];
  PLAN_WEEKS.forEach((days, i) => {
    for (const [day, sport, title, detail] of days) {
      out.push({ id: uid(), week: i + 1, day, title, detail, sport, completed: false });
    }
  });
  return out;
}

/* ============================== Derived metrics ============================== */

/* A coach/AI-built plan (state.planMeta) can replace the built-in 20-week
   marathon program — these helpers answer plan questions for either. */

const PHASE_PALETTE = ["#5ce6b8", "#ff9440", "#ff5a5a", "#669eff", "#c28cff", "#4dd9e6"];

function planWeeks() { return state.planMeta ? state.planMeta.weeks : 20; }
function planGoalLabel() { return state.planMeta ? state.planMeta.goalLabel : "Marathon"; }

function planPhaseAt(week) {
  const m = state.planMeta;
  if (m && Array.isArray(m.phases) && m.phases.length) {
    const p = m.phases.find((p) => week >= p.from && week <= p.to);
    return (p || m.phases[m.phases.length - 1]).name;
  }
  return phase(week);
}

function planPhaseColorAt(week) {
  const m = state.planMeta;
  if (m && Array.isArray(m.phases) && m.phases.length) {
    let i = m.phases.findIndex((p) => week >= p.from && week <= p.to);
    if (i < 0) i = m.phases.length - 1;
    return m.phases[i].color || PHASE_PALETTE[i % PHASE_PALETTE.length];
  }
  return PHASE_COLORS[phase(week)];
}

function planWeekKMAt(week) {
  const m = state.planMeta;
  if (m) return Array.isArray(m.weekKM) && m.weekKM[week - 1] != null ? Math.round(m.weekKM[week - 1]) : null;
  return WEEK_KM[week - 1];
}

function currentPlanWeek() {
  // Math.round absorbs the ±1h drift when a DST change falls inside the range
  const days = Math.round((startOfDay(Date.now()) - startOfDay(state.planStartDate)) / DAY);
  return Math.min(planWeeks(), Math.max(1, Math.floor(days / 7) + 1));
}

const raceDate = () => {
  const d = new Date(state.planStartDate);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + planWeeks() * 7 - 1); // calendar-day add is DST-safe
  return d.getTime();
};
const daysToRace = () => Math.max(0, Math.round((raceDate() - startOfDay(Date.now())) / DAY));

function trainingLoads() {
  const items = state.cardio.map((c) => ({ date: c.date, load: (c.durationSeconds / 60) * c.effort }));
  for (const w of state.history) items.push({ date: w.date, load: Math.max(20, w.durationSeconds / 60) * 5 });
  return items;
}

function readinessScore() {
  const now = Date.now();
  const loads = trainingLoads();
  const acute = loads.filter((l) => l.date > now - 7 * DAY).reduce((a, l) => a + l.load, 0) / 7;
  const chronic = loads.filter((l) => l.date > now - 28 * DAY).reduce((a, l) => a + l.load, 0) / 28;
  if (chronic <= 1) return loads.length ? 60 : 50;
  const ratio = acute / chronic;
  let score;
  if (ratio < 0.8) score = 90 - (0.8 - ratio) * 35;
  else if (ratio <= 1.3) score = 95 - Math.abs(ratio - 1.0) * 25;
  else score = 85 - (ratio - 1.3) * 40;
  return Math.max(10, Math.min(99, Math.round(score)));
}

function readinessLabel(score) {
  if (score >= 85) return "Primed";
  if (score >= 70) return "Ready";
  if (score >= 55) return "Steady";
  if (score >= 40) return "Caution";
  return "Recover";
}

function readinessAdvice(score) {
  if (score >= 85) return "Training load is in the sweet spot. Green light for a hard session.";
  if (score >= 70) return "Solid balance of work and recovery. Stick to the plan.";
  if (score >= 55) return "Load is drifting. Keep easy days truly easy.";
  if (score >= 40) return "You're ramping fast. Watch sleep and consider a cutback day.";
  return "High strain detected. Prioritize recovery before the next hard session.";
}

const RACE_DISTANCES = [["5K", 5], ["10K", 10], ["Half Marathon", 21.0975], ["Marathon", 42.195]];

function predictSeconds(targetKM) {
  // Prefer the last 8 weeks so the forecast tracks *current* fitness and refreshes as
  // you train — instead of being pinned forever to one all-time-best run. Also require
  // a sensible minimum distance for the target (a 2 km sprint is a poor marathon proxy).
  const minDist = Math.min(10, Math.max(3, targetKM * 0.15));
  const eligible = state.cardio.filter(
    (c) => c.sport === "run" && c.durationSeconds > 0 && c.distanceKM >= minDist
  );
  let pool = eligible.filter((c) => c.date >= Date.now() - 56 * DAY);
  if (pool.length < 2) pool = eligible; // widen the window if recent data is thin
  if (!pool.length) {
    // last resort: any run of at least 2 km, all-time
    pool = state.cardio.filter((c) => c.sport === "run" && c.durationSeconds > 0 && c.distanceKM >= 2);
  }
  if (!pool.length) return null;
  return Math.round(Math.min(...pool.map((c) => c.durationSeconds * Math.pow(targetKM / c.distanceKM, 1.06))));
}

const totalSets = (w) => w.exercises.reduce((a, e) => a + e.sets.length, 0);
const totalVolume = (w) =>
  w.exercises.reduce((a, e) => a + e.sets.reduce((b, s) => b + s.reps * s.weight, 0), 0);

/* ============================== Strava import ============================== */

/* RFC-4180-ish CSV parser: handles quoted fields, embedded commas/newlines, "" escapes. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* Strava "Activity Type" → our sport, or null to skip (gym/walk/yoga/etc.).
   Covers Strava's English and Danish exports. */
const STRAVA_SPORTS = {
  // English
  "run": "run", "trail run": "run", "virtual run": "run", "treadmill run": "run",
  "ride": "bike", "virtual ride": "bike", "mountain bike ride": "bike",
  "gravel ride": "bike", "e-bike ride": "bike", "ebikeride": "bike", "velomobile": "bike",
  "swim": "swim", "open water swim": "swim", "pool swim": "swim",
  // Danish
  "løb": "run", "trailløb": "run", "virtuelt løb": "run", "løbebånd": "run",
  "cykling": "bike", "cykeltur": "bike", "virtuel cykling": "bike", "mountainbike": "bike",
  "mountainbiketur": "bike", "gravelcykling": "bike", "elcykeltur": "bike",
  "svømning": "swim", "åbentvandssvømning": "swim", "svøm": "swim",
};

/* English + Danish month abbreviations (first 3 letters) → month index. */
const STRAVA_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, maj: 4, jun: 5, jul: 6,
  aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11,
};

/* Robust date parse: handles Strava's English ("Jun 1, 2026, 6:00:00 AM")
   and Danish ("9. jun. 2026, 17.09.50") formats. */
function parseStravaDate(s) {
  if (!s) return NaN;
  s = String(s).trim();
  const t = Date.parse(s);
  if (!isNaN(t)) return t;
  // Danish: "9. jun. 2026, 17.09.50" (time separated by . or :)
  const m = s.match(/(\d{1,2})\.?\s*([A-Za-zæøåÆØÅ]+)\.?\s*(\d{4})[,\s]+(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?/);
  if (m) {
    const mon = STRAVA_MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mon != null) {
      return new Date(+m[3], mon, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
    }
  }
  return NaN;
}

function parseStravaCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { sessions: [], skipped: 0, total: 0 };
  const header = rows[0].map((h) => h.trim());

  // The bulk export repeats some column names ("Distance" in km AND in metres,
  // "Elapsed Time" twice). Track every index per name so we can disambiguate.
  const cols = {};
  header.forEach((h, i) => { (cols[h] = cols[h] || []).push(i); });
  // Match the first header (English or Danish) that exists; 'last' picks the
  // final duplicate (e.g. Distance appears as km then metres).
  const col = (names, which) => {
    for (const n of names) {
      if (cols[n]) return which === "last" ? cols[n][cols[n].length - 1] : cols[n][0];
    }
    return -1;
  };

  const iId = col(["Activity ID", "Aktivitets-id"]);
  const iDate = col(["Activity Date", "Aktivitetsdato"]);
  const iName = col(["Activity Name", "Aktivitetsnavn"]);
  const iType = col(["Activity Type", "Aktivitetstype"]);
  const iMoving = col(["Moving Time", "Tid i bevægelse"]);
  const iElapsed = col(["Elapsed Time", "Varighed"]);
  const iRPE = col(["Perceived Exertion", "Oplevet indsats"]);
  const dFirst = col(["Distance"], "first"); // usually km (display units)
  const dLast = col(["Distance"], "last");   // usually metres

  const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? NaN : n; };
  const sessions = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 3) continue;
    const sport = STRAVA_SPORTS[(row[iType] || "").trim().toLowerCase()];
    if (!sport) { skipped++; continue; }

    const date = parseStravaDate(row[iDate]);
    if (isNaN(date)) { skipped++; continue; }

    let secs = num(row[iMoving]);
    if (isNaN(secs) || secs <= 0) secs = num(row[iElapsed]);
    secs = Math.round(secs || 0);

    // Prefer the metres column /1000 when present (unit-unambiguous); else first col as km.
    const dF = num(row[dFirst]);
    const dL = dLast !== dFirst ? num(row[dLast]) : NaN;
    let km;
    if (!isNaN(dL) && (isNaN(dF) || dL > dF * 100)) km = dL / 1000;
    else km = dF;
    km = isNaN(km) ? 0 : Math.round(km * 100) / 100;

    if (km <= 0 || secs <= 0) { skipped++; continue; }

    let effort = 5;
    if (iRPE >= 0) { const e = parseInt(row[iRPE], 10); if (e >= 1 && e <= 10) effort = e; }
    const name = (iName >= 0 ? (row[iName] || "").trim() : "") || "Strava";

    sessions.push({
      id: uid(),
      stravaId: iId >= 0 ? (row[iId] || "").trim() : "",
      sport, date, distanceKM: km, durationSeconds: secs, effort, notes: name,
    });
  }
  return { sessions, skipped, total: rows.length - 1 };
}

function importStravaSessions(parsed) {
  const existing = new Set(state.cardio.filter((c) => c.stravaId).map((c) => c.stravaId));
  let added = 0, dup = 0;
  for (const s of parsed.sessions) {
    if (s.stravaId && existing.has(s.stravaId)) { dup++; continue; }
    state.cardio.push(s);
    if (s.stravaId) existing.add(s.stravaId);
    added++;
  }
  save();
  return { added, dup };
}

/* ============================== Seed data ============================== */

function seed() {
  const ex = (name, category, notes = "") => ({ id: uid(), name, category, notes });

  const exercises = [
    ex("Back Squat", "Legs", "Brace hard, hit depth."),
    ex("Romanian Deadlift", "Legs", "Hinge — feel the hamstrings."),
    ex("Bulgarian Split Squat", "Legs"),
    ex("Calf Raise", "Legs", "Slow 3s lowering. Key for runners."),
    ex("Bench Press", "Push"),
    ex("Overhead Press", "Push"),
    ex("Pull-Up", "Pull"),
    ex("Barbell Row", "Pull"),
    ex("Plank", "Core", "Reps = seconds held."),
    ex("Dead Bug", "Core"),
    ex("Glute Bridge", "Core"),
    ex("Hip Flexor Stretch", "Mobility"),
  ];

  const find = (name) => exercises.find((e) => e.name === name);
  const wex = (name, sets, reps, kg) => {
    const e = find(name);
    return {
      id: uid(),
      exerciseID: e.id,
      name: e.name,
      notes: "",
      sets: Array.from({ length: sets }, () => ({ id: uid(), reps, weight: kg, done: false })),
    };
  };

  const templates = [
    { id: uid(), name: "Runner's Strength A", date: Date.now(), notes: "", durationSeconds: 0,
      exercises: [wex("Back Squat", 3, 8, 60), wex("Romanian Deadlift", 3, 10, 40), wex("Calf Raise", 3, 15, 20), wex("Plank", 3, 45, 0)] },
    { id: uid(), name: "Core & Stability", date: Date.now(), notes: "", durationSeconds: 0,
      exercises: [wex("Plank", 3, 45, 0), wex("Dead Bug", 3, 12, 0), wex("Glute Bridge", 3, 15, 0)] },
    { id: uid(), name: "Upper Body B", date: Date.now(), notes: "", durationSeconds: 0,
      exercises: [wex("Bench Press", 3, 8, 50), wex("Barbell Row", 3, 10, 40), wex("Overhead Press", 3, 8, 30), wex("Pull-Up", 3, 6, 0)] },
  ];

  // Fresh profiles start with a clean slate — exercises, workout templates and
  // the training plan, but no logged progress. Each person fills in their own.
  return {
    exercises,
    templates,
    history: [],
    cardio: [],
    plan: generatePlan(),
    planStartDate: PLAN_START_DEFAULT,
    planVersion: PLAN_VERSION,
  };
}

/* ============================== UI state ============================== */

const ui = {
  tab: "home",
  planWeek: null,
  activitySeg: "endurance",
  trendExercise: null,
  coach: { busy: false, result: null, error: null, inputs: null },
};

/* ============================== Tab bar ============================== */

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/></svg>',
  plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 8v8M4 10v4M17 8v8M20 10v4M7 12h10"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  trends: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19 10 12l4 4 6-8"/><path d="M15 8h5v5"/></svg>',
  coach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.8 4.8 1.9-4.8 1.9L12 16.4l-1.9-4.8-4.8-1.9 4.8-1.9z"/><path d="M19 14.5l.9 2.3 2.1.9-2.1.9-.9 2.3-.9-2.3-2.1-.9 2.1-.9z"/></svg>',
};

const TABS = [
  { id: "home", label: "Home" },
  { id: "plan", label: "Plan" },
  { id: "coach", label: "Coach" },
  { id: "train", label: "Train" },
  { id: "activity", label: "Activity" },
  { id: "trends", label: "Trends" },
];

function renderTabbar() {
  $("#tabbar").innerHTML = TABS.map(
    (t) => `<button class="tab-btn ${ui.tab === t.id ? "active" : ""}" onclick="A.go('${t.id}')">${ICONS[t.id]}${t.label}</button>`
  ).join("");
}

/* ============================== Render: Home ============================== */

function renderHome() {
  const hasData = state.cardio.length > 0 || state.history.length > 0;
  const score = readinessScore();
  const hex = !hasData ? "#8a8a98" : score >= 70 ? "#c7ff59" : score >= 40 ? "#ff9440" : "#ff5a5a";
  const C = (2 * Math.PI * 62).toFixed(1);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const week = currentPlanWeek();

  const predictions = predictSeconds(5) === null
    ? `<div class="card-sub" style="margin-top:8px">Log a run in the Activity tab to unlock predictions.</div>`
    : RACE_DISTANCES.map(([name, km]) => {
        const hero = name === "Marathon" ? "pred-hero" : "";
        return `<div class="pred-row"><span class="${hero}">${name}</span><span class="pred-time ${hero}">${fmtDur(predictSeconds(km))}</span></div>`;
      }).join("");

  const weekStart = (() => { const d = new Date(); const off = (d.getDay() + 6) % 7; return startOfDay(Date.now()) - off * DAY; })();
  const wc = state.cardio.filter((c) => c.date >= weekStart);
  const wh = state.history.filter((w) => w.date >= weekStart);
  const wkm = wc.reduce((a, c) => a + c.distanceKM, 0);
  const wsec = wc.reduce((a, c) => a + c.durationSeconds, 0) + wh.reduce((a, w) => a + w.durationSeconds, 0);

  const upNext = state.plan
    .filter((s) => s.week === week && !s.completed)
    .sort((a, b) => a.day - b.day)
    .slice(0, 3);

  $("#view").innerHTML = `
    <div class="view-head" style="margin-bottom:18px">
      <div>
        <div class="screen-title">${greeting}</div>
        <div class="screen-sub">${fmtDateLong(Date.now())}</div>
      </div>
      <button class="profile-chip" title="Switch profile" onclick="A.openProfiles()">
        <span class="avatar">${esc((currentProfile().name || "?").slice(0, 1).toUpperCase())}</span>
        <span class="pname">${esc(currentProfile().name)}</span>
      </button>
    </div>
    <div class="stack">
      <div class="card">
        <div class="countdown-row">
          <div class="flag-ico">🏁</div>
          <div style="flex:1">
            <div class="card-title">${esc(planGoalLabel())} Race Day</div>
            <div class="card-sub">${fmtDateLong(raceDate())}</div>
            <div class="card-sub">Week ${week} of ${planWeeks()} · ${esc(planPhaseAt(week))} phase</div>
          </div>
          <div>
            <div class="countdown-num">${daysToRace()}</div>
            <div class="stat-lbl" style="text-align:center">days to go</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="ring-wrap">
          <svg width="146" height="146" viewBox="0 0 150 150" style="flex:none">
            <circle cx="75" cy="75" r="62" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="13"/>
            <circle id="ringFg" cx="75" cy="75" r="62" fill="none" stroke="${hex}" stroke-width="13"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}"
              transform="rotate(-90 75 75)"
              style="transition: stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1); filter: drop-shadow(0 0 9px ${hex}55)"/>
            <text x="75" y="82" text-anchor="middle" class="ring-score">${hasData ? score : "—"}</text>
            <text x="75" y="100" text-anchor="middle" class="ring-sub">/ 100</text>
          </svg>
          <div>
            <div class="eyebrow">Race Readiness</div>
            <div class="ready-label" style="color:${hex}">${hasData ? readinessLabel(score) : "Ready when you are"}</div>
            <div class="card-sub" style="line-height:1.5">${hasData ? readinessAdvice(score) : "Log a workout or import your Strava history to see your race readiness."}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Predicted Race Times</div>
        <div class="card-sub">Live forecast from your best logged runs (Riegel formula)</div>
        <div style="margin-top:6px">${predictions}</div>
      </div>

      <div class="card">
        <div class="card-title">This Week</div>
        <div class="stat-grid">
          <div class="stat-cell"><div class="stat-val">${wkm.toFixed(1)}</div><div class="stat-lbl">km covered</div></div>
          <div class="stat-cell"><div class="stat-val">${wc.length + wh.length}</div><div class="stat-lbl">sessions</div></div>
          <div class="stat-cell"><div class="stat-val">${fmtDur(wsec)}</div><div class="stat-lbl">time trained</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:4px">Up Next · Week ${week}</div>
        ${upNext.length === 0
          ? `<div class="card-sub">All sessions done this week. Outstanding work — recover well.</div>`
          : upNext.map((s) => `
            <div class="next-row">
              ${sportIcon(s.sport, 36)}
              <div style="flex:1;min-width:0">
                <div class="title">${esc(s.title)}</div>
                <div class="detail">${esc(s.detail)}</div>
              </div>
              <div class="small muted" style="font-weight:700">${DAY_NAMES[s.day - 1]}</div>
            </div>`).join("")}
      </div>
    </div>`;

  requestAnimationFrame(() =>
    setTimeout(() => {
      const el = $("#ringFg");
      if (el) el.style.strokeDashoffset = (C * (1 - (hasData ? score : 0) / 100)).toFixed(1);
    }, 60)
  );
}

/* ============================== Render: Plan ============================== */

function renderPlan() {
  if (ui.planWeek === null) ui.planWeek = currentPlanWeek();
  const week = Math.min(ui.planWeek, planWeeks());
  const sessions = state.plan.filter((s) => s.week === week).sort((a, b) => a.day - b.day);
  const done = state.plan.filter((s) => s.completed).length;
  const total = Math.max(1, state.plan.length);
  const ph = planPhaseAt(week);
  const phc = planPhaseColorAt(week);
  const km = planWeekKMAt(week);
  const meta = state.planMeta;

  $("#view").innerHTML = `
    <div class="view-head">
      <div>
        <div class="screen-title">${esc(planGoalLabel())} Plan</div>
        <div class="screen-sub">${meta
          ? `Your personal ${meta.weeks}-week plan · built by the ${meta.engine === "ai" ? "AI coach" : "coach engine"}`
          : "Din 20-ugers hybridplan · 3 løbedage + 3 styrkedage"}</div>
      </div>
      <button class="icon-btn" title="Plan settings" onclick="A.openPlanSettings()">⚙</button>
    </div>
    <div class="stack">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div class="card-title">${planWeeks()} Weeks to the Start Line</div>
          <div style="color:var(--accent);font-weight:800;font-size:14px">${done}/${total}</div>
        </div>
        <div class="progressbar"><div style="width:${((done / total) * 100).toFixed(1)}%"></div></div>
      </div>

      <div class="week-strip" id="weekStrip">
        ${Array.from({ length: planWeeks() }, (_, i) => i + 1).map((w) => `
          <button class="week-chip ${w === week ? "sel" : ""} ${w === currentPlanWeek() ? "now" : ""}"
            data-week="${w}" onclick="A.selectWeek(${w})">
            W${w}<span class="dot" style="background:${w === week ? "rgba(0,0,0,.55)" : planPhaseColorAt(w)}"></span>
          </button>`).join("")}
      </div>

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="font-size:19px;font-weight:800">Uge ${week}</div>
        <span class="phase-pill" style="background:${phc}22;color:${phc}">${esc(planPhaseAt(week).toUpperCase())}</span>
        ${km != null ? `<span class="phase-pill" style="background:rgba(255,255,255,.07);color:var(--text-sec)">${km} KM LØB</span>` : ""}
      </div>

      ${sessions.map((s) => `
        <div class="card plan-card ${s.completed ? "done" : ""}" onclick="A.togglePlan('${s.id}')">
          <div class="day-badge">${DAY_NAMES[s.day - 1]}</div>
          <div class="grow">
            <div class="title">${esc(s.title)}</div>
            <div class="detail">${esc(s.detail)}</div>
          </div>
          <div style="font-size:17px">${SPORTS[s.sport].emoji}</div>
          <div class="checkmark ${s.completed ? "on" : ""}">${s.completed ? "✓" : ""}</div>
        </div>`).join("")}
    </div>`;

  const chip = document.querySelector(`.week-chip[data-week="${week}"]`);
  if (chip) chip.scrollIntoView({ inline: "center", block: "nearest" });
}

/* ============================== Render: Train ============================== */

function renderTrain() {
  $("#view").innerHTML = `
    <div class="view-head">
      <div>
        <div class="screen-title">Train</div>
        <div class="screen-sub">Strength work that keeps you running</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" title="Exercise library" onclick="A.openLibrary()">📚</button>
        <button class="icon-btn" title="New workout" onclick="A.editTemplate(null)">＋</button>
      </div>
    </div>
    <div class="stack">
      <button class="btn btn-accent" style="display:flex;align-items:center;justify-content:space-between;padding:16px"
        onclick="A.startEmpty()">
        <span>⚡ Start Empty Workout</span><span>›</span>
      </button>
      <div class="card-title" style="margin-top:6px">My Workouts</div>
      ${state.templates.length === 0
        ? `<div class="empty-note">No workouts yet.<br>Tap ＋ to build one from your exercises.</div>`
        : state.templates.map((t) => `
          <div class="card">
            <div class="tpl-head">
              <div style="min-width:0">
                <div class="tpl-name">${esc(t.name)}</div>
                <div class="tpl-list">${t.exercises.map((e) => esc(e.name)).join(" · ")}</div>
              </div>
              <div class="tpl-actions">
                <button class="icon-btn" title="Edit" onclick="A.editTemplate('${t.id}')">✎</button>
                <button class="icon-btn" title="Delete" onclick="A.deleteTemplate('${t.id}')">🗑</button>
              </div>
            </div>
            <button class="btn btn-ghost" style="margin-top:12px" onclick="A.startTemplate('${t.id}')">Start Workout</button>
          </div>`).join("")}
    </div>`;
}

/* ============================== Render: Activity ============================== */

function renderActivity() {
  const seg = ui.activitySeg;
  let listHTML;

  if (seg === "endurance") {
    const items = [...state.cardio].sort((a, b) => b.date - a.date);
    listHTML = items.length === 0
      ? `<div class="empty-note">No sessions yet.<br>Tap ＋ to log a run, ride or swim.</div>`
      : items.map((c) => `
        <div class="card act-row" onclick="A.editCardio('${c.id}')">
          ${sportIcon(c.sport, 44)}
          <div class="grow">
            <div class="title">${SPORTS[c.sport].label} · ${fmtKM(c.distanceKM)}</div>
            <div class="sub">${fmtDate(c.date)}${c.notes ? " · " + esc(c.notes) : ""}</div>
          </div>
          <div class="right">
            <div class="title" style="font-variant-numeric:tabular-nums">${fmtDur(c.durationSeconds)}</div>
            <div class="sub">${paceText(c)} · RPE ${c.effort}</div>
          </div>
          <button class="icon-btn" style="width:30px;height:30px;font-size:13px" title="Delete"
            onclick="event.stopPropagation();A.deleteCardio('${c.id}')">✕</button>
        </div>`).join("");
  } else {
    const items = [...state.history].sort((a, b) => b.date - a.date);
    listHTML = items.length === 0
      ? `<div class="empty-note">No gym sessions yet.<br>Finish a workout in the Train tab and it appears here.</div>`
      : items.map((w) => `
        <div class="card act-row" onclick="A.showWorkout('${w.id}')">
          ${sportIcon("strength", 44)}
          <div class="grow">
            <div class="title">${esc(w.name)}</div>
            <div class="sub">${fmtDate(w.date)} · ${totalSets(w)} sets · ${Math.round(totalVolume(w))} kg volume</div>
          </div>
          <div class="right">
            <div class="title" style="font-variant-numeric:tabular-nums">${fmtDur(w.durationSeconds)}</div>
            <div class="sub">duration</div>
          </div>
        </div>`).join("");
  }

  $("#view").innerHTML = `
    <div class="view-head">
      <div>
        <div class="screen-title">Activity</div>
        <div class="screen-sub">Everything you've logged, in one place</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="icon-btn" title="Import from Strava" onclick="A.openStravaImport()">⤓</button>
        <button class="icon-btn" title="Log session" onclick="A.editCardio(null)">＋</button>
      </div>
    </div>
    <div class="seg" style="margin-bottom:14px">
      <button class="${seg === "endurance" ? "on" : ""}" onclick="A.setActivitySeg('endurance')">Endurance</button>
      <button class="${seg === "gym" ? "on" : ""}" onclick="A.setActivitySeg('gym')">Gym</button>
    </div>
    <div class="stack">${listHTML}</div>`;
}

/* ============================== Render: Trends ============================== */

function svgStackedBars(weeks) {
  const W = 360, H = 195, padL = 8, padB = 26, padT = 16;
  const innerW = W - padL * 2;
  const bw = Math.min(30, (innerW / weeks.length) * 0.55);
  const step = innerW / weeks.length;
  const max = Math.max(1, ...weeks.map((w) => w.parts.reduce((a, p) => a + p.value, 0)));
  let bars = "";
  weeks.forEach((w, i) => {
    const x = padL + step * i + (step - bw) / 2;
    let y = H - padB;
    for (const p of w.parts) {
      const h = (p.value / max) * (H - padB - padT);
      if (h > 0.5) {
        y -= h;
        bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h - 1.5).toFixed(1)}" rx="3" fill="${p.color}"/>`;
      }
    }
    bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="rgba(255,255,255,.4)" font-family="inherit">${w.label}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    <line x1="${padL}" y1="${H - padB}" x2="${W - padL}" y2="${H - padB}" stroke="rgba(255,255,255,.1)"/>
    <text x="${padL}" y="${padT - 4}" font-size="9.5" fill="rgba(255,255,255,.4)">max ${max % 1 ? max.toFixed(1) : max} km/wk</text>
    ${bars}</svg>`;
}

function svgLine(points, hex, fmtY) {
  const W = 360, H = 175, padL = 10, padR = 10, padT = 18, padB = 24;
  const ys = points.map((p) => p.y);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  const pad = Math.max(0.5, (ymax - ymin) * 0.15);
  ymin -= pad; ymax += pad;
  const px = (i) => padL + (i / (points.length - 1)) * (W - padL - padR);
  const py = (y) => padT + (1 - (y - ymin) / (ymax - ymin)) * (H - padT - padB);
  const path = points.map((p, i) => `${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const dots = points.map((p, i) =>
    `<circle cx="${px(i).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3.4" fill="${hex}"/>`).join("");
  const first = points[0], last = points[points.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    <text x="${padL}" y="${padT - 6}" font-size="9.5" fill="rgba(255,255,255,.4)">${fmtY(Math.max(...ys))} – ${fmtY(Math.min(...ys))}</text>
    <polyline points="${path}" fill="none" stroke="${hex}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="${padL}" y="${H - 7}" font-size="9.5" fill="rgba(255,255,255,.4)">${fmtDate(first.t)}</text>
    <text x="${W - padR}" y="${H - 7}" text-anchor="end" font-size="9.5" fill="rgba(255,255,255,.4)">${fmtDate(last.t)}</text>
  </svg>`;
}

function renderTrends() {
  // Weekly distance, last 8 weeks
  const monday = (() => { const d = new Date(); const off = (d.getDay() + 6) % 7; return startOfDay(Date.now()) - off * DAY; })();
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const start = monday - i * 7 * DAY, end = start + 7 * DAY;
    const d = new Date(start);
    weeks.push({
      label: `${d.getDate()}/${d.getMonth() + 1}`,
      parts: ["run", "bike", "swim"].map((sport) => ({
        color: SPORTS[sport].hex,
        value: state.cardio.filter((c) => c.sport === sport && c.date >= start && c.date < end)
          .reduce((a, c) => a + c.distanceKM, 0),
      })),
    });
  }
  const hasWeekly = weeks.some((w) => w.parts.some((p) => p.value > 0));

  // Strength progression
  const names = [...new Set(state.history.flatMap((w) => w.exercises.map((e) => e.name)))].sort();
  if (!ui.trendExercise || !names.includes(ui.trendExercise)) ui.trendExercise = names[0] || null;
  const strengthPts = state.history
    .map((w) => {
      const maxW = Math.max(0, ...w.exercises.filter((e) => e.name === ui.trendExercise)
        .flatMap((e) => e.sets.map((s) => s.weight)));
      return maxW > 0 ? { t: w.date, y: maxW } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  // Pace trend
  const pacePts = state.cardio
    .filter((c) => c.sport === "run" && c.distanceKM > 0 && c.durationSeconds > 0)
    .map((c) => ({ t: c.date, y: c.durationSeconds / c.distanceKM }))
    .sort((a, b) => a.t - b.t);

  const runKM = state.cardio.filter((c) => c.sport === "run").reduce((a, c) => a + c.distanceKM, 0);
  const bikeKM = state.cardio.filter((c) => c.sport === "bike").reduce((a, c) => a + c.distanceKM, 0);
  const swimKM = state.cardio.filter((c) => c.sport === "swim").reduce((a, c) => a + c.distanceKM, 0);
  const totalSecs = state.cardio.reduce((a, c) => a + c.durationSeconds, 0) +
    state.history.reduce((a, w) => a + w.durationSeconds, 0);

  $("#view").innerHTML = `
    <div class="view-head">
      <div>
        <div class="screen-title">Trends</div>
        <div class="screen-sub">Proof that the work is working</div>
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <div class="card-title">Weekly Distance</div>
        <div class="card-sub">Last 8 weeks, all sports</div>
        ${hasWeekly ? svgStackedBars(weeks) : `<div class="empty-note" style="padding:24px">Log endurance sessions to see weekly volume.</div>`}
        <div class="legend">
          <span><i style="background:${SPORTS.run.hex}"></i>Run</span>
          <span><i style="background:${SPORTS.bike.hex}"></i>Bike</span>
          <span><i style="background:${SPORTS.swim.hex}"></i>Swim</span>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div>
            <div class="card-title">Strength Progression</div>
            <div class="card-sub">Top set weight per session</div>
          </div>
          ${names.length ? `<select class="input" style="width:auto;padding:8px 10px;font-size:13px"
            onchange="A.setTrendExercise(this.value)">
            ${names.map((n) => `<option ${n === ui.trendExercise ? "selected" : ""}>${esc(n)}</option>`).join("")}
          </select>` : ""}
        </div>
        ${strengthPts.length >= 2
          ? svgLine(strengthPts, SPORTS.strength.hex, (y) => y % 1 ? y.toFixed(1) + " kg" : y + " kg")
          : `<div class="empty-note" style="padding:24px">Finish at least two workouts with weighted sets of the same exercise to see a trend.</div>`}
      </div>

      <div class="card">
        <div class="card-title">Run Pace Trend</div>
        <div class="card-sub">min/km — lower is faster</div>
        ${pacePts.length >= 2
          ? svgLine(pacePts, SPORTS.run.hex, (y) => fmtDur(y) + "/km")
          : `<div class="empty-note" style="padding:24px">Log at least two runs to see your pace trend.</div>`}
      </div>

      <div class="card">
        <div class="card-title">All-Time Totals</div>
        <div class="totals-grid">
          <div class="stat-cell"><div class="stat-val" style="color:${SPORTS.run.hex}">${Math.round(runKM)}</div><div class="stat-lbl">km run</div></div>
          <div class="stat-cell"><div class="stat-val" style="color:${SPORTS.bike.hex}">${Math.round(bikeKM)}</div><div class="stat-lbl">km ridden</div></div>
          <div class="stat-cell"><div class="stat-val" style="color:${SPORTS.swim.hex}">${swimKM.toFixed(1)}</div><div class="stat-lbl">km swum</div></div>
          <div class="stat-cell"><div class="stat-val" style="color:${SPORTS.strength.hex}">${state.history.length}</div><div class="stat-lbl">gym sessions</div></div>
          <div class="stat-cell"><div class="stat-val" style="color:var(--accent)">${state.cardio.length}</div><div class="stat-lbl">endurance sessions</div></div>
          <div class="stat-cell"><div class="stat-val">${(totalSecs / 3600).toFixed(1)} h</div><div class="stat-lbl">total time</div></div>
        </div>
      </div>
    </div>`;
}

/* ============================== Modals ============================== */

function openModal(html) {
  $("#overlay-root").innerHTML =
    `<div class="overlay" onclick="if(event.target===this)A.closeModal()"><div class="sheet">${html}</div></div>`;
}
function closeModal() {
  $("#overlay-root").innerHTML = "";
}

/* Popup replacements — iOS home-screen apps often silently swallow native
   alert/confirm/prompt dialogs, so the app never uses them. */

let toastTimer = null;
function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3400);
}

function confirmSheet(message, onYes, yesLabel = "Confirm") {
  openModal(`
    <div class="sheet-title">Are you sure?</div>
    <div class="card-sub" style="line-height:1.6;font-size:13.5px;margin-top:4px">${esc(message)}</div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="A.closeModal()">Cancel</button>
      <button class="btn btn-danger" id="confirm-yes">${esc(yesLabel)}</button>
    </div>`);
  $("#confirm-yes").onclick = () => { closeModal(); onYes(); };
}

function promptSheet(title, initial, placeholder, onSave) {
  openModal(`
    <div class="sheet-title">${esc(title)}</div>
    <input class="input" id="prompt-in" placeholder="${esc(placeholder)}" value="${esc(initial)}" style="margin-top:10px">
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="A.closeModal()">Cancel</button>
      <button class="btn btn-accent" id="prompt-save">Save</button>
    </div>`);
  const input = $("#prompt-in");
  $("#prompt-save").onclick = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    closeModal();
    onSave(v);
  };
  setTimeout(() => input.focus(), 80);
}

/* ---------- Profiles ---------- */

function openProfiles() {
  openModal(`
    <div class="sheet-head">
      <div class="sheet-title">Profiles</div>
      <button class="icon-btn" title="New profile" onclick="A.newProfile()">＋</button>
    </div>
    <div class="card-sub" style="line-height:1.6">
      Each profile keeps its own workouts, plan progress and history — saved only on
      this device and never uploaded. Pick yours so your data stays separate from
      anyone else who opens the app on this browser.
    </div>
    <div style="margin-top:10px">
      ${profiles.map((p) => `
        <div class="list-row">
          <div class="grow" onclick="A.switchProfile('${p.id}')">
            <div class="name">${esc(p.name)}${p.id === currentId ? ' · <span style="color:var(--accent)">active</span>' : ""}</div>
          </div>
          ${p.id === currentId ? `<button class="icon-btn" style="width:30px;height:30px;font-size:13px" title="Rename" onclick="A.renameProfile()">✎</button>` : ""}
          ${profiles.length > 1 ? `<button class="icon-btn" style="width:30px;height:30px;font-size:13px" title="Delete" onclick="A.deleteProfile('${p.id}')">✕</button>` : ""}
        </div>`).join("")}
    </div>
    <div class="divider"></div>
    <button class="btn btn-danger" onclick="A.clearProgress()">Clear this profile's progress</button>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="A.closeModal()">Done</button></div>`);
}

function switchProfile(id) {
  if (id === currentId) { closeModal(); return; }
  if (!profiles.some((p) => p.id === id)) return;
  currentId = id;
  state = readData(id) || seed();
  ui.planWeek = null;
  ui.tab = "home";
  saveProfiles();
  save();
  closeModal();
  render();
}

function newProfile() {
  promptSheet("New profile", "", "Name", (name) => {
    const id = uid();
    profiles.push({ id, name });
    currentId = id;
    state = seed();
    ui.planWeek = null;
    ui.tab = "home";
    saveProfiles();
    save();
    render();
  });
}

function renameProfile() {
  const p = currentProfile();
  promptSheet("Rename profile", p.name, "Name", (name) => {
    p.name = name;
    saveProfiles();
    openProfiles();
  });
}

function deleteProfile(id) {
  if (profiles.length <= 1) { toast("You need at least one profile."); return; }
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  confirmSheet(`Delete profile "${p.name}" and all of its data on this device? This can't be undone.`, () => {
    localStorage.removeItem(dataKey(id));
    profiles = profiles.filter((x) => x.id !== id);
    if (currentId === id) {
      currentId = profiles[0].id;
      state = readData(currentId) || seed();
      ui.planWeek = null;
    }
    saveProfiles();
    save();
    render();
    openProfiles();
  }, "Delete");
}

function clearProgress() {
  confirmSheet("Clear this profile's runs, rides, swims and gym history? Your exercises and training plan are kept.", () => {
    state.cardio = [];
    state.history = [];
    // reset plan check-offs too
    state.plan.forEach((s) => (s.completed = false));
    save();
    render();
    toast("Progress cleared.");
  }, "Clear");
}

/* ---------- Exercise library ---------- */

function openLibrary() {
  const byCat = {};
  for (const e of state.exercises) (byCat[e.category] = byCat[e.category] || []).push(e);
  const cats = [...CATEGORIES.filter((c) => byCat[c]), ...Object.keys(byCat).filter((c) => !CATEGORIES.includes(c)).sort()];

  openModal(`
    <div class="sheet-head">
      <div class="sheet-title">Exercise Library</div>
      <button class="icon-btn" onclick="A.editExercise(null)">＋</button>
    </div>
    <div class="card-sub">Your exercises — fully custom. Tap to edit.</div>
    ${state.exercises.length === 0 ? `<div class="empty-note">No exercises yet. Tap ＋ to create your first one.</div>` : ""}
    ${cats.map((cat) => `
      <div class="cat-head">${esc(cat)}</div>
      ${byCat[cat].sort((a, b) => a.name.localeCompare(b.name)).map((e) => `
        <div class="list-row">
          <div class="grow" onclick="A.editExercise('${e.id}')">
            <div class="name">${esc(e.name)}</div>
            ${e.notes ? `<div class="meta">${esc(e.notes)}</div>` : ""}
          </div>
          <button class="icon-btn" style="width:30px;height:30px;font-size:13px" onclick="A.deleteExercise('${e.id}')">✕</button>
        </div>`).join("")}`).join("")}
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="A.closeModal()">Done</button></div>`);
}

function editExercise(id) {
  const ex = id ? state.exercises.find((e) => e.id === id) : null;
  openModal(`
    <div class="sheet-title">${ex ? "Edit Exercise" : "New Exercise"}</div>
    <div class="field-label">Name</div>
    <input class="input" id="ex-name" placeholder="e.g. Nordic Curl" value="${esc(ex?.name || "")}">
    <div class="field-label">Category</div>
    <select class="input" id="ex-cat">
      ${CATEGORIES.map((c) => `<option ${c === (ex?.category || "Legs") ? "selected" : ""}>${c}</option>`).join("")}
    </select>
    <div class="field-label">Notes</div>
    <textarea class="input" id="ex-notes" placeholder="Cues, setup, tempo…">${esc(ex?.notes || "")}</textarea>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="A.openLibrary()">Cancel</button>
      <button class="btn btn-accent" onclick="A.saveExercise(${ex ? `'${ex.id}'` : "null"})">Save</button>
    </div>`);
  setTimeout(() => $("#ex-name")?.focus(), 80);
}

function saveExercise(id) {
  const name = $("#ex-name").value.trim();
  if (!name) { $("#ex-name").focus(); return; }
  const category = $("#ex-cat").value;
  const notes = $("#ex-notes").value.trim();
  if (id) {
    const e = state.exercises.find((x) => x.id === id);
    if (e) { e.name = name; e.category = category; e.notes = notes; }
  } else {
    state.exercises.push({ id: uid(), name, category, notes });
  }
  save();
  openLibrary();
}

function deleteExercise(id) {
  const e = state.exercises.find((x) => x.id === id);
  if (!e) return;
  confirmSheet(`Delete "${e.name}"? Past workouts that used it keep their data.`, () => {
    state.exercises = state.exercises.filter((x) => x.id !== id);
    save();
    openLibrary();
  }, "Delete");
}

/* ---------- Template editor ---------- */

let tplDraft = null;

function editTemplate(id) {
  const t = id ? state.templates.find((x) => x.id === id) : null;
  tplDraft = t
    ? JSON.parse(JSON.stringify(t))
    : { id: uid(), name: "", date: Date.now(), notes: "", durationSeconds: 0, exercises: [], _new: true };
  renderTplModal();
}

function renderTplModal() {
  const t = tplDraft;
  const opts = [...state.exercises].sort((a, b) => a.name.localeCompare(b.name));
  openModal(`
    <div class="sheet-title">${t._new ? "New Workout" : "Edit Workout"}</div>
    <div class="field-label">Name</div>
    <input class="input" id="tpl-name" placeholder="e.g. Runner's Strength A" value="${esc(t.name)}"
      oninput="A.tplName(this.value)">
    <div class="field-label">Exercises</div>
    ${t.exercises.length === 0 ? `<div class="card-sub" style="padding:8px 0">No exercises yet — add some below.</div>` : ""}
    ${t.exercises.map((e) => `
      <div class="list-row">
        <div class="grow" style="cursor:default">
          <div class="name">${esc(e.name)}</div>
          <div class="meta">${e.sets.length} sets × ${e.sets[0]?.reps ?? 10} reps</div>
        </div>
        <div class="stepper">
          <button onclick="A.tplSets('${e.id}',-1)">−</button><b>${e.sets.length}</b><button onclick="A.tplSets('${e.id}',1)">＋</button>
        </div>
        <button class="icon-btn" style="width:30px;height:30px;font-size:13px" onclick="A.tplRemove('${e.id}')">✕</button>
      </div>`).join("")}
    <div style="display:flex;gap:8px;margin-top:12px">
      <select class="input" id="tpl-add" style="flex:1">
        ${opts.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}
      </select>
      <button class="btn btn-ghost btn-sm" style="flex:none" onclick="A.tplAdd()">Add</button>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="A.closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="A.saveTemplate()">Save</button>
    </div>`);
}

function tplName(v) { tplDraft.name = v; }

function tplSets(exId, delta) {
  const e = tplDraft.exercises.find((x) => x.id === exId);
  if (!e) return;
  const target = Math.max(1, Math.min(10, e.sets.length + delta));
  const proto = e.sets[e.sets.length - 1] || { reps: 10, weight: 0 };
  while (e.sets.length < target) e.sets.push({ id: uid(), reps: proto.reps, weight: proto.weight, done: false });
  while (e.sets.length > target) e.sets.pop();
  renderTplModal();
}

function tplRemove(exId) {
  tplDraft.exercises = tplDraft.exercises.filter((x) => x.id !== exId);
  renderTplModal();
}

function tplAdd() {
  const sel = $("#tpl-add");
  if (!sel || !sel.value) return;
  const ex = state.exercises.find((e) => e.id === sel.value);
  if (!ex) return;
  tplDraft.exercises.push({
    id: uid(), exerciseID: ex.id, name: ex.name, notes: "",
    sets: Array.from({ length: 3 }, () => ({ id: uid(), reps: 10, weight: 0, done: false })),
  });
  renderTplModal();
}

function saveTemplate() {
  const t = tplDraft;
  t.name = (t.name || "").trim() || "Untitled Workout";
  delete t._new;
  const i = state.templates.findIndex((x) => x.id === t.id);
  if (i >= 0) state.templates[i] = t; else state.templates.push(t);
  tplDraft = null;
  save();
  closeModal();
  render();
}

function deleteTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  confirmSheet(`Delete workout "${t.name}"?`, () => {
    state.templates = state.templates.filter((x) => x.id !== id);
    save();
    render();
  }, "Delete");
}

/* ---------- Cardio editor ---------- */

let cardioDraft = null;

function editCardio(id) {
  const c = id ? state.cardio.find((x) => x.id === id) : null;
  cardioDraft = c
    ? JSON.parse(JSON.stringify(c))
    : { id: uid(), sport: "run", date: Date.now(), distanceKM: 5, durationSeconds: 1800, effort: 5, notes: "", _new: true };
  renderCardioModal();
}

function renderCardioModal() {
  const c = cardioDraft;
  const h = Math.floor(c.durationSeconds / 3600);
  const m = Math.floor((c.durationSeconds % 3600) / 60);
  const s = c.durationSeconds % 60;
  openModal(`
    <div class="sheet-title">${c._new ? "Log Session" : "Edit Session"}</div>
    <div class="field-label">Sport</div>
    <div class="sport-seg">
      ${["run", "bike", "swim"].map((sp) => `
        <button class="${c.sport === sp ? "on" : ""}" onclick="A.cardioSport('${sp}')">${SPORTS[sp].emoji} ${SPORTS[sp].label}</button>`).join("")}
    </div>
    <div class="field-label">Date & time</div>
    <input class="input" type="datetime-local" id="cd-date" value="${toLocalDT(c.date)}">
    <div class="field-label">Distance (km)</div>
    <input class="input" type="number" id="cd-dist" inputmode="decimal" step="0.1" min="0" value="${c.distanceKM}">
    <div class="field-label">Duration</div>
    <div class="dur-grid">
      <div><input class="input num-in" type="number" id="cd-h" min="0" max="23" value="${h}"><div class="hint">hours</div></div>
      <div><input class="input num-in" type="number" id="cd-m" min="0" max="59" value="${m}"><div class="hint">min</div></div>
      <div><input class="input num-in" type="number" id="cd-s" min="0" max="59" value="${s}"><div class="hint">sec</div></div>
    </div>
    <div class="field-label">Effort · RPE <span id="cd-rpe-val">${c.effort}</span>/10</div>
    <input type="range" id="cd-rpe" min="1" max="10" step="1" value="${c.effort}"
      oninput="document.getElementById('cd-rpe-val').textContent=this.value">
    <div class="field-label">Notes</div>
    <textarea class="input" id="cd-notes" placeholder="How did it feel?">${esc(c.notes)}</textarea>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="A.closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="A.saveCardio()">Save</button>
    </div>`);
}

function cardioSport(sp) {
  cardioDraft.sport = sp;
  // Preserve typed values before re-render
  cardioDraft.date = new Date($("#cd-date").value || Date.now()).getTime() || cardioDraft.date;
  cardioDraft.distanceKM = parseFloat($("#cd-dist").value) || cardioDraft.distanceKM;
  cardioDraft.durationSeconds =
    (parseInt($("#cd-h").value) || 0) * 3600 + (parseInt($("#cd-m").value) || 0) * 60 + (parseInt($("#cd-s").value) || 0);
  cardioDraft.effort = parseInt($("#cd-rpe").value) || 5;
  cardioDraft.notes = $("#cd-notes").value;
  renderCardioModal();
}

function saveCardio() {
  const c = cardioDraft;
  const date = new Date($("#cd-date").value);
  c.date = isNaN(date.getTime()) ? Date.now() : date.getTime();
  c.distanceKM = Math.max(0, parseFloat($("#cd-dist").value) || 0);
  c.durationSeconds =
    (parseInt($("#cd-h").value) || 0) * 3600 + (parseInt($("#cd-m").value) || 0) * 60 + (parseInt($("#cd-s").value) || 0);
  c.effort = parseInt($("#cd-rpe").value) || 5;
  c.notes = $("#cd-notes").value.trim();
  if (c.distanceKM <= 0 || c.durationSeconds <= 0) { toast("Enter a distance and duration."); return; }
  delete c._new;
  const i = state.cardio.findIndex((x) => x.id === c.id);
  if (i >= 0) state.cardio[i] = c; else state.cardio.unshift(c);
  cardioDraft = null;
  save();
  closeModal();
  render();
}

function deleteCardio(id) {
  confirmSheet("Delete this session?", () => {
    state.cardio = state.cardio.filter((x) => x.id !== id);
    save();
    render();
  }, "Delete");
}

/* ---------- Strava import ---------- */

let stravaParsed = null;

function openStravaImport() {
  stravaParsed = null;
  const cfg = state.strava || {};
  const connected = !!(cfg.workerUrl && cfg.session);
  const lastSync = cfg.lastSync ? new Date(cfg.lastSync * 1000).toLocaleString() : "—";
  openModal(`
    <div class="sheet-title">Strava</div>

    <div class="field-label">Automatic sync</div>
    ${connected ? `
      <div class="card" style="margin-top:2px">
        <div class="card-title" style="color:var(--accent)">✓ Connected${cfg.athlete ? " as " + esc(cfg.athlete) : ""}</div>
        <div class="card-sub" style="margin-top:4px">Last synced: ${esc(lastSync)}</div>
        <div class="card-sub" style="margin-top:2px">Wrong account? Disconnect, then reconnect and use “Switch account” on Strava's page.</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-accent btn-sm" style="flex:1" onclick="A.stravaSyncNow()">Sync now</button>
          <button class="btn btn-ghost btn-sm" style="flex:1" onclick="A.stravaDisconnect()">Disconnect</button>
        </div>
      </div>
    ` : `
      <div class="card-sub" style="line-height:1.6">
        Connect your own Strava account and new runs appear here automatically.
        You approve on Strava's own page — your data stays on this device.
      </div>
      <button class="btn btn-accent" style="margin-top:10px" onclick="A.stravaConnect()">Connect Strava</button>
      <details style="margin-top:10px">
        <summary class="card-sub" style="cursor:pointer">Advanced: use your own backend</summary>
        <input class="input" id="strava-worker" placeholder="${esc(DEFAULT_WORKER_URL)}"
          value="${esc(cfg.workerUrl || "")}" style="margin-top:8px">
      </details>
    `}

    <div class="divider"></div>

    <div class="field-label">Or import a file</div>
    <div class="card-sub" style="line-height:1.6">
      Pick the <b>ZIP</b> Strava emailed you (Settings → My Account → Download or Delete
      Your Account). No need to unzip — re-importing is always safe.
    </div>
    <input class="input" type="file" id="strava-file" accept=".zip,.csv,application/zip,text/csv"
      style="margin-top:10px;padding:9px" onchange="A.stravaFile(event)">
    <div id="strava-preview"></div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="A.closeModal()">Close</button>
      <button class="btn btn-accent" id="strava-import-btn" disabled style="opacity:.4"
        onclick="A.stravaDoImport()">Import</button>
    </div>`);
}

/* ---------- Strava automatic sync (via the Cloudflare Worker backend) ---------- */

function stravaConnect() {
  const input = $("#strava-worker");
  let workerUrl = (input ? input.value : "").trim().replace(/\/+$/, "") || DEFAULT_WORKER_URL;
  if (!/^https?:\/\//.test(workerUrl)) {
    toast("The backend URL must start with https://");
    return;
  }
  state.strava = state.strava || {};
  state.strava.workerUrl = workerUrl;
  save();
  const back = location.origin + location.pathname;
  location.href = workerUrl + "/auth?origin=" + encodeURIComponent(back);
}

function stravaDisconnect() {
  confirmSheet("Disconnect Strava? Already-synced runs stay; new ones just won't come in automatically.", () => {
    if (state.strava) { delete state.strava.session; delete state.strava.lastSync; delete state.strava.athlete; }
    save();
    openStravaImport();
  }, "Disconnect");
}

function stravaSyncNow() { stravaSync(false); }

/* Strava API type/sport_type ("Run","TrailRun","Ride","Swim"…) → our sport */
function apiSport(t) {
  t = (t || "").toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("ride") || t.includes("bike") || t.includes("cycl") || t.includes("velomobile")) return "bike";
  if (t.includes("swim")) return "swim";
  return null;
}

function stravaApiToSession(a) {
  const sport = apiSport(a.sport_type || a.type);
  if (!sport) return null;
  const km = Math.round((a.distance / 1000) * 100) / 100;
  const secs = a.moving_time || a.elapsed_time || 0;
  if (km <= 0 || secs <= 0) return null;
  const rpe = a.perceived_exertion;
  return {
    id: uid(),
    stravaId: String(a.id),
    sport,
    date: Date.parse(a.start_date) || Date.now(),
    distanceKM: km,
    durationSeconds: secs,
    effort: rpe >= 1 && rpe <= 10 ? rpe : 5,
    notes: a.name || "Strava",
  };
}

async function stravaSync(silent) {
  const cfg = state.strava;
  if (!cfg || !cfg.workerUrl || !cfg.session) {
    if (!silent) toast("Not connected to Strava yet.");
    return;
  }
  // small look-back so late-uploaded runs aren't missed; duplicates are ignored
  const after = cfg.lastSync ? Math.max(0, cfg.lastSync - 2 * 86400) : 0;
  try {
    const u = cfg.workerUrl.replace(/\/+$/, "") +
      "/activities?session=" + encodeURIComponent(cfg.session) + "&after=" + after;
    const res = await fetch(u);
    const data = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(data)) {
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }
    const sessions = data.map(stravaApiToSession).filter(Boolean);
    const result = importStravaSessions({ sessions });
    cfg.lastSync = Math.floor(Date.now() / 1000);
    save();
    render();
    if (!silent) {
      toast("Synced — " + result.added + " new activit" + (result.added === 1 ? "y" : "ies") +
        (result.dup ? " (" + result.dup + " already had)" : "") + ".");
    }
  } catch (e) {
    if (!silent) toast("Couldn't sync with Strava: " + e.message);
  }
}

/* On returning from the Strava authorize redirect (#strava_session=…) */
function handleStravaRedirect() {
  const m = (location.hash || "").match(/strava_session=([A-Za-z0-9._-]+)/);
  if (!m) return false;
  localStorage.setItem("tritrack:welcomed", "1");
  state.strava = state.strava || {};
  state.strava.workerUrl = state.strava.workerUrl || DEFAULT_WORKER_URL;
  state.strava.session = m[1];
  const an = (location.hash || "").match(/strava_athlete=([^&]+)/);
  if (an) { try { state.strava.athlete = decodeURIComponent(an[1]).slice(0, 60); } catch {} }
  state.strava.lastSync = 0; // first sync pulls full history
  save();
  history.replaceState(null, "", location.pathname + location.search);
  setTimeout(() => stravaSync(false), 200);
  return true;
}

function stravaAutoSync() {
  const cfg = state.strava;
  if (cfg && cfg.workerUrl && cfg.session) stravaSync(true);
}

/* Pull a named file out of a .zip in the browser — no library. Reads the central
   directory, then inflates the entry with the built-in DecompressionStream. */
async function extractFromZip(buffer, wantedName) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const n = dv.byteLength;
  const names = new TextDecoder();
  // Find End Of Central Directory record (may be followed by a comment).
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid zip");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  let found = null;
  for (let i = 0; i < count && p + 46 <= n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = names.decode(u8.subarray(p + 46, p + 46 + nameLen)).toLowerCase();
    if (name.endsWith(wantedName)) {
      found = { method, compSize, localOff };
      if (name === wantedName) break; // prefer the file at the zip root
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!found) throw new Error(wantedName + " not found in the zip");
  const lh = found.localOff;
  if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error("bad zip entry");
  const dataStart = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  const comp = u8.subarray(dataStart, dataStart + found.compSize);
  let raw;
  if (found.method === 0) {
    raw = comp; // stored, no compression
  } else if (found.method === 8) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("this browser can't open zips — unzip it and pick activities.csv");
    }
    const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error("unsupported zip compression");
  }
  return new TextDecoder("utf-8").decode(raw);
}

/* Accept either Strava's whole .zip archive or a bare activities.csv. */
async function readStravaFile(file) {
  const buffer = await file.arrayBuffer();
  const u8 = new Uint8Array(buffer);
  const isZip = u8[0] === 0x50 && u8[1] === 0x4b; // "PK" magic
  if (isZip) return await extractFromZip(buffer, "activities.csv");
  return new TextDecoder("utf-8").decode(u8);
}

function stravaShowPreview() {
  const host = $("#strava-preview");
  const btn = $("#strava-import-btn");
  if (!host) return;
  if (!stravaParsed || stravaParsed.sessions.length === 0) {
    host.innerHTML = `<div class="empty-note" style="padding:18px">
      No runs, rides or swims found in that file. Pick the <b>ZIP</b> Strava emailed you
      (or its <b>activities.csv</b>).</div>`;
    if (btn) { btn.disabled = true; btn.style.opacity = ".4"; }
    return;
  }
  const counts = {};
  stravaParsed.sessions.forEach((s) => (counts[s.sport] = (counts[s.sport] || 0) + 1));
  const existing = new Set(state.cardio.filter((c) => c.stravaId).map((c) => c.stravaId));
  const fresh = stravaParsed.sessions.filter((s) => !s.stravaId || !existing.has(s.stravaId)).length;
  const bits = [
    counts.run ? `🏃 ${counts.run} runs` : "",
    counts.bike ? `🚴 ${counts.bike} rides` : "",
    counts.swim ? `🏊 ${counts.swim} swims` : "",
  ].filter(Boolean).join(" · ");
  host.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="card-title">Found ${stravaParsed.sessions.length} sessions</div>
      <div class="card-sub" style="margin-top:6px">${bits}</div>
      <div class="card-sub" style="margin-top:8px;color:var(--accent);font-weight:700">
        ${fresh} new${fresh !== stravaParsed.sessions.length ? ` · ${stravaParsed.sessions.length - fresh} already imported` : ""}</div>
    </div>`;
  if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
}

function stravaFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  const host = $("#strava-preview");
  const btn = $("#strava-import-btn");
  if (!file) return;
  if (host) host.innerHTML = `<div class="card-sub" style="margin-top:14px">Reading ${esc(file.name)}…</div>`;
  readStravaFile(file)
    .then((text) => {
      try { stravaParsed = parseStravaCSV(text); }
      catch (e) { stravaParsed = null; }
      stravaShowPreview();
    })
    .catch((err) => {
      stravaParsed = null;
      if (host) host.innerHTML = `<div class="empty-note" style="padding:18px">Couldn't read that file (${esc(err.message)}). Pick the <b>ZIP</b> Strava emailed you, or its <b>activities.csv</b>.</div>`;
      if (btn) { btn.disabled = true; btn.style.opacity = ".4"; }
    });
}

function stravaDoImport() {
  if (!stravaParsed) return;
  const res = importStravaSessions(stravaParsed);
  stravaParsed = null;
  closeModal();
  ui.activitySeg = "endurance";
  render();
  toast(`Imported ${res.added} new session${res.added === 1 ? "" : "s"}${res.dup ? ` · ${res.dup} duplicate${res.dup === 1 ? "" : "s"} skipped` : ""}.`);
}

/* ---------- Workout detail ---------- */

function showWorkout(id) {
  const w = state.history.find((x) => x.id === id);
  if (!w) return;
  openModal(`
    <div class="sheet-title">${esc(w.name)}</div>
    <div class="card-sub">${fmtDate(w.date)} · ${fmtDur(w.durationSeconds)} · ${totalSets(w)} sets · ${Math.round(totalVolume(w))} kg volume</div>
    ${w.exercises.map((e) => `
      <div class="cat-head">${esc(e.name)}</div>
      ${e.sets.map((s, i) => `
        <div class="list-row" style="padding:7px 4px">
          <div class="grow" style="cursor:default"><span class="muted small">Set ${i + 1}</span></div>
          <span style="font-size:13.5px;font-variant-numeric:tabular-nums">${s.weight > 0 ? s.weight + " kg × " : ""}${s.reps}${s.weight > 0 ? "" : " reps"}</span>
          <span style="color:${s.done ? "var(--accent)" : "var(--text-ter)"}">${s.done ? "✓" : "○"}</span>
        </div>`).join("")}
      ${e.notes ? `<div class="card-sub" style="padding:4px">${esc(e.notes)}</div>` : ""}`).join("")}
    ${w.notes ? `<div class="cat-head">Notes</div><div class="card-sub" style="padding:4px">${esc(w.notes)}</div>` : ""}
    <div class="sheet-actions">
      <button class="btn btn-danger" onclick="A.deleteWorkout('${w.id}')">Delete</button>
      <button class="btn btn-ghost" onclick="A.closeModal()">Done</button>
    </div>`);
}

function deleteWorkout(id) {
  confirmSheet("Delete this workout from history?", () => {
    state.history = state.history.filter((x) => x.id !== id);
    save();
    render();
  }, "Delete");
}

/* ---------- Plan settings ---------- */

function openPlanSettings() {
  const W = planWeeks();
  openModal(`
    <div class="sheet-title">Plan Settings</div>
    <div class="field-label">Plan start date</div>
    <input class="input" type="date" id="plan-start" value="${toLocalDate(state.planStartDate)}">
    <div class="card-sub" style="margin-top:8px">Race day is the last day of week ${W} — exactly ${W} weeks after the start date.</div>
    <div class="sheet-actions" style="flex-direction:column">
      <button class="btn btn-accent" onclick="A.applyPlanStart(false)">Apply Start Date</button>
      ${state.planMeta
        ? `<button class="btn btn-danger" onclick="A.restoreBuiltinPlan()">Restore built-in 20-week plan (resets check-offs)</button>`
        : `<button class="btn btn-danger" onclick="A.applyPlanStart(true)">Regenerate Plan (resets check-offs)</button>`}
      <button class="btn btn-ghost" onclick="A.closeModal()">Cancel</button>
    </div>`);
}

function restoreBuiltinPlan() {
  confirmSheet("Replace your coach-built plan with the built-in 20-week marathon plan? All check-offs will be cleared.", () => {
    delete state.planMeta;
    state.plan = generatePlan();
    state.planVersion = PLAN_VERSION;
    ui.planWeek = null;
    save();
    render();
  }, "Restore");
}

function applyPlanStart(regen) {
  const v = $("#plan-start").value;
  const d = v ? new Date(v + "T00:00:00") : null;
  if (!d || isNaN(d.getTime())) return;
  const doIt = () => {
    state.planStartDate = d.getTime();
    if (regen) state.plan = generatePlan();
    ui.planWeek = null;
    save();
    closeModal();
    render();
  };
  if (regen) confirmSheet("Regenerate the whole plan? All check-offs will be cleared.", doIt, "Regenerate");
  else doIt();
}

/* ============================== Active workout ============================== */

let aw = null; // { w, start, restEnd, interval }
const REST_SECONDS = 90;

function startEmpty() {
  startWorkout({ id: uid(), name: "Quick Workout", date: Date.now(), notes: "", durationSeconds: 0, exercises: [] });
}

function startTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  const w = JSON.parse(JSON.stringify(t));
  w.id = uid();
  w.date = Date.now();
  w.durationSeconds = 0;
  w.notes = "";
  w.exercises.forEach((e) => {
    e.id = uid();
    e.sets.forEach((s) => { s.id = uid(); s.done = false; });
  });
  startWorkout(w);
}

function startWorkout(w) {
  aw = { w, start: Date.now(), restEnd: null };
  renderAW();
  aw.interval = setInterval(awTick, 1000);
}

function renderAW() {
  if (!aw) { $("#aw-root").innerHTML = ""; return; }
  const w = aw.w;
  $("#aw-root").innerHTML = `
    <div class="aw"><div class="aw-inner">
      <div class="aw-top">
        <button class="icon-btn" onclick="A.awDiscard()">✕</button>
        <input class="aw-name" id="aw-name" placeholder="Workout name" value="${esc(w.name)}"
          oninput="A.awName(this.value)">
      </div>
      <div class="aw-meta">
        <span class="aw-timer" id="aw-time">${fmtDur((Date.now() - aw.start) / 1000)}</span>
        <span>${w.exercises.length} exercises · ${totalSets(w)} sets</span>
      </div>
      <div class="aw-body" id="aw-body">${awBodyHTML()}</div>
      <div id="aw-rest"></div>
    </div></div>`;
  awRenderRest();
}

function awBodyHTML() {
  const w = aw.w;
  return `
    <div class="stack">
      ${w.exercises.map((e) => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="card-title">${esc(e.name)}</div>
            <button class="icon-btn" style="width:30px;height:30px;font-size:13px" title="Remove exercise"
              onclick="A.awRemoveExercise('${e.id}')">✕</button>
          </div>
          <div class="set-head"><span>SET</span><span>KG</span><span>REPS</span><span>✓</span></div>
          ${e.sets.map((s, i) => `
            <div class="set-row">
              <div class="set-num">${i + 1}</div>
              <input class="num-in" type="number" inputmode="decimal" step="0.5" min="0" value="${s.weight}"
                onchange="A.awEditSet('${e.id}','${s.id}','weight',this.value)">
              <input class="num-in" type="number" inputmode="numeric" min="0" value="${s.reps}"
                onchange="A.awEditSet('${e.id}','${s.id}','reps',this.value)">
              <button class="check ${s.done ? "on" : ""}" onclick="A.awToggleSet('${e.id}','${s.id}')">${s.done ? "✓" : ""}</button>
            </div>`).join("")}
          <button class="btn btn-ghost btn-sm" style="width:100%;margin-top:6px" onclick="A.awAddSet('${e.id}')">＋ Add Set</button>
          <input class="input" style="margin-top:10px;font-size:13px" placeholder="Exercise notes…"
            value="${esc(e.notes)}" onchange="A.awExNotes('${e.id}',this.value)">
        </div>`).join("")}
      <button class="btn btn-ghost" onclick="A.awAddExercise()">＋ Add Exercise</button>
      <textarea class="input" placeholder="Workout notes…" onchange="A.awNotes(this.value)">${esc(w.notes)}</textarea>
      <button class="btn btn-accent" ${w.exercises.length === 0 ? "disabled style='opacity:.4'" : ""}
        onclick="A.awFinish()">Finish Workout</button>
    </div>`;
}

function awRefreshBody() {
  const body = $("#aw-body");
  if (body) body.innerHTML = awBodyHTML();
  const meta = document.querySelector(".aw-meta span:last-child");
  if (meta && aw) meta.textContent = `${aw.w.exercises.length} exercises · ${totalSets(aw.w)} sets`;
}

function awTick() {
  if (!aw) return;
  const t = $("#aw-time");
  if (t) t.textContent = fmtDur((Date.now() - aw.start) / 1000);
  awRenderRest();
}

function awRenderRest() {
  const host = $("#aw-rest");
  if (!host || !aw) return;
  if (!aw.restEnd || aw.restEnd <= Date.now()) {
    if (host.innerHTML) host.innerHTML = "";
    return;
  }
  const remaining = Math.ceil((aw.restEnd - Date.now()) / 1000);
  const pct = Math.max(0, Math.min(100, 100 * (1 - remaining / REST_SECONDS)));
  // Build the banner once; per-second ticks only touch the text node and bar width
  if (!host.querySelector(".rest-banner")) {
    host.innerHTML = `
      <div class="rest-banner">
        <span style="font-size:18px">⏳</span>
        <div class="bar">
          <div class="t" id="rest-t"></div>
          <div class="progressbar" style="margin-top:0"><div id="rest-bar" style="transition:width 1s linear"></div></div>
        </div>
        <button class="skip" onclick="A.awSkipRest()">Skip</button>
      </div>`;
  }
  $("#rest-t").textContent = `REST · ${fmtDur(remaining)}`;
  $("#rest-bar").style.width = pct + "%";
}

function awName(v) { if (aw) aw.w.name = v; }
function awNotes(v) { if (aw) aw.w.notes = v; }

function awExNotes(exId, v) {
  const e = aw?.w.exercises.find((x) => x.id === exId);
  if (e) e.notes = v;
}

function awEditSet(exId, setId, field, value) {
  const e = aw?.w.exercises.find((x) => x.id === exId);
  const s = e?.sets.find((x) => x.id === setId);
  if (!s) return;
  if (field === "weight") s.weight = Math.max(0, parseFloat(value) || 0);
  else s.reps = Math.max(0, parseInt(value) || 0);
}

function awToggleSet(exId, setId) {
  const e = aw?.w.exercises.find((x) => x.id === exId);
  const s = e?.sets.find((x) => x.id === setId);
  if (!s) return;
  s.done = !s.done;
  if (s.done) aw.restEnd = Date.now() + REST_SECONDS * 1000;
  awRefreshBody();
  awRenderRest();
}

function awAddSet(exId) {
  const e = aw?.w.exercises.find((x) => x.id === exId);
  if (!e) return;
  const proto = e.sets[e.sets.length - 1] || { reps: 10, weight: 0 };
  e.sets.push({ id: uid(), reps: proto.reps, weight: proto.weight, done: false });
  awRefreshBody();
}

function awRemoveExercise(exId) {
  if (!aw) return;
  confirmSheet("Remove this exercise from the workout?", () => {
    if (!aw) return;
    aw.w.exercises = aw.w.exercises.filter((x) => x.id !== exId);
    awRefreshBody();
  }, "Remove");
}

function awAddExercise() {
  const opts = [...state.exercises].sort((a, b) => a.name.localeCompare(b.name));
  openModal(`
    <div class="sheet-title">Add Exercise</div>
    <input class="input" id="pick-search" placeholder="Search…" style="margin-top:10px"
      oninput="A.awFilterPick(this.value)">
    <div id="pick-list">${awPickListHTML(opts)}</div>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="A.closeModal()">Cancel</button></div>`);
  setTimeout(() => $("#pick-search")?.focus(), 80);
}

function awPickListHTML(list) {
  if (!list.length) return `<div class="empty-note" style="padding:20px">No matches.</div>`;
  return list.map((e) => `
    <div class="list-row">
      <div class="grow" onclick="A.awPick('${e.id}')">
        <div class="name">${esc(e.name)}</div>
        <div class="meta">${esc(e.category)}</div>
      </div>
    </div>`).join("");
}

function awFilterPick(q) {
  q = q.trim().toLowerCase();
  const list = state.exercises
    .filter((e) => !q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const host = $("#pick-list");
  if (host) host.innerHTML = awPickListHTML(list);
}

function awPick(id) {
  const ex = state.exercises.find((e) => e.id === id);
  if (!ex || !aw) return;
  aw.w.exercises.push({
    id: uid(), exerciseID: ex.id, name: ex.name, notes: "",
    sets: Array.from({ length: 3 }, () => ({ id: uid(), reps: 10, weight: 0, done: false })),
  });
  closeModal();
  awRefreshBody();
}

function awFinish() {
  if (!aw || aw.w.exercises.length === 0) return;
  aw.w.durationSeconds = Math.round((Date.now() - aw.start) / 1000);
  aw.w.date = Date.now();
  aw.w.name = (aw.w.name || "").trim() || "Workout";
  state.history.unshift(aw.w);
  endAW();
  save();
  render();
}

function awDiscard() {
  if (!aw) return;
  confirmSheet("Discard this workout? Nothing will be saved.", () => endAW(), "Discard");
}

function awSkipRest() {
  if (aw) aw.restEnd = null;
  awRenderRest();
}

function endAW() {
  if (aw?.interval) clearInterval(aw.interval);
  aw = null;
  $("#aw-root").innerHTML = "";
}

/* ============================== AI Coach ============================== */
/* The Coach tab turns "goal + time + body" into a complete periodized plan.
   Two engines produce the same JSON shape:
   - Claude via your Cloudflare Worker's /ai-plan endpoint (see AI-SETUP.md), and
   - the built-in coach below (offline, instant, free),
   so the app is fully functional with or without the AI backend. */

const COACH_GOALS = {
  "5k":       { label: "5K",            peakLong: 10, peakKM: 32 },
  "10k":      { label: "10K",           peakLong: 14, peakKM: 42 },
  "half":     { label: "Half Marathon", peakLong: 18, peakKM: 52 },
  "marathon": { label: "Marathon",      peakLong: 32, peakKM: 62 },
  "im703":    { label: "Ironman 70.3",  peakLong: 18, peakKM: 45, tri: true, peakRide: 85,  peakSwim: 2400 },
  "im":       { label: "Ironman",       peakLong: 30, peakKM: 55, tri: true, peakRide: 150, peakSwim: 3800 },
};

const COACH_PHASE_COLORS = { Base: "#5ce6b8", Build: "#ff9440", Peak: "#ff5a5a", Taper: "#669eff" };

const COACH_PUSH = "Bench or push-ups 4x8-12, Incline DB press 3x10, Shoulder press 3x10, Lateral raises 3x12, Triceps 3x12";
const COACH_PULL = "Pull-ups or rows 4x8-10, Seated row 3x12, Bicep curl 3x12, Rear delt fly 3x15, Face pulls 3x15";
const COACH_LEGS = "Goblet squat 4x10, Split squat 3x10/side, Step-up 3x10/side, Hip thrust 3x12, Calf raise 3x15, Plank 3x45s";
const COACH_CORE = "Plank 3x45s, Side plank 3x30s/side, Dead bug 3x12, Bird-dog 3x10/side, Glute bridge 3x15";

/* English + Danish injury keywords → what the plan must work around. */
function injuryFlags(text) {
  const t = (text || "").toLowerCase();
  return {
    leg: /knee|knæ|shin|skinneben|achilles|akilles|ankle|ankel|foot|fod|plantar|hip|hofte|hamstring|baglår|calf|læg|it.?band|løberknæ|stress ?frac|træthedsbrud/.test(t),
    back: /back|ryg|disc|diskus|spine|prolaps/.test(t),
    shoulder: /shoulder|skulder|rotator/.test(t),
    any: !!t.trim(),
  };
}

/* Built-in coach: deterministic periodized plan generator. */
function buildSmartPlan(inp) {
  const goal = COACH_GOALS[inp.goal] || COACH_GOALS.marathon;
  const W = inp.weeks;
  const inj = injuryFlags(inp.injuries);
  const lvl = { beginner: 0.8, intermediate: 1, advanced: 1.12 }[inp.level] || 1;

  /* Phases: Base → Build → Peak → Taper (taper includes race week). */
  const taper = W >= 14 ? 2 : 1;
  let base = Math.max(1, Math.round((W - taper) * 0.45));
  let build = Math.max(1, Math.round((W - taper) * 0.32));
  let peak = W - taper - base - build;
  while (peak < 0 && (base > 1 || build > 1)) { if (base > build) base--; else build--; peak = W - taper - base - build; }
  const phases = [
    { name: "Base", from: 1, to: base },
    { name: "Build", from: base + 1, to: base + build },
    { name: "Peak", from: base + build + 1, to: W - taper },
    { name: "Taper", from: W - taper + 1, to: W },
  ].filter((p) => p.from <= p.to).map((p) => ({ ...p, color: COACH_PHASE_COLORS[p.name] }));
  const phaseOf = (w) => (phases.find((p) => w >= p.from && w <= p.to) || phases[phases.length - 1]).name;

  /* Weekly running volume: ramp from where the athlete is to a goal-appropriate
     peak, deload every 4th week, then taper. An injury caps the ceiling. */
  const lvlStart = { beginner: 15, intermediate: 25, advanced: 40 }[inp.level] || 25;
  const startKM = Math.max(10, Math.min(inp.weeklyKM || lvlStart, goal.peakKM * lvl * 0.85));
  let peakKM = Math.max(startKM + 4, goal.peakKM * lvl);
  if (inj.leg) peakKM = Math.min(peakKM, startKM * 1.35 + 8);
  const lastLoad = W - taper;
  const weekKM = [];
  for (let w = 1; w <= W; w++) {
    let km;
    if (w <= lastLoad) {
      const f = lastLoad <= 1 ? 1 : (w - 1) / (lastLoad - 1);
      km = startKM + (peakKM - startKM) * f;
      if (w % 4 === 0 && w < lastLoad) km *= 0.72;
    } else {
      km = w === W ? peakKM * 0.3 : peakKM * 0.55;
    }
    weekKM.push(Math.round(km));
  }

  const longStart = Math.max(6, Math.min(inp.longestRun || startKM * 0.35, goal.peakLong));
  const longPeak = inj.leg ? Math.round(longStart + (goal.peakLong - longStart) * 0.7) : goal.peakLong;

  /* Session slots by available days — long run + one quality session first,
     then cross-training / strength, mirroring the built-in plan's layout. */
  const order = goal.tri
    ? [["long", 7], ["quality", 4], ["swim", 3], ["ride", 6], ["easy", 2], ["strengthA", 1], ["recovery", 5]]
    : [["long", 7], ["quality", 4], ["easy", 2], ["strengthA", 1], ["strengthB", 6], ["strengthC", 3], ["recovery", 5]];
  const slots = order.slice(0, Math.max(3, Math.min(7, inp.days)));

  const strengthFor = (kind) => {
    if (inj.shoulder && kind !== "strengthC")
      return ["Core & stability (shoulder-safe)", COACH_CORE + " — no overhead pressing until pain-free"];
    if (kind === "strengthA") return ["Push", COACH_PUSH];
    if (kind === "strengthB") return ["Pull", COACH_PULL];
    return ["Legs + core", COACH_LEGS + (inj.back ? " — keep the spine neutral, no heavy axial loading" : "")];
  };
  const painNote = inj.leg ? " · stop immediately if pain flares" : "";

  const sessions = [];
  const push = (week, day, sport, title, detail) => sessions.push({ week, day, sport, title, detail });

  for (let w = 1; w <= W; w++) {
    const f = lastLoad <= 1 ? 1 : Math.min(1, (w - 1) / (lastLoad - 1));
    const ph = phaseOf(w);
    const raceWeek = w === W;
    const deload = w % 4 === 0 && w < lastLoad;
    const wkm = weekKM[w - 1];

    let longKM = Math.round(longStart + (longPeak - longStart) * f);
    if (deload) longKM = Math.round(longKM * 0.8);
    if (ph === "Taper" && !raceWeek) longKM = Math.round(longPeak * 0.55);
    longKM = Math.max(6, Math.min(longKM, Math.max(6, Math.round(wkm * 0.45))));

    const easySlots = slots.filter((s) => s[0] === "easy" || s[0] === "recovery").length;
    const qKM = Math.max(4, Math.min(15, Math.round((wkm - longKM) * (easySlots ? 0.45 : 0.9))));
    const easyKM = easySlots ? Math.max(4, Math.round((wkm - longKM - qKM) / easySlots)) : 0;

    const usedDays = new Set();
    for (const [kind, day] of slots) {
      usedDays.add(day);

      if (raceWeek) {
        if (kind === "long") push(w, day, "run", `🏁 RACE DAY — ${goal.label}`, "Start controlled, settle into goal pace, and enjoy it — you've done the work.");
        else if (kind === "quality") push(w, day, "run", "Sharpener · 3 km", "Easy jog + 4x20s strides at race pace");
        else if (kind === "easy") push(w, day, "run", "Shakeout · 4 km", "Very relaxed — just keep the legs loose");
        else if (kind === "swim") push(w, day, "swim", "Swim · 15 min easy", "Loosen up — short and smooth");
        else if (kind === "ride") push(w, day, "bike", "Spin · 30 min easy", "Legs loose, zero strain");
        else push(w, day, "rest", "Rest", "Total rest — save it all for race day");
        continue;
      }

      if (kind === "long") {
        const detail = ph === "Peak" && !deload
          ? `Easy pace — run the last ${Math.max(2, Math.round(longKM * 0.25))} km at goal race pace` + painNote
          : "Easy and controlled — conversational pace" + painNote;
        push(w, day, "run", `Long run · ${longKM} km`, detail);
      } else if (kind === "quality") {
        let t, dt;
        if (ph === "Base") {
          if (w % 2) { t = "Strides + hills"; dt = `${qKM} km easy incl. 6x20s strides + 4x30s hill sprints`; }
          else { t = "Intervals"; dt = `8x400m fast (jog 200m between) — ~${qKM} km total`; }
        } else if (ph === "Build") {
          if (w % 2) { t = "Tempo run"; dt = `2 km warm-up + ${10 + Math.round(15 * f)} min comfortably hard + 2 km cool-down — ~${qKM} km`; }
          else { t = "Intervals"; dt = `6x800m (jog 300m between) — ~${qKM} km total`; }
        } else if (ph === "Peak") {
          t = "Race-pace intervals"; dt = `2 km warm-up + 3x${8 + Math.round(4 * f)} min @ goal pace (2 min jog between) + 2 km cool-down — ~${qKM} km`;
        } else {
          t = "Sharpener"; dt = `${qKM} km incl. 4x3 min @ race pace`;
        }
        push(w, day, "run", t + (deload ? " (deload)" : ""), dt + painNote);
      } else if (kind === "easy") {
        if (inj.leg) push(w, day, "bike", "Cross-train · Bike", "40–60 min Zone 2 — low-impact stand-in for an easy run");
        else push(w, day, "run", `Easy run · ${easyKM} km`, "Conversational pace — you should be able to chat");
      } else if (kind === "recovery") {
        if (inj.leg) push(w, day, "bike", "Recovery spin", "30 min very easy — flush the legs");
        else push(w, day, "run", `Recovery jog · ${Math.max(4, Math.round(easyKM * 0.7))} km`, "Very easy — this run should feel like a rest");
      } else if (kind === "swim") {
        if (inj.shoulder) { push(w, day, "bike", "Spin (shoulder-safe)", "45 min Zone 2 — swimming paused until the shoulder is pain-free"); continue; }
        let m = Math.round((1200 + ((goal.peakSwim || 2000) - 1200) * f) / 100) * 100;
        if (deload) m = Math.round(m * 0.8 / 100) * 100;
        if (ph === "Taper") m = Math.round(m * 0.5 / 100) * 100;
        push(w, day, "swim", `Swim · ${m} m`, ph === "Base" ? "Technique focus — drills + steady laps" : "Continuous endurance swim, smooth breathing");
      } else if (kind === "ride") {
        let rk = Math.round(30 + ((goal.peakRide || 60) - 30) * f);
        if (deload) rk = Math.round(rk * 0.75);
        if (ph === "Taper") rk = Math.round(rk * 0.5);
        push(w, day, "bike", `Long ride · ${rk} km`, "Zone 2 — steady effort, practice fueling");
      } else {
        const [t, dt] = strengthFor(kind);
        push(w, day, "strength", t + (deload ? " (deload)" : ""), dt + (deload ? " — deload: −1 set each" : ""));
      }
    }
    for (let day = 1; day <= 7; day++) {
      if (!usedDays.has(day)) push(w, day, "rest", "Rest", "Active recovery or full rest");
    }
  }

  const summary =
    `${W} weeks to ${goal.label} · ${slots.length} sessions/week · peaks at ${Math.max(...weekKM)} km/week with a ${longPeak} km longest run.` +
    (goal.tri ? " Swim and bike sessions build the triathlon base alongside your running." : "") +
    (inj.any ? " Adjusted for your injury notes — volume is capped and low-impact work swapped in. Never push through pain." : "");

  return { goalLabel: goal.label, weeks: W, phases, weekKM, summary, sessions };
}

/* Validate + normalize a plan from either engine into what the app stores. */
function normalizePlan(raw, inp) {
  if (!raw || typeof raw !== "object") throw new Error("empty plan");
  const W = Math.max(1, Math.min(52, parseInt(raw.weeks) || inp.weeks));
  const sessions = [];
  for (const s of raw.sessions || []) {
    const week = parseInt(s.week), day = parseInt(s.day);
    if (!(week >= 1 && week <= W && day >= 1 && day <= 7)) continue;
    const sport = SPORTS[s.sport] ? s.sport : "run";
    sessions.push({
      id: uid(), week, day, sport, completed: false,
      title: String(s.title || SPORTS[sport].label).slice(0, 90),
      detail: String(s.detail || "").slice(0, 300),
    });
  }
  if (sessions.length < W * 2) throw new Error("plan too sparse");
  for (let w = 1; w <= W; w++) {
    const days = new Set(sessions.filter((s) => s.week === w).map((s) => s.day));
    for (let d = 1; d <= 7; d++) {
      if (!days.has(d)) sessions.push({ id: uid(), week: w, day: d, sport: "rest", title: "Rest", detail: "Active recovery or full rest", completed: false });
    }
  }
  let phases = Array.isArray(raw.phases)
    ? raw.phases.map((p, i) => ({
        name: String(p.name || "Phase " + (i + 1)).slice(0, 24),
        from: Math.max(1, parseInt(p.from) || 1),
        to: Math.min(W, parseInt(p.to) || W),
        color: p.color || COACH_PHASE_COLORS[p.name] || PHASE_PALETTE[i % PHASE_PALETTE.length],
      })).filter((p) => p.from <= p.to)
    : [];
  if (!phases.length) phases = [{ name: "Training", from: 1, to: W, color: PHASE_PALETTE[0] }];
  const weekKM = Array.isArray(raw.weekKM)
    ? Array.from({ length: W }, (_, i) => Math.max(0, Math.round(parseFloat(raw.weekKM[i]) || 0)))
    : null;
  return {
    goalLabel: String(raw.goalLabel || (COACH_GOALS[inp.goal] || {}).label || "Race").slice(0, 40),
    weeks: W, phases, weekKM,
    summary: String(raw.summary || "").slice(0, 500),
    sessions: sessions.sort((a, b) => a.week - b.week || a.day - b.day),
  };
}

async function fetchAIPlan(url, inp) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(url + "/ai-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inp),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) throw new Error((data && data.error) || "HTTP " + res.status);
    return data.plan || data;
  } finally {
    clearTimeout(t);
  }
}

function coachInputs() {
  if (!ui.coach.inputs) {
    ui.coach.inputs = Object.assign(
      { goal: "marathon", weeks: 16, raceDate: "", days: 5, level: "intermediate", weeklyKM: "", longestRun: "", injuries: "", notes: "" },
      state.coachInputs || {}
    );
  }
  return ui.coach.inputs;
}

function coachRaceDate(v) {
  const inp = coachInputs();
  inp.raceDate = v || "";
  const ts = v ? new Date(v + "T00:00:00").getTime() : NaN;
  if (!isNaN(ts) && ts > Date.now()) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    inp.weeks = Math.max(4, Math.min(40, Math.round((ts - d.getTime()) / (7 * DAY))));
  }
  render();
}

async function coachGenerate() {
  if (ui.coach.busy) return;
  const inp = { ...coachInputs() };
  inp.weeks = Math.max(4, Math.min(40, parseInt(inp.weeks) || 16));
  inp.days = Math.max(3, Math.min(7, parseInt(inp.days) || 5));
  inp.weeklyKM = Math.max(0, parseFloat(inp.weeklyKM) || 0);
  inp.longestRun = Math.max(0, parseFloat(inp.longestRun) || 0);
  if (!COACH_GOALS[inp.goal]) inp.goal = "marathon";
  inp.injuries = String(inp.injuries || "").slice(0, 600);
  inp.notes = String(inp.notes || "").slice(0, 600);
  ui.coach.inputs = { ...inp };
  state.coachInputs = { ...inp };
  save();

  ui.coach.busy = true;
  ui.coach.error = null;
  render();

  let plan = null, engine = "coach", aiNote = null;
  const url = (state.aiWorkerUrl || DEFAULT_WORKER_URL).trim().replace(/\/+$/, "");
  if (url) {
    try {
      plan = normalizePlan(await fetchAIPlan(url, inp), inp);
      engine = "ai";
    } catch (e) {
      // Not an error for the user — the built-in coach still delivers a plan.
      aiNote = "AI backend not reachable right now — the built-in coach engine made this plan.";
      console.warn("AI plan fallback:", e.message);
    }
  }
  if (!plan) {
    try {
      plan = normalizePlan(buildSmartPlan(inp), inp);
    } catch (e) {
      ui.coach.busy = false;
      ui.coach.error = "Couldn't build a plan: " + e.message;
      render();
      return;
    }
  }
  ui.coach.busy = false;
  ui.coach.result = { plan, engine, aiNote };
  render();
}

function coachApply() {
  const r = ui.coach.result;
  if (!r) return;
  if (state.plan.some((s) => s.completed)) {
    confirmSheet("Replace your current plan? Existing check-offs will be cleared.", () => doCoachApply(), "Replace");
    return;
  }
  doCoachApply();
}

function doCoachApply() {
  const r = ui.coach.result;
  if (!r) return;
  const plan = r.plan;
  state.plan = plan.sessions.map((s) => ({ ...s, id: uid(), completed: false }));
  state.planMeta = {
    weeks: plan.weeks, goalLabel: plan.goalLabel, phases: plan.phases,
    weekKM: plan.weekKM, summary: plan.summary, engine: r.engine, created: Date.now(),
  };
  // Anchor the calendar: a race date pins the last day; otherwise start this Monday.
  const inp = state.coachInputs || {};
  const rd = inp.raceDate ? new Date(inp.raceDate + "T00:00:00").getTime() : NaN;
  if (!isNaN(rd) && rd > Date.now()) {
    const d = new Date(rd); d.setDate(d.getDate() - (plan.weeks * 7 - 1));
    state.planStartDate = d.getTime();
  } else {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    state.planStartDate = d.getTime();
  }
  state.planVersion = PLAN_VERSION;
  ui.coach.result = null;
  ui.planWeek = null;
  save();
  ui.tab = "plan";
  render();
}

function openAiSettings() {
  openModal(`
    <div class="sheet-title">AI Engine</div>
    <div class="card-sub" style="line-height:1.6">
      The Coach first asks the Claude AI backend (it reads your injuries &amp; notes);
      if the backend doesn't answer, the built-in engine builds your plan instantly
      instead — so this always works. The default backend is preconfigured; only
      change it if you host your own (see <b>AI-SETUP.md</b>).
    </div>
    <div class="field-label">Backend URL</div>
    <input class="input" id="ai-url" placeholder="${esc(DEFAULT_WORKER_URL)}" value="${esc(state.aiWorkerUrl || "")}">
    <div class="card-sub" style="margin-top:6px">Leave empty to use the default backend.</div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" onclick="A.closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="A.saveAiSettings()">Save</button>
    </div>`);
}

function saveAiSettings() {
  const v = ($("#ai-url").value || "").trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//.test(v)) { toast("The URL must start with https://"); return; }
  if (v) state.aiWorkerUrl = v; else delete state.aiWorkerUrl;
  save();
  closeModal();
  render();
}

/* ---------- Welcome (first launch) ---------- */
/* One screen, two choices: connect Strava (one tap, no setup) or skip.
   Shown once per browser; returning from the Strava redirect also counts. */

const WELCOMED_KEY = "tritrack:welcomed";

function showWelcome() {
  $("#overlay-root").innerHTML = `
    <div class="welcome">
      <div class="welcome-inner">
        <img src="icon-192.png" class="welcome-logo" alt="TriTrack AI">
        <div class="welcome-title">TriTrack AI</div>
        <div class="welcome-sub">Your AI training coach — 5K to Ironman.<br>
          Everything you log stays on <b>your</b> phone.</div>
        <button class="btn btn-strava" onclick="A.welcomeStrava()">Connect with Strava</button>
        <div class="welcome-hint">Your runs sync in automatically. You log in on Strava's own page — this app never sees your password.</div>
        <button class="btn btn-ghost" style="width:100%" onclick="A.welcomeSkip()">Skip for now</button>
      </div>
    </div>`;
}

function welcomeSkip() {
  localStorage.setItem(WELCOMED_KEY, "1");
  closeModal();
}

function welcomeStrava() {
  localStorage.setItem(WELCOMED_KEY, "1");
  state.strava = state.strava || {};
  state.strava.workerUrl = state.strava.workerUrl || DEFAULT_WORKER_URL;
  save();
  const back = location.origin + location.pathname;
  location.href = state.strava.workerUrl + "/auth?origin=" + encodeURIComponent(back);
}

/* ---------- Render: Coach ---------- */

function renderCoach() {
  const c = ui.coach;

  if (c.busy) {
    $("#view").innerHTML = `
      <div class="view-head"><div>
        <div class="screen-title">AI Coach</div>
        <div class="screen-sub">Building your plan…</div>
      </div></div>
      <div class="card" style="text-align:center;padding:44px 20px">
        <div class="spinner"></div>
        <div class="card-title" style="margin-top:18px">Designing your training</div>
        <div class="card-sub" style="margin-top:6px">Claude is reading your goals and injuries…</div>
      </div>`;
    return;
  }

  if (c.result) { renderCoachResult(); return; }

  const inp = coachInputs();
  $("#view").innerHTML = `
    <div class="view-head">
      <div>
        <div class="screen-title">AI Coach</div>
        <div class="screen-sub">Your goal + your body = your plan</div>
      </div>
      <button class="icon-btn" title="AI engine settings" onclick="A.openAiSettings()">⚙</button>
    </div>
    <div class="stack">
      <div class="card">
        <div class="card-title">What are you training for?</div>
        <div class="chip-grid" style="margin-top:10px">
          ${Object.entries(COACH_GOALS).map(([id, g]) =>
            `<button class="goal-chip ${inp.goal === id ? "on" : ""}" onclick="A.coachGoal('${id}')">${g.label}</button>`).join("")}
        </div>
        <div class="field-label">How long until your goal?</div>
        <div style="display:flex;gap:10px;align-items:center">
          <input class="input" type="number" min="4" max="40" inputmode="numeric" value="${esc(inp.weeks)}" style="flex:1"
            oninput="A.coachField('weeks', this.value)">
          <span class="muted small" style="flex:none">weeks (4–40)</span>
        </div>
        <div class="field-label">…or pick your race date</div>
        <input class="input" type="date" value="${esc(inp.raceDate)}" onchange="A.coachRaceDate(this.value)">
        <div class="field-label">Training days per week</div>
        <div class="seg">
          ${[3, 4, 5, 6, 7].map((n) => `<button class="${inp.days === n ? "on" : ""}" onclick="A.coachDays(${n})">${n}</button>`).join("")}
        </div>
        <div class="field-label">Experience level</div>
        <div class="seg">
          ${[["beginner", "Beginner"], ["intermediate", "Intermediate"], ["advanced", "Advanced"]].map(([id, l]) =>
            `<button class="${inp.level === id ? "on" : ""}" onclick="A.coachLevel('${id}')">${l}</button>`).join("")}
        </div>
      </div>

      <div class="card">
        <div class="card-title">Where are you now?</div>
        <div class="field-label">Current running per week (km)</div>
        <input class="input" type="number" min="0" inputmode="decimal" value="${esc(inp.weeklyKM)}" placeholder="e.g. 25"
          oninput="A.coachField('weeklyKM', this.value)">
        <div class="field-label">Longest recent run (km)</div>
        <input class="input" type="number" min="0" inputmode="decimal" value="${esc(inp.longestRun)}" placeholder="e.g. 12"
          oninput="A.coachField('longestRun', this.value)">
      </div>

      <div class="card">
        <div class="card-title">Anything the plan must respect?</div>
        <div class="field-label">Injuries &amp; limitations</div>
        <textarea class="input" placeholder="e.g. sore knee, bad back, no pool on weekdays…"
          oninput="A.coachField('injuries', this.value)">${esc(inp.injuries)}</textarea>
        <div class="field-label">Goals &amp; notes</div>
        <textarea class="input" placeholder="e.g. goal time 3:45, want 2 gym days, hate treadmills…"
          oninput="A.coachField('notes', this.value)">${esc(inp.notes)}</textarea>
      </div>

      ${c.error ? `<div class="card" style="border-color:rgba(255,90,90,.4)"><div class="card-sub" style="color:var(--red);line-height:1.5">${esc(c.error)}</div></div>` : ""}

      <button class="btn btn-accent" style="padding:16px" onclick="A.coachGenerate()">✨ Build My Plan</button>
      <div class="card-sub" style="text-align:center;line-height:1.6">
        Engine: Claude AI · built-in coach as automatic backup
      </div>
    </div>`;
}

function renderCoachResult() {
  const { plan, engine, aiNote } = ui.coach.result;
  const peakWeek = plan.weekKM ? Math.max(...plan.weekKM) : null;
  const w1 = plan.sessions.filter((s) => s.week === 1).sort((a, b) => a.day - b.day);
  $("#view").innerHTML = `
    <div class="view-head">
      <div>
        <div class="screen-title">Your Plan</div>
        <div class="screen-sub">${plan.weeks} weeks to ${esc(plan.goalLabel)}</div>
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <span class="phase-pill" style="background:var(--accent-dim);color:var(--accent)">${engine === "ai" ? "🤖 BUILT BY CLAUDE AI" : "⚙ BUILT-IN COACH ENGINE"}</span>
        ${plan.summary ? `<div style="margin-top:10px;line-height:1.6;font-size:13.5px">${esc(plan.summary)}</div>` : ""}
        ${aiNote ? `<div class="card-sub" style="margin-top:8px">${esc(aiNote)}</div>` : ""}
      </div>
      <div class="card">
        <div class="card-title">Structure</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          ${plan.phases.map((p) => `<span class="phase-pill" style="background:${p.color}22;color:${p.color}">${esc(p.name.toUpperCase())} · W${p.from}–${p.to}</span>`).join("")}
        </div>
        <div class="stat-grid" style="margin-top:14px">
          <div class="stat-cell"><div class="stat-val">${plan.weeks}</div><div class="stat-lbl">weeks</div></div>
          <div class="stat-cell"><div class="stat-val">${plan.sessions.filter((s) => s.sport !== "rest").length}</div><div class="stat-lbl">sessions</div></div>
          ${peakWeek ? `<div class="stat-cell"><div class="stat-val">${peakWeek}</div><div class="stat-lbl">peak km/wk</div></div>` : ""}
        </div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:4px">Week 1 preview</div>
        ${w1.map((s) => `
          <div class="next-row">
            ${sportIcon(s.sport, 34)}
            <div style="flex:1;min-width:0">
              <div class="title">${esc(s.title)}</div>
              <div class="detail">${esc(s.detail)}</div>
            </div>
            <div class="small muted" style="font-weight:700">${DAY_NAMES[s.day - 1]}</div>
          </div>`).join("")}
      </div>
      <button class="btn btn-accent" style="padding:16px" onclick="A.coachApply()">Use This as My Plan</button>
      <button class="btn btn-ghost" onclick="A.coachBack()">Adjust &amp; Rebuild</button>
    </div>`;
}

/* ============================== Router ============================== */

function render() {
  renderTabbar();
  if (ui.tab === "home") renderHome();
  else if (ui.tab === "plan") renderPlan();
  else if (ui.tab === "coach") renderCoach();
  else if (ui.tab === "train") renderTrain();
  else if (ui.tab === "activity") renderActivity();
  else renderTrends();
}

/* ============================== Public API ============================== */

window.A = {
  go(tab) { ui.tab = tab; $("#view").scrollTop = 0; render(); },
  closeModal,
  // profiles
  openProfiles, switchProfile, newProfile, renameProfile, deleteProfile, clearProgress,
  // plan
  selectWeek(w) { ui.planWeek = w; render(); },
  togglePlan(id) {
    const s = state.plan.find((x) => x.id === id);
    if (s) { s.completed = !s.completed; save(); render(); }
  },
  openPlanSettings, applyPlanStart, restoreBuiltinPlan,
  // coach
  coachGoal(g) { coachInputs().goal = g; render(); },
  coachLevel(l) { coachInputs().level = l; render(); },
  coachDays(n) { coachInputs().days = n; render(); },
  coachField(k, v) { coachInputs()[k] = v; },
  coachRaceDate, coachGenerate, coachApply,
  coachBack() { ui.coach.result = null; ui.coach.error = null; render(); },
  openAiSettings, saveAiSettings,
  welcomeStrava, welcomeSkip,
  // library
  openLibrary, editExercise, saveExercise, deleteExercise,
  // templates
  editTemplate, deleteTemplate, saveTemplate, tplName, tplSets, tplRemove, tplAdd,
  // activity
  setActivitySeg(seg) { ui.activitySeg = seg; render(); },
  editCardio, cardioSport, saveCardio, deleteCardio, showWorkout, deleteWorkout,
  openStravaImport, stravaFile, stravaDoImport,
  stravaConnect, stravaDisconnect, stravaSyncNow,
  // trends
  setTrendExercise(name) { ui.trendExercise = name; render(); },
  // active workout
  startEmpty, startTemplate, awName, awNotes, awExNotes, awEditSet, awToggleSet,
  awAddSet, awRemoveExercise, awAddExercise, awFilterPick, awPick, awFinish, awDiscard, awSkipRest,
};

/* ============================== Boot ============================== */

initProfiles();
const fromStravaRedirect = handleStravaRedirect();
render();
if (!fromStravaRedirect) stravaAutoSync();

// First launch: offer one-tap Strava login (skippable, shown once).
if (!fromStravaRedirect && !localStorage.getItem(WELCOMED_KEY) &&
    !(state.strava && state.strava.session)) {
  showWelcome();
}

/* PWA: installable + offline. Skipped on file:// so double-clicking
   index.html keeps working exactly as before. */
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
