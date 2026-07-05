// Pure, DOM-free training-insight helpers for /tools/convert/ (Phase C of the "convert
// cockpit"). Phase A shaped body-composition trends; Phase B merged multi-source records
// losslessly. Phase C turns that merged history into the *training* insights the dashboard
// leads with — profile-aware (a lifter, a calisthenics athlete and a runner each want a
// different first screen).
//
// Everything here is pure over already-mapped `LiveRecord`s (the Phase B merge output): no
// DOM, no network, no dependencies beyond @openbody/openbody-ts and the sibling Phase A
// helpers. That keeps the same logic node-smoke-testable and reusable by the later UI step,
// which merely renders what these functions return.
//
// A recurring, deliberate honesty constraint runs through this file: we NEVER invent
// precision the source data can't support. e1RM is labelled an estimate; muscle grouping is
// a coarse built-in heuristic (documented below) because the merged records usually carry
// only the app's own opaque exercise *name*, not a resolved registry id with anatomy; and
// `insightPlan` suppresses any card whose sample size is too small to be trustworthy.
import type {
  LiveRecord,
  Session,
  Exercise,
  WorkUnit,
  Block,
  Load,
  ExerciseRef,
  ScalarOrTarget,
  ScalarOrTargetWithRamp,
  WireNumber,
} from "@openbody/openbody-ts";
import { wireToNumber, dailyBodyMass, type DailyValue, type TrendPoint } from "./insights";

// --- numeric extraction ----------------------------------------------------------------

/**
 * Best-effort JS number from any `ScalarOrTarget` a performance field can hold. Mappers put
 * *performed* metrics either as a bare wire number (`reps: 10`, `time: 60`) or as an absolute
 * target (`distance: { absolute: { value, unit } }`); a range collapses to its midpoint. The
 * prescription-only variants (relativeToThreshold/stopCondition/ramp) describe targets, not
 * what happened, so they yield `undefined` here. */
function scalarNumber(v: ScalarOrTarget | ScalarOrTargetWithRamp | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("coefficient" in o && "exponent" in o) return wireToNumber(v as WireNumber);
    if ("absolute" in o && o.absolute && typeof o.absolute === "object") {
      return wireToNumber((o.absolute as { value: WireNumber }).value);
    }
    if ("range" in o && o.range && typeof o.range === "object") {
      const r = o.range as { min: WireNumber; max: WireNumber };
      const lo = wireToNumber(r.min);
      const hi = wireToNumber(r.max);
      if (lo !== undefined && hi !== undefined) return (lo + hi) / 2;
    }
  }
  return undefined;
}

/** External resistance in kilograms (mappers already emit kg for these sources; lb is
 * converted defensively). Returns the numeric magnitude only — sign/meaning of `basis`
 * (e.g. "assist") is interpreted by the caller. */
function loadKg(load: Load | undefined): number | undefined {
  if (!load) return undefined;
  const raw = scalarNumber(load.value);
  if (raw === undefined) return undefined;
  const unit = (load.unit ?? "kg").toLowerCase();
  if (unit === "lb" || unit === "[lb_av]") return raw * 0.45359237;
  return raw;
}

// --- time helpers ----------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

function ms(iso: unknown): number | undefined {
  if (typeof iso !== "string" || iso === "") return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** UTC-midnight Monday of the week containing `msTime`. */
function weekStartMs(msTime: number): number {
  const d = new Date(msTime);
  const monOffset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - monOffset);
}

function isoDay(msTime: number): string {
  return new Date(msTime).toISOString().slice(0, 10);
}

// --- movement classification (coarse, built-in) ----------------------------------------
//
// LIMITATION — read before trusting this. The OpenBody registry (openbody-registry
// data/exercises.json) does carry rich per-exercise anatomy (primary/secondary muscles +
// movementPattern), keyed by *canonical id*. But the records this tool actually sees are
// mapper output, and most sources (Hevy, Apple, Strava) leave `exerciseRef` as an opaque
// app *name* with no resolved id — only Strong currently resolves canonical ids. Bundling
// the registry + running §6 resolution client-side just to colour a volume chart is out of
// scope for Phase C, and would still miss the many exercises the registry doesn't cover.
// So we ship this small keyword classifier instead: it works off whichever of {canonical id,
// opaque name} is present, covers the common barbell/dumbbell/machine/bodyweight lifts, and
// falls back to "other" rather than guessing. It is intentionally coarse — group-level, not
// per-muscle — precisely because per-muscle attribution is data we can't honestly support
// here. When a future step resolves registry ids, prefer the registry's `anatomy` facet.

export type MuscleGroup = "chest" | "back" | "shoulders" | "legs" | "arms" | "core" | "other";

// Checked in order; first group whose keyword appears in the (id + name) haystack wins.
// Ordering resolves the ambiguous tokens: shoulders before chest (so "overhead press" isn't
// caught by a generic press rule), core before legs (so "leg raise" is core, not "leg"),
// legs/back before arms (so "leg extension"/"back extension" aren't caught by "extension").
const MUSCLE_KEYWORDS: [MuscleGroup, string[]][] = [
  ["shoulders", [
    "overhead press", "shoulder press", "military press", "arnold press", "ohp",
    "lateral raise", "side raise", "front raise", "rear delt", "reverse fly", "reverse pec",
    "face pull", "upright row", "shrug", "delt",
  ]],
  ["back", [
    "pull up", "pull-up", "pullup", "chin up", "chin-up", "chinup",
    "pulldown", "pull down", "lat ", "lat-", "row", "deadlift", "rack pull",
    "pullover", "back extension", "hyperextension", "muscle up", "muscle-up", "inverted row",
  ]],
  ["chest", [
    "bench press", "bench", "chest press", "chest fly", "pec deck", "pec ", "pectoral",
    "cable crossover", "crossover", "fly", "dip", "push up", "push-up", "pushup", "press up",
    "incline press", "decline press", "svend",
  ]],
  ["core", [
    "plank", "crunch", "sit up", "sit-up", "situp", "abs", "abdominal", "oblique",
    "russian twist", "leg raise", "knee raise", "toes to bar", "hollow", "l-sit", "l sit",
    "ab wheel", "rollout", "dead bug", "pallof", "hanging", "woodchop",
  ]],
  ["legs", [
    "squat", "leg press", "leg extension", "leg curl", "lunge", "calf", "calve",
    "hamstring", "quad", "glute", "hip thrust", "hip adduction", "hip abduction",
    "adductor", "abductor", "split squat", "step up", "step-up", "hack", "pistol",
    "nordic", "good morning", "kettlebell swing", "box jump",
  ]],
  ["arms", [
    "curl", "bicep", "tricep", "pushdown", "push down", "skullcrusher", "skull crusher",
    "preacher", "hammer", "kickback", "overhead extension", "tricep extension", "extension",
    "wrist", "forearm", "concentration",
  ]],
];

// Bodyweight / calisthenics movements — recognised by name so weighted and assisted variants
// ("Weighted Pull Up", "Pull Up (Assisted)") still count. This drives both the calisthenics
// insight block and the strength/calisthenics split inside activity-profile detection.
const BODYWEIGHT_KEYWORDS = [
  "pull up", "pull-up", "pullup", "chin up", "chin-up", "chinup",
  "push up", "push-up", "pushup", "press up",
  "dip", "muscle up", "muscle-up", "muscleup",
  "pistol", "l-sit", "l sit", "handstand", "planche", "front lever", "back lever",
  "ring", "bodyweight", "body weight", "air squat", "sit up", "sit-up", "situp",
  "burpee", "inverted row", "australian pull", "hanging leg raise", "toes to bar",
  "knee raise", "human flag", "bar hang", "dead hang", "pull over bar", "pistol squat",
];

function haystackFor(id: string | undefined, name: string | undefined): string {
  return `${id ?? ""} ${name ?? ""}`.toLowerCase();
}

/** Coarse muscle group for a movement, from its canonical id and/or opaque name. */
export function classifyMuscleGroup(id: string | undefined, name: string | undefined): MuscleGroup {
  const hay = haystackFor(id, name);
  for (const [group, keys] of MUSCLE_KEYWORDS) {
    for (const k of keys) if (hay.includes(k)) return group;
  }
  return "other";
}

/** Whether a movement is a bodyweight / calisthenics movement (weighted & assisted included). */
export function isBodyweightMovement(id: string | undefined, name: string | undefined): boolean {
  const hay = haystackFor(id, name);
  return BODYWEIGHT_KEYWORDS.some((k) => hay.includes(k));
}

// --- set/session flattening ------------------------------------------------------------

/** A single logged set, flattened out of the Session → (Block) → Exercise → WorkUnit tree. */
export interface SetObs {
  /** Stable lift identity: canonical id when resolved, else `name:<lowercased opaque>`. */
  liftKey: string;
  /** Display label: the opaque app name when present, else the canonical id. */
  label: string;
  muscleGroup: MuscleGroup;
  bodyweight: boolean;
  dateMs: number;
  day: string;
  scoring: string;
  reps?: number;
  /** External resistance in kg (magnitude; see `basis` for meaning). */
  weightKg?: number;
  /** §5.12 load basis, e.g. "assist" (weight is assistance) or "added" (added to bodyweight). */
  basis?: string;
  timeSec?: number;
  setRole?: string;
}

function refIdentity(ref: ExerciseRef | undefined): { key: string; label: string } {
  if (ref === undefined) return { key: "(unknown)", label: "(unknown)" };
  if (typeof ref === "string") return { key: ref, label: ref };
  const id = ref.id;
  const opaque = ref.opaque;
  if (id) return { key: id, label: opaque ?? id };
  if (opaque) return { key: `name:${opaque.toLowerCase()}`, label: opaque };
  return { key: "(unknown)", label: "(unknown)" };
}

/** Yield every WorkUnit in a Session paired with its effective exerciseRef, walking the
 * at-most-one container (blocks | exercises | workUnits) and Block children (§5.3/§7.2). */
function* eachSet(session: Session): Generator<{ ref: ExerciseRef | undefined; wu: WorkUnit }> {
  const visitExercise = function* (ex: Exercise): Generator<{ ref: ExerciseRef | undefined; wu: WorkUnit }> {
    for (const wu of ex.workUnits ?? []) yield { ref: wu.exerciseRef ?? ex.exerciseRef, wu };
  };
  const visitBlock = function* (b: Block): Generator<{ ref: ExerciseRef | undefined; wu: WorkUnit }> {
    for (const child of b.children ?? []) {
      if (child.recordType === "Exercise") yield* visitExercise(child);
      else if (child.recordType === "Block") yield* visitBlock(child);
      else if (child.recordType === "WorkUnit") yield { ref: child.exerciseRef, wu: child };
    }
  };
  for (const ex of session.exercises ?? []) yield* visitExercise(ex);
  for (const b of session.blocks ?? []) yield* visitBlock(b);
  for (const wu of session.workUnits ?? []) yield { ref: wu.exerciseRef, wu };
}

/** Flatten every strength/bodyweight set (reps- or time-scored) in the record set into a
 * chronological `SetObs[]`. Endurance work (distance/continuous scoring) is excluded here —
 * `collectEnduranceSessions` handles that. */
export function collectStrengthSets(records: LiveRecord[]): SetObs[] {
  const out: SetObs[] = [];
  for (const rec of records) {
    if (rec.recordType !== "Session") continue;
    const t = ms(rec.startTime);
    if (t === undefined) continue;
    const day = isoDay(t);
    for (const { ref, wu } of eachSet(rec)) {
      if (wu.scoring !== "reps" && wu.scoring !== "time") continue;
      const { key, label } = refIdentity(ref);
      const idFor = typeof ref === "object" && ref ? ref.id : typeof ref === "string" ? ref : undefined;
      const nameFor = typeof ref === "object" && ref ? ref.opaque : undefined;
      const perf = wu.performance;
      out.push({
        liftKey: key,
        label,
        muscleGroup: classifyMuscleGroup(idFor, nameFor ?? label),
        bodyweight: isBodyweightMovement(idFor, nameFor ?? label),
        dateMs: t,
        day,
        scoring: wu.scoring,
        reps: scalarNumber(perf?.reps),
        weightKg: loadKg(perf?.load),
        basis: perf?.load?.basis,
        timeSec: scalarNumber(perf?.time),
        setRole: wu.setRole,
      });
    }
  }
  return out.sort((a, b) => a.dateMs - b.dateMs);
}

/** One endurance session rolled to totals. */
export interface EnduranceObs {
  dateMs: number;
  day: string;
  discipline: string;
  km: number;
  seconds: number;
}

const ENDURANCE_DISCIPLINES = new Set([
  "running", "run", "cycling", "bike", "biking", "swimming", "swim", "rowing", "row",
  "walking", "walk", "hiking", "hike", "elliptical", "skiing", "ski", "paddling", "kayak",
  "canoe", "skating", "cardio", "treadmill",
]);

const toKm = (value: number, unit: string): number => {
  switch (unit) {
    case "m": return value / 1000;
    case "km": return value;
    case "mi": case "[mi_i]": return value * 1.609344;
    default: return 0;
  }
};

/** Roll each endurance-shaped Session (an endurance discipline, or one carrying distance) up
 * to distance + duration. Sessions built purely of reps/time strength sets are excluded. */
export function collectEnduranceSessions(records: LiveRecord[]): EnduranceObs[] {
  const out: EnduranceObs[] = [];
  for (const rec of records) {
    if (rec.recordType !== "Session") continue;
    const t = ms(rec.startTime);
    if (t === undefined) continue;
    const discipline = String(rec.disciplines?.[0] ?? "unknown").toLowerCase();

    let km = 0;
    let seconds = 0;
    let hasRepsSet = false;
    for (const { wu } of eachSet(rec)) {
      if (wu.scoring === "reps") hasRepsSet = true;
      const p = wu.performance;
      const dist = p?.distance;
      if (dist !== undefined && typeof dist === "object" && "absolute" in dist) {
        const value = scalarNumber(dist);
        const unit = (dist.absolute as { unit?: string }).unit ?? "m";
        if (value !== undefined) km += toKm(value, unit);
      }
      const time = p?.time;
      if (time !== undefined && typeof time === "object" && "absolute" in time) {
        const value = scalarNumber(time);
        const unit = (time.absolute as { unit?: string }).unit;
        if (value !== undefined && (unit === "s" || unit === undefined)) seconds += value;
      }
    }
    if (seconds === 0) {
      const end = ms(rec.endTime);
      if (end !== undefined && end > t) seconds = (end - t) / 1000;
    }

    const isEndurance = ENDURANCE_DISCIPLINES.has(discipline) || (km > 0 && !hasRepsSet);
    if (!isEndurance) continue;
    out.push({ dateMs: t, day: isoDay(t), discipline, km, seconds });
  }
  return out.sort((a, b) => a.dateMs - b.dateMs);
}

// --- 1. activity-profile detection -----------------------------------------------------

export type Profile = "strength" | "calisthenics" | "endurance" | "mixed";

export interface ActivityProfile {
  profile: Profile;
  confidence: "low" | "high";
  /** Session counts per class (the raw mix the UI can explain the choice from). */
  mix: { strength: number; calisthenics: number; endurance: number; other: number };
}

// A class needs ≥60% of classified sessions to *be* the profile; below that it's "mixed".
// Confidence is "high" once there are ≥5 classified sessions (enough to trust the split),
// else "low". Thresholds are deliberately round and documented so the UI can restate them.
const PROFILE_DOMINANCE = 0.6;
const PROFILE_CONFIDENT_N = 5;

/** Classify one Session into a single training class from its contents. */
function classifySession(session: Session): keyof ActivityProfile["mix"] {
  const discipline = String(session.disciplines?.[0] ?? "").toLowerCase();
  let strengthSets = 0;
  let calSets = 0;
  let km = 0;
  let repsOrTimeSets = 0;
  for (const { ref, wu } of eachSet(session)) {
    const p = wu.performance;
    if (wu.scoring === "distance" || wu.scoring === "continuous") {
      const dist = p?.distance;
      if (dist !== undefined && typeof dist === "object" && "absolute" in dist) {
        const value = scalarNumber(dist);
        const unit = (dist.absolute as { unit?: string }).unit ?? "m";
        if (value !== undefined) km += toKm(value, unit);
      }
      continue;
    }
    if (wu.scoring !== "reps" && wu.scoring !== "time") continue;
    repsOrTimeSets++;
    const { key, label } = refIdentity(ref);
    void key;
    const idFor = typeof ref === "object" && ref ? ref.id : typeof ref === "string" ? ref : undefined;
    const nameFor = typeof ref === "object" && ref ? ref.opaque : undefined;
    const bodyweight = isBodyweightMovement(idFor, nameFor ?? label);
    const weight = loadKg(p?.load);
    const basis = p?.load?.basis;
    // A recognised bodyweight movement, an assisted movement, or an unloaded rep/time set
    // (e.g. a plank) counts as calisthenics; a genuinely loaded set counts as strength.
    if (bodyweight || basis === "assist" || !(weight !== undefined && weight > 0)) calSets++;
    else strengthSets++;
  }

  if (ENDURANCE_DISCIPLINES.has(discipline)) return "endurance";
  if (repsOrTimeSets === 0) return km > 0 ? "endurance" : "other";
  if (calSets > strengthSets) return "calisthenics";
  if (strengthSets > 0) return "strength";
  if (calSets > 0) return "calisthenics";
  return "other";
}

/**
 * Detect the athlete's dominant training profile from the merged records — the organizing
 * decision the rest of Phase C hangs off. Each Session is classified into one class; the mix
 * is the session counts; the profile is the class with ≥60% share, else "mixed". `mix` is
 * returned so the UI can explain *why* ("62% strength, 30% endurance").
 */
export function detectActivityProfile(records: LiveRecord[]): ActivityProfile {
  const mix = { strength: 0, calisthenics: 0, endurance: 0, other: 0 };
  for (const rec of records) {
    if (rec.recordType !== "Session") continue;
    mix[classifySession(rec)]++;
  }
  const classified = mix.strength + mix.calisthenics + mix.endurance; // "other" excluded from the vote
  if (classified === 0) {
    return { profile: "mixed", confidence: "low", mix };
  }
  const entries: [Profile, number][] = [
    ["strength", mix.strength],
    ["calisthenics", mix.calisthenics],
    ["endurance", mix.endurance],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const [topClass, topCount] = entries[0];
  const profile: Profile = topCount / classified >= PROFILE_DOMINANCE ? topClass : "mixed";
  const confidence: "low" | "high" = classified >= PROFILE_CONFIDENT_N ? "high" : "low";
  return { profile, confidence, mix };
}

// --- 2. strength insights --------------------------------------------------------------

/**
 * Estimated one-rep max via the Epley formula: `weight · (1 + reps/30)`. This is an ESTIMATE
 * — it models a strength curve and diverges from a true max at high rep counts. Returns the
 * weight unchanged for a true single (reps === 1), and `undefined` for bodyweight-only
 * (weight ≤ 0) or invalid (reps < 1) input, so callers never fabricate a loaded max from a
 * bodyweight set.
 */
export function estimateOneRepMax(weight: number, reps: number): number | undefined {
  if (!(weight > 0) || !(reps >= 1)) return undefined;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

export interface PrSet {
  dateMs: number;
  day: string;
  weightKg: number;
  reps: number;
  e1rm: number;
}
export interface PrEvent extends PrSet {
  /** A PR on a set that doesn't look like a max-effort attempt (reps ≥ 4): a rep PR that
   * quietly beat the old e1RM rather than an obvious 1–3RM test. Powers "PRs you'd forgotten". */
  forgotten: boolean;
}
export interface LiftPrTimeline {
  liftKey: string;
  label: string;
  muscleGroup: MuscleGroup;
  /** Best e1RM achieved on each training day, chronological — the e1RM line for the chart. */
  series: { dateMs: number; day: string; e1rm: number }[];
  /** All-time best e1RM and the set that produced it. */
  bestE1rm: number;
  bestSet: PrSet;
  /** Every set that beat the prior all-time e1RM, in order. */
  prEvents: PrEvent[];
  /** Distinct training days for this lift (drives the ≥3-sessions sufficiency test). */
  sessionCount: number;
}

/** reps ≥ this on a PR set means it wasn't an obvious max-effort test → "forgotten" PR. */
const FORGOTTEN_MIN_REPS = 4;
const E1RM_EPS = 1e-6;

/**
 * Per-lift e1RM progression and PR events over the merged history. For each loaded resistance
 * lift (weight > 0, not assisted) we compute every set's estimated 1RM, emit the best-per-day
 * series for the chart, and mark each set that beat the prior all-time e1RM as a PR — flagging
 * the "forgotten" ones (a rep PR ≥ 4 reps that quietly set a new estimated max).
 */
export function prTimeline(records: LiveRecord[]): LiftPrTimeline[] {
  const sets = collectStrengthSets(records);
  const byLift = new Map<string, SetObs[]>();
  for (const s of sets) {
    if (s.scoring !== "reps") continue;
    if (s.basis === "assist") continue; // assisted → calisthenics side, not a loaded max
    if (!(s.weightKg !== undefined && s.weightKg > 0)) continue;
    if (!(s.reps !== undefined && s.reps >= 1)) continue;
    (byLift.get(s.liftKey) ?? byLift.set(s.liftKey, []).get(s.liftKey)!).push(s);
  }

  const out: LiftPrTimeline[] = [];
  for (const [liftKey, liftSets] of byLift) {
    liftSets.sort((a, b) => a.dateMs - b.dateMs);
    const bestPerDay = new Map<string, { dateMs: number; e1rm: number }>();
    const prEvents: PrEvent[] = [];
    let allTimeBest = 0;
    let bestSet: PrSet | undefined;
    for (const s of liftSets) {
      const e1rm = estimateOneRepMax(s.weightKg!, s.reps!);
      if (e1rm === undefined) continue;
      const cur = bestPerDay.get(s.day);
      if (!cur || e1rm > cur.e1rm) bestPerDay.set(s.day, { dateMs: s.dateMs, e1rm });
      if (e1rm > allTimeBest + E1RM_EPS) {
        const prSet: PrSet = { dateMs: s.dateMs, day: s.day, weightKg: s.weightKg!, reps: s.reps!, e1rm };
        prEvents.push({ ...prSet, forgotten: s.reps! >= FORGOTTEN_MIN_REPS });
        allTimeBest = e1rm;
        bestSet = prSet;
      }
    }
    if (!bestSet) continue;
    const series = [...bestPerDay.entries()]
      .map(([day, v]) => ({ day, dateMs: v.dateMs, e1rm: v.e1rm }))
      .sort((a, b) => a.dateMs - b.dateMs);
    out.push({
      liftKey,
      label: liftSets[0].label,
      muscleGroup: liftSets[0].muscleGroup,
      series,
      bestE1rm: allTimeBest,
      bestSet,
      prEvents,
      sessionCount: new Set(liftSets.map((s) => s.day)).size,
    });
  }
  return out.sort((a, b) => b.bestE1rm - a.bestE1rm);
}

// --- relative strength -----------------------------------------------------------------

export interface RelativeStrengthPoint {
  dateMs: number;
  day: string;
  e1rm: number;
  bodyweight: number;
  ratio: number;
  /** How close the matched bodyweight reading was: exact day, within 14 days, or sparse. */
  sample: "exact" | "near" | "sparse";
}
export interface LiftRelativeStrength {
  liftKey: string;
  label: string;
  points: RelativeStrengthPoint[];
  first: RelativeStrengthPoint;
  last: RelativeStrengthPoint;
  strengthDirection: "up" | "down" | "flat";
  bodyweightDirection: "up" | "down" | "flat";
  /** Strength rose while bodyweight fell — the "stronger while lighter" story. */
  strongerWhileLighter: boolean;
  /** Most matched points had no nearby bodyweight reading → treat the ratio as indicative. */
  sparse: boolean;
}

const REL_NEAR_DAYS = 14;

function nearestBodyweight(
  series: DailyValue[],
  target: number,
): { value: number; gapDays: number } | undefined {
  if (series.length === 0) return undefined;
  let best: { value: number; gapDays: number } | undefined;
  for (const p of series) {
    const gap = Math.abs(p.t - target) / DAY_MS;
    if (!best || gap < best.gapDays) best = { value: p.value, gapDays: gap };
  }
  return best;
}

function direction(from: number, to: number, tol: number): "up" | "down" | "flat" {
  if (to - from > tol) return "up";
  if (from - to > tol) return "down";
  return "flat";
}

/**
 * Relative strength (lift ÷ bodyweight) over time for each loaded lift, matched against the
 * nearest bodyweight reading. Each point is annotated with how good the bodyweight match was
 * (`sample`), so the UI can hedge sparse ratios; the lift-level summary exposes the strength
 * and bodyweight directions so "stronger while lighter" is directly derivable. Feed it the
 * `dailyBodyMass(records).series` (or any `DailyValue[]`).
 */
export function relativeStrength(
  records: LiveRecord[],
  bodyweightSeries: DailyValue[],
): LiftRelativeStrength[] {
  if (bodyweightSeries.length === 0) return [];
  const bwSorted = [...bodyweightSeries].sort((a, b) => a.t - b.t);
  const lifts = prTimeline(records);
  const out: LiftRelativeStrength[] = [];
  for (const lift of lifts) {
    const points: RelativeStrengthPoint[] = [];
    let sparseCount = 0;
    for (const p of lift.series) {
      const bw = nearestBodyweight(bwSorted, p.dateMs);
      if (!bw || bw.value <= 0) continue;
      const sample: RelativeStrengthPoint["sample"] =
        bw.gapDays < 1 ? "exact" : bw.gapDays <= REL_NEAR_DAYS ? "near" : "sparse";
      if (sample === "sparse") sparseCount++;
      points.push({
        dateMs: p.dateMs,
        day: p.day,
        e1rm: p.e1rm,
        bodyweight: bw.value,
        ratio: p.e1rm / bw.value,
        sample,
      });
    }
    if (points.length < 2) continue;
    const first = points[0];
    const last = points[points.length - 1];
    const strengthDirection = direction(first.e1rm, last.e1rm, first.e1rm * 0.02);
    const bodyweightDirection = direction(first.bodyweight, last.bodyweight, first.bodyweight * 0.01);
    out.push({
      liftKey: lift.liftKey,
      label: lift.label,
      points,
      first,
      last,
      strengthDirection,
      bodyweightDirection,
      strongerWhileLighter: strengthDirection === "up" && bodyweightDirection === "down",
      sparse: sparseCount > points.length / 2,
    });
  }
  return out;
}

// --- volume by muscle group ------------------------------------------------------------

export interface WeeklyVolumePoint {
  weekStart: string;
  sets: number;
}
export interface MuscleGroupVolume {
  group: MuscleGroup;
  weekly: WeeklyVolumePoint[];
  totalSets: number;
  /** Weekly working-set count held within ±10% for ≥6 consecutive trained weeks (a plateau). */
  plateau: boolean;
}
export interface VolumeByMuscleGroup {
  /** Shared week axis (ISO Monday dates), oldest → newest. */
  weekStarts: string[];
  groups: MuscleGroupVolume[];
  weekCount: number;
}

const PLATEAU_MIN_WEEKS = 6;
const PLATEAU_TOLERANCE = 0.1; // ±10% of the run mean

/** Longest run of consecutive trained (non-zero) weeks ending at the last trained week whose
 * values all sit within ±10% of that run's mean has length ≥ 6 → plateau. */
function isPlateau(weekly: WeeklyVolumePoint[]): boolean {
  const trained = weekly.filter((w) => w.sets > 0);
  if (trained.length < PLATEAU_MIN_WEEKS) return false;
  // Grow a window backwards from the most recent trained week.
  for (let start = trained.length - PLATEAU_MIN_WEEKS; start >= 0; start--) {
    const window = trained.slice(start);
    const mean = window.reduce((s, w) => s + w.sets, 0) / window.length;
    if (mean <= 0) continue;
    const within = window.every((w) => Math.abs(w.sets - mean) <= mean * PLATEAU_TOLERANCE);
    if (within && window.length >= PLATEAU_MIN_WEEKS) return true;
  }
  return false;
}

/**
 * Weekly working-set counts per muscle group, on a shared week axis (zero-filled), plus a
 * per-group plateau flag (volume flat within ±10% for ≥6 consecutive trained weeks). Only
 * working sets are counted (setRole "working" or unset; warmup/drop excluded). `weeks`, when
 * given, keeps only the most recent N weeks. Muscle grouping is the coarse built-in
 * classifier documented at the top of this file — group-level, not per-muscle.
 */
export function volumeByMuscleGroup(records: LiveRecord[], weeks?: number): VolumeByMuscleGroup {
  const sets = collectStrengthSets(records).filter(
    (s) => s.setRole === undefined || s.setRole === "working",
  );
  if (sets.length === 0) return { weekStarts: [], groups: [], weekCount: 0 };

  const minWeek = weekStartMs(sets[0].dateMs);
  const maxWeek = weekStartMs(sets[sets.length - 1].dateMs);
  const allWeeks: number[] = [];
  for (let w = minWeek; w <= maxWeek; w += WEEK_MS) allWeeks.push(w);
  const keptWeeks = weeks && weeks > 0 ? allWeeks.slice(-weeks) : allWeeks;
  const keptSet = new Set(keptWeeks);
  const weekIndex = new Map(keptWeeks.map((w, i) => [w, i]));

  const groupWeekly = new Map<MuscleGroup, number[]>();
  const ensure = (g: MuscleGroup) =>
    groupWeekly.get(g) ?? groupWeekly.set(g, new Array(keptWeeks.length).fill(0)).get(g)!;
  for (const s of sets) {
    const w = weekStartMs(s.dateMs);
    if (!keptSet.has(w)) continue;
    ensure(s.muscleGroup)[weekIndex.get(w)!]++;
  }

  const weekStarts = keptWeeks.map(isoDay);
  const groups: MuscleGroupVolume[] = [...groupWeekly.entries()]
    .map(([group, counts]) => {
      const weekly = counts.map((sets, i) => ({ weekStart: weekStarts[i], sets }));
      return {
        group,
        weekly,
        totalSets: counts.reduce((a, b) => a + b, 0),
        plateau: isPlateau(weekly),
      };
    })
    .sort((a, b) => b.totalSets - a.totalSets);

  return { weekStarts, groups, weekCount: keptWeeks.length };
}

// --- 3. calisthenics insights ----------------------------------------------------------

export interface CalisthenicsMovement {
  liftKey: string;
  label: string;
  /** Best single-set reps on each training day, chronological — the max-reps progression. */
  repMaxSeries: { dateMs: number; day: string; bestReps: number }[];
  bestReps: number;
  bestRepsDay: string;
  /** Weighted/assisted e1RM PRs using effective load = bodyweight ± added/assist weight. */
  weightedPrEvents: PrEvent[];
  /** True when any set carried external load (added or assist) — weighted calisthenics. */
  usesExternalLoad: boolean;
  sessionCount: number;
}

/**
 * Per-bodyweight-movement progress for calisthenics athletes: the max-reps trend (best
 * unbroken set per day) and weighted-PR events. For weighted/assisted variants we compute an
 * effective e1RM from bodyweight ± the external load (added weight increases it, "assist"
 * subtracts) — this is why relative strength is central here and why a bodyweight series is
 * required for the weighted-PR side. Movements are recognised by name (see
 * `isBodyweightMovement`); pass `dailyBodyMass(records).series` as the bodyweight series.
 */
export function calisthenicsProgress(
  records: LiveRecord[],
  bodyweightSeries: DailyValue[],
): CalisthenicsMovement[] {
  const bwSorted = [...bodyweightSeries].sort((a, b) => a.t - b.t);
  const sets = collectStrengthSets(records).filter((s) => s.bodyweight);
  const byLift = new Map<string, SetObs[]>();
  for (const s of sets) {
    (byLift.get(s.liftKey) ?? byLift.set(s.liftKey, []).get(s.liftKey)!).push(s);
  }

  const out: CalisthenicsMovement[] = [];
  for (const [liftKey, liftSets] of byLift) {
    liftSets.sort((a, b) => a.dateMs - b.dateMs);
    const bestRepsPerDay = new Map<string, { dateMs: number; reps: number }>();
    const prEvents: PrEvent[] = [];
    let usesExternalLoad = false;
    let allTimeBest = 0;
    let bestReps = 0;
    let bestRepsDay = "";
    for (const s of liftSets) {
      const reps = s.reps;
      if (reps !== undefined && reps > 0) {
        const cur = bestRepsPerDay.get(s.day);
        if (!cur || reps > cur.reps) bestRepsPerDay.set(s.day, { dateMs: s.dateMs, reps });
        if (reps > bestReps) { bestReps = reps; bestRepsDay = s.day; }
      }
      // Weighted/assisted PR track — only when there's an external load to add and reps.
      const ext = s.weightKg;
      if (ext !== undefined && ext !== 0 && reps !== undefined && reps >= 1) {
        usesExternalLoad = true;
        const bw = nearestBodyweight(bwSorted, s.dateMs);
        if (bw && bw.value > 0) {
          const effective = s.basis === "assist" ? bw.value - ext : bw.value + ext;
          const e1rm = estimateOneRepMax(effective, reps);
          if (e1rm !== undefined && e1rm > allTimeBest + E1RM_EPS) {
            prEvents.push({
              dateMs: s.dateMs, day: s.day, weightKg: ext, reps,
              e1rm, forgotten: reps >= FORGOTTEN_MIN_REPS,
            });
            allTimeBest = e1rm;
          }
        }
      }
    }
    const repMaxSeries = [...bestRepsPerDay.entries()]
      .map(([day, v]) => ({ day, dateMs: v.dateMs, bestReps: v.reps }))
      .sort((a, b) => a.dateMs - b.dateMs);
    if (repMaxSeries.length === 0 && prEvents.length === 0) continue;
    out.push({
      liftKey,
      label: liftSets[0].label,
      repMaxSeries,
      bestReps,
      bestRepsDay,
      weightedPrEvents: prEvents,
      usesExternalLoad,
      sessionCount: new Set(liftSets.map((s) => s.day)).size,
    });
  }
  return out.sort((a, b) => b.sessionCount - a.sessionCount);
}

// --- 4. endurance insights -------------------------------------------------------------

export interface EnduranceWeek {
  weekStart: string;
  km: number;
  seconds: number;
  sessions: number;
}
export interface DisciplinePacePoint {
  dateMs: number;
  day: string;
  km: number;
  seconds: number;
  /** Running-style disciplines: seconds per km (lower is faster). */
  paceSecPerKm?: number;
  /** Cycling-style disciplines: km/h (higher is faster). */
  speedKmh?: number;
}
export interface DisciplinePace {
  discipline: string;
  metric: "pace" | "speed";
  points: DisciplinePacePoint[];
  /** Direction of improvement over the span (faster pace / higher speed = "improving"). */
  trend: "improving" | "declining" | "flat";
}
export interface EnduranceTrends {
  weekly: EnduranceWeek[];
  totalKm: number;
  totalSeconds: number;
  disciplines: DisciplinePace[];
  distanceTrend: "up" | "down" | "flat";
  /** Distinct active weeks (drives the ≥8-week endurance sufficiency test). */
  activeWeeks: number;
  /** Span in weeks between the first and last endurance session. */
  spanWeeks: number;
}

// Disciplines whose "faster" is a higher speed (km/h); everything else is pace (sec/km).
const SPEED_DISCIPLINES = new Set(["cycling", "bike", "biking", "skating", "skiing", "ski"]);

/**
 * Weekly endurance volume (distance + duration) plus a per-discipline pace/speed series and a
 * simple trend direction — the lead insight for endurance athletes. Running-style disciplines
 * report pace (sec/km, lower better); cycling-style report speed (km/h, higher better). Trend
 * compares the mean of the first third of sessions to the last third. `weeks` keeps only the
 * most recent N weeks of the weekly series.
 */
export function enduranceTrends(records: LiveRecord[], weeks?: number): EnduranceTrends {
  const sessions = collectEnduranceSessions(records);
  if (sessions.length === 0) {
    return { weekly: [], totalKm: 0, totalSeconds: 0, disciplines: [], distanceTrend: "flat", activeWeeks: 0, spanWeeks: 0 };
  }

  const minWeek = weekStartMs(sessions[0].dateMs);
  const maxWeek = weekStartMs(sessions[sessions.length - 1].dateMs);
  const allWeeks: number[] = [];
  for (let w = minWeek; w <= maxWeek; w += WEEK_MS) allWeeks.push(w);
  const kept = weeks && weeks > 0 ? allWeeks.slice(-weeks) : allWeeks;
  const idx = new Map(kept.map((w, i) => [w, i]));
  const weekly: EnduranceWeek[] = kept.map((w) => ({ weekStart: isoDay(w), km: 0, seconds: 0, sessions: 0 }));

  let totalKm = 0;
  let totalSeconds = 0;
  const activeWeeks = new Set<number>();
  const byDiscipline = new Map<string, EnduranceObs[]>();
  for (const s of sessions) {
    totalKm += s.km;
    totalSeconds += s.seconds;
    const w = weekStartMs(s.dateMs);
    const i = idx.get(w);
    if (i !== undefined) {
      weekly[i].km += s.km;
      weekly[i].seconds += s.seconds;
      weekly[i].sessions++;
      activeWeeks.add(w);
    }
    (byDiscipline.get(s.discipline) ?? byDiscipline.set(s.discipline, []).get(s.discipline)!).push(s);
  }

  const disciplines: DisciplinePace[] = [];
  for (const [discipline, obs] of byDiscipline) {
    const metric: "pace" | "speed" = SPEED_DISCIPLINES.has(discipline) ? "speed" : "pace";
    const points: DisciplinePacePoint[] = [];
    for (const o of obs) {
      if (o.km <= 0 || o.seconds <= 0) continue;
      points.push({
        dateMs: o.dateMs,
        day: o.day,
        km: o.km,
        seconds: o.seconds,
        paceSecPerKm: metric === "pace" ? o.seconds / o.km : undefined,
        speedKmh: metric === "speed" ? o.km / (o.seconds / 3600) : undefined,
      });
    }
    let trend: DisciplinePace["trend"] = "flat";
    if (points.length >= 2) {
      const val = (p: DisciplinePacePoint) => (metric === "pace" ? p.paceSecPerKm! : p.speedKmh!);
      const third = Math.max(1, Math.floor(points.length / 3));
      const firstMean = points.slice(0, third).reduce((s, p) => s + val(p), 0) / third;
      const lastMean = points.slice(-third).reduce((s, p) => s + val(p), 0) / third;
      const delta = lastMean - firstMean;
      const tol = firstMean * 0.02;
      if (Math.abs(delta) <= tol) trend = "flat";
      else if (metric === "pace") trend = delta < 0 ? "improving" : "declining";
      else trend = delta > 0 ? "improving" : "declining";
    }
    disciplines.push({ discipline, metric, points, trend });
  }

  // Distance trend: mean weekly km of first vs last third of active weeks.
  const activeKm = weekly.filter((w) => w.sessions > 0).map((w) => w.km);
  let distanceTrend: "up" | "down" | "flat" = "flat";
  if (activeKm.length >= 2) {
    const third = Math.max(1, Math.floor(activeKm.length / 3));
    const firstMean = activeKm.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const lastMean = activeKm.slice(-third).reduce((a, b) => a + b, 0) / third;
    distanceTrend = direction(firstMean, lastMean, firstMean * 0.05);
  }

  const spanWeeks = Math.floor((maxWeek - minWeek) / WEEK_MS) + 1;
  return { weekly, totalKm, totalSeconds, disciplines, distanceTrend, activeWeeks: activeWeeks.size, spanWeeks };
}

// --- 4b. universal: training consistency (workouts per week) ---------------------------

export interface ConsistencyWeek {
  weekStart: string;
  sessions: number;
}
export interface ConsistencyTrend {
  weekly: ConsistencyWeek[];
  totalSessions: number;
  /** Mean workouts per week across every week in the covered span (zero weeks included). */
  avgPerWeek: number;
  /** Distinct weeks with ≥1 workout. */
  activeWeeks: number;
  /** Span in weeks between the first and last workout. */
  spanWeeks: number;
  /** Direction of workouts/week over the span (first third of weeks vs last third). */
  direction: "up" | "down" | "flat";
}

/**
 * Weekly workout counts across the merged history — the lead "taste" for a workout-dominant
 * history. Every Session counts as one workout, bucketed to its ISO-Monday week on a
 * zero-filled contiguous week axis; `avgPerWeek` is the mean over that span and `direction`
 * compares the first third of weeks to the last third. `weeks`, when given, keeps only the
 * most recent N weeks of the series.
 */
export function consistencyTrend(records: LiveRecord[], weeks?: number): ConsistencyTrend {
  const sessionMs: number[] = [];
  for (const rec of records) {
    if (rec.recordType !== "Session") continue;
    const t = ms(rec.startTime);
    if (t !== undefined) sessionMs.push(t);
  }
  if (sessionMs.length === 0) {
    return { weekly: [], totalSessions: 0, avgPerWeek: 0, activeWeeks: 0, spanWeeks: 0, direction: "flat" };
  }
  sessionMs.sort((a, b) => a - b);
  const minWeek = weekStartMs(sessionMs[0]);
  const maxWeek = weekStartMs(sessionMs[sessionMs.length - 1]);
  const allWeeks: number[] = [];
  for (let w = minWeek; w <= maxWeek; w += WEEK_MS) allWeeks.push(w);
  const kept = weeks && weeks > 0 ? allWeeks.slice(-weeks) : allWeeks;
  const idx = new Map(kept.map((w, i) => [w, i]));
  const counts: number[] = new Array(kept.length).fill(0);
  let totalSessions = 0;
  for (const t of sessionMs) {
    const i = idx.get(weekStartMs(t));
    if (i !== undefined) { counts[i]++; totalSessions++; }
  }
  const weekly: ConsistencyWeek[] = kept.map((w, i) => ({ weekStart: isoDay(w), sessions: counts[i] }));
  const avgPerWeek = kept.length > 0 ? totalSessions / kept.length : 0;
  const activeWeeks = counts.filter((c) => c > 0).length;

  let dir: "up" | "down" | "flat" = "flat";
  if (counts.length >= 2) {
    const third = Math.max(1, Math.floor(counts.length / 3));
    const firstMean = counts.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const lastMean = counts.slice(-third).reduce((a, b) => a + b, 0) / third;
    dir = direction(firstMean, lastMean, Math.max(0.3, firstMean * 0.15));
  }
  const spanWeeks = Math.floor((maxWeek - minWeek) / WEEK_MS) + 1;
  return { weekly, totalSessions, avgPerWeek, activeWeeks, spanWeeks, direction: dir };
}

// --- 5. universal: bulk / cut phases ---------------------------------------------------

export interface BulkCutPhase {
  startDay: string;
  endDay: string;
  startMs: number;
  endMs: number;
  startValue: number;
  endValue: number;
  deltaValue: number;
  durationDays: number;
  direction: "up" | "down" | "flat";
  /** Descriptive, neutral label for chart annotation. */
  label: "bulk" | "cut" | "maintain";
}

// A phase only earns a bulk/cut band when the smoothed trend makes a SUSTAINED, MATERIAL,
// and PACED move: at least ~6 weeks long, at least ~2 kg net swing, AND moving at a real
// bulk/cut pace rather than a slow multi-year drift. This is the flat-data fix — a near-flat
// history (e.g. 2–4 kg wandered across several YEARS) used to be over-labelled with spurious
// bands; the rate floor keeps those as "maintain" while still catching a genuine cut/bulk
// (kilos over a few months). Tuned against real Hevy measurement data (a ~0.008 kg/day drift
// must NOT label; a real phase runs ~0.03+ kg/day).
const BULK_CUT_MIN_DAYS = 42; // ~6 weeks sustained
const BULK_CUT_MIN_DELTA = 2; // ~2 kg net swing over the phase (trend unit, typically kg)
const BULK_CUT_MIN_RATE = 0.015; // ~0.45 kg/month — below this it's drift, not a phase

/**
 * Segment an EWMA bodyweight trend into sustained up/down phases for neutral chart
 * annotation — "bulk" (sustained rise) or "cut" (sustained fall). A zig-zag over the
 * *smoothed* trend finds turning points larger than a noise threshold (scaled to bodyweight),
 * so day-to-day wobble doesn't fragment the phases; only segments that are both long enough
 * and large enough (see thresholds above) are kept — flat/near-flat histories return `[]`.
 * Purely descriptive: it labels what the trend did, it does not judge or prescribe. Feed it
 * `bodyweightTrend(records).points` (or any `TrendPoint[]`).
 */
export function bulkCutPhases(trend: TrendPoint[]): BulkCutPhase[] {
  const n = trend.length;
  if (n < 2) return [];
  const values = trend.map((p) => p.trend).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const thr = Math.max(0.7, 0.012 * median); // ~1.2% of bodyweight, floor 0.7 kg

  // Zig-zag turning points over the smoothed trend.
  const pivots: number[] = [];
  let dir: 0 | 1 | -1 = 0;
  let extremeIdx = 0;
  for (let i = 1; i < n; i++) {
    const v = trend[i].trend;
    const ext = trend[extremeIdx].trend;
    if (dir === 0) {
      if (v > ext + thr) { dir = 1; extremeIdx = i; }
      else if (v < ext - thr) { dir = -1; extremeIdx = i; }
    } else if (dir === 1) {
      if (v >= ext) extremeIdx = i;
      else if (v < ext - thr) { pivots.push(extremeIdx); dir = -1; extremeIdx = i; }
    } else {
      if (v <= ext) extremeIdx = i;
      else if (v > ext + thr) { pivots.push(extremeIdx); dir = 1; extremeIdx = i; }
    }
  }

  const bounds: number[] = [0];
  for (const p of pivots) if (p !== bounds[bounds.length - 1]) bounds.push(p);
  if (bounds[bounds.length - 1] !== n - 1) bounds.push(n - 1);

  const phases: BulkCutPhase[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = trend[bounds[i]];
    const b = trend[bounds[i + 1]];
    const delta = b.trend - a.trend;
    const durationDays = Math.round((b.t - a.t) / DAY_MS);
    const dirn = direction(a.trend, b.trend, thr);
    // A short, small-magnitude, or slow-drifting segment reads as "maintain"; only a
    // sustained (≥6-week), material (≥~2 kg net), AND paced (not a multi-year drift)
    // directional move earns a bulk/cut label.
    const rateKgPerDay = durationDays > 0 ? Math.abs(delta) / durationDays : 0;
    const material = Math.abs(delta) >= BULK_CUT_MIN_DELTA && rateKgPerDay >= BULK_CUT_MIN_RATE;
    const label: BulkCutPhase["label"] =
      dirn === "flat" || durationDays < BULK_CUT_MIN_DAYS || !material
        ? "maintain"
        : dirn === "up" ? "bulk" : "cut";
    phases.push({
      startDay: a.day,
      endDay: b.day,
      startMs: a.t,
      endMs: b.t,
      startValue: a.trend,
      endValue: b.trend,
      deltaValue: delta,
      durationDays,
      direction: dirn,
      label,
    });
  }
  // Only surface material bulk/cut bands; "maintain" segments (flat/short/small) are dropped,
  // so a near-flat history produces zero phases and the chart shows no spurious bands.
  return phases.filter((p) => p.label !== "maintain");
}

// --- 6. insight plan (the selector the UI calls) ---------------------------------------

export type InsightBlockId =
  | "bodyweight-trend"
  | "bulk-cut"
  | "pr-timeline"
  | "relative-strength"
  | "volume-muscle-group"
  | "calisthenics-progress"
  | "endurance-trends";

export interface PlannedBlock {
  id: InsightBlockId;
  /** Short human explanation of why this block earned a place (and its sample size). */
  reason: string;
}
export interface InsightPlanResult {
  profile: ActivityProfile;
  blocks: PlannedBlock[];
}

// Sufficiency thresholds (per the "never surface an empty/low-N card" research):
//  - a line chart needs ≥10 points spanning ≥14 days;
//  - a PR list needs ≥3 sessions for at least one lift;
//  - a plateau read needs ≥6 weeks;
//  - endurance needs ≥8 weeks of span;
//  - bodyweight trend is always shown when body_mass exists.
const LINE_MIN_POINTS = 10;
const LINE_MIN_SPAN_DAYS = 14;
const PR_MIN_SESSIONS = 3;
const VOLUME_MIN_WEEKS = 4;
const VOLUME_MIN_SETS = 10;
const ENDURANCE_MIN_WEEKS = 8;
const BULKCUT_MIN_POINTS = 10;
const BULKCUT_MIN_SPAN_DAYS = 28;

function spanDays(dateMsList: number[]): number {
  if (dateMsList.length < 2) return 0;
  return (Math.max(...dateMsList) - Math.min(...dateMsList)) / DAY_MS;
}

/**
 * The dashboard selector: from the merged records, decide WHICH insight blocks to show and in
 * WHAT order. Order is driven by `detectActivityProfile` (a lifter leads with PRs, a runner
 * with endurance trends, etc.); inclusion is gated by whether each block actually has enough
 * data to be worth a card (thresholds above). This is the single function the UI calls to lay
 * out the cockpit — it renders exactly `blocks`, in order, and nothing empty.
 */
export function insightPlan(records: LiveRecord[]): InsightPlanResult {
  const profile = detectActivityProfile(records);

  const bw = dailyBodyMass(records);
  const bwDays = bw.series.length;
  const bwSpan = spanDays(bw.series.map((p) => p.t));

  const cal = calisthenicsProgress(records, bw.series);
  const calLifts = cal.filter((c) => c.sessionCount >= PR_MIN_SESSIONS).length;

  const end = enduranceTrends(records);

  // LEAN CONVERTER: the strength-analytics blocks (e1RM/PR timeline, per-muscle volume,
  // relative strength) are deliberately no longer surfaced here — that on-page interpretation
  // moved out of the converter (the functions stay in this file, dormant, for other tools).
  // Availability + a reason string per remaining block.
  const available: Record<InsightBlockId, PlannedBlock | null> = {
    "bodyweight-trend":
      bwDays >= 2 ? { id: "bodyweight-trend", reason: `${bwDays} days of bodyweight` } : null,
    "bulk-cut":
      bwDays >= BULKCUT_MIN_POINTS && bwSpan >= BULKCUT_MIN_SPAN_DAYS
        ? { id: "bulk-cut", reason: `${Math.round(bwSpan)} days of bodyweight trend` }
        : null,
    "pr-timeline": null,
    "relative-strength": null,
    "volume-muscle-group": null,
    "calisthenics-progress":
      calLifts >= 1
        ? { id: "calisthenics-progress", reason: `${calLifts} bodyweight movement${calLifts === 1 ? "" : "s"}` }
        : null,
    "endurance-trends":
      end.spanWeeks >= ENDURANCE_MIN_WEEKS && end.activeWeeks >= 2
        ? { id: "endurance-trends", reason: `${end.activeWeeks} active weeks over ${end.spanWeeks} weeks` }
        : null,
  };

  // Profile-driven ordering. Filtered to available blocks, order preserved. The dormant
  // strength-analytics ids are omitted from every order (the converter never renders them).
  const orderByProfile: Record<Profile, InsightBlockId[]> = {
    strength: ["bodyweight-trend", "bulk-cut", "calisthenics-progress", "endurance-trends"],
    calisthenics: ["calisthenics-progress", "bodyweight-trend", "bulk-cut", "endurance-trends"],
    endurance: ["endurance-trends", "bodyweight-trend", "bulk-cut", "calisthenics-progress"],
    mixed: ["bodyweight-trend", "endurance-trends", "calisthenics-progress", "bulk-cut"],
  };

  const blocks: PlannedBlock[] = [];
  for (const id of orderByProfile[profile.profile]) {
    const b = available[id];
    if (b) blocks.push(b);
  }
  return { profile, blocks };
}

// --- 7. lean converter: taste selection + present record-type sections ------------------
//
// The lean converter shows exactly ONE small "taste" chart and groups the parsed data by
// record type. Both decisions are pure over the merged records so the client renderer and the
// node smoke test agree on what gets shown.

/** DOM-free "does this Session carry sets" test — mirrors the client's `hasSets`. */
function sessionHasSets(rec: LiveRecord): boolean {
  const r = rec as unknown as { exercises?: unknown[]; blocks?: unknown[] };
  return (r.exercises?.length ?? 0) > 0 || (r.blocks?.length ?? 0) > 0;
}

export type TasteChoice = "bodyweight" | "consistency" | "distance" | "none";

/**
 * Which single "taste" chart the lean converter should show, from the merged records: a
 * body-measurement-dominant history leads with the bodyweight trend, an endurance-dominant
 * one with weekly distance, and a workout-dominant one with weekly consistency.
 */
export function tasteChoice(records: LiveRecord[]): TasteChoice {
  const bwOk = dailyBodyMass(records).series.length >= 2;
  const sessions = records.filter((r) => r.recordType === "Session");
  const sessionsN = sessions.length;
  const measN = records.filter((r) => r.recordType === "Measurement").length;
  if (bwOk && (sessionsN === 0 || measN >= sessionsN)) return "bodyweight";
  if (sessionsN === 0) return bwOk ? "bodyweight" : "none";
  const strengthN = sessions.filter(sessionHasSets).length;
  const enduranceN = sessionsN - strengthN;
  const profile = detectActivityProfile(records).profile;
  if (profile === "endurance" || (enduranceN > strengthN && enduranceN > 0)) return "distance";
  return "consistency";
}

export type DataSectionKind = "measurements" | "strength" | "endurance";

/** Which record-type data sections are present in the merged records, in display order. */
export function presentSections(records: LiveRecord[]): DataSectionKind[] {
  const out: DataSectionKind[] = [];
  const measN = records.filter((r) => r.recordType === "Measurement").length;
  const sessions = records.filter((r) => r.recordType === "Session");
  const strengthN = sessions.filter(sessionHasSets).length;
  const enduranceN = sessions.length - strengthN;
  if (measN > 0) out.push("measurements");
  if (strengthN > 0) out.push("strength");
  if (enduranceN > 0) out.push("endurance");
  return out;
}
