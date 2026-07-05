// Client-side source handling for /tools/convert/: detect which app an export file came
// from, and thin parse adapters that feed the real @openbody/openbody-ts mappers.
//
// Design constraints (deliberate):
// - 100% client-side. No network, no dependencies beyond the already-imported
//   @openbody/openbody-ts package. Apple Health XML is consumed as plain text by
//   `mapAppleHealth` (it does its own lightweight parsing), so no DOMParser/zip lib needed.
// - The openbody-ts mapper signatures are the contract; this module ADAPTS real export
//   files to them rather than changing them. Concretely: `mapStrava` consumes the Strava
//   API's `{ activity, streams }` wire shape, but a bulk account export gives you
//   `activities.csv` (summary rows, no streams) — so `mapStravaActivitiesCsv` below turns
//   each CSV row into a minimal StravaInput with empty streams. Per-activity GPX/FIT
//   stream parsing is intentionally out of scope for now.
import { mapStrava, type LiveRecord, type ScalarOrTarget } from "@openbody/openbody-ts";

export type SourceId = "hevy" | "hevy-measurements" | "strong" | "apple-health" | "strava";

export const SOURCE_LABEL: Record<SourceId, string> = {
  hevy: "Hevy workout CSV",
  "hevy-measurements": "Hevy body-measurement CSV",
  strong: "Strong workout CSV",
  "apple-health": "Apple Health export.xml",
  strava: "Strava activities.csv",
};

/** Strength sources get the exercise-resolution + set-by-set preview; endurance sources
 * get a sessions/disciplines/distance summary; `measurements` sources (Hevy's
 * `measurement_data.csv`) have no sessions at all — just point-in-time body metrics, shown
 * as a date-grouped table. */
export const SOURCE_KIND: Record<SourceId, "strength" | "endurance" | "measurements"> = {
  hevy: "strength",
  "hevy-measurements": "measurements",
  strong: "strength",
  "apple-health": "endurance",
  strava: "endurance",
};

// --- detection -------------------------------------------------------------------------

/** Split one CSV line into trimmed, unquoted cells (header sniffing only). */
function sniffHeaderCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";") { cells.push(cell); cell = ""; }
    else cell += c;
  }
  cells.push(cell);
  return cells.map((c) => c.trim().toLowerCase());
}

/**
 * Work out which supported export a file is, from its name + content. Content wins over
 * extension: CSV headers are distinctive per app, and Apple Health is the only XML source.
 * Returns null when the file doesn't look like any supported export.
 */
export function detectSource(fileName: string, text: string): SourceId | null {
  const head = text.slice(0, 8192).replace(/^\uFEFF/, "");
  const looksXml = /\.xml$/i.test(fileName) || /^\s*</.test(head);
  if (looksXml) {
    // The <HealthData> root can sit after a long DTD in real exports; scan the whole text.
    return text.includes("<HealthData") ? "apple-health" : null;
  }
  const cols = sniffHeaderCells(head.split(/\r?\n/, 1)[0] ?? "");
  const has = (name: string) => cols.includes(name);
  if (has("exercise_title") && has("start_time")) return "hevy";
  // Hevy's `measurement_data.csv` (body metrics): a `date` column plus at least one metric
  // column, and — crucially — NO `exercise_title` (that would be the workout export above,
  // which wins). The metric columns are `weight_kg`, `fat_percent`, or any `*_in`/`*_cm`
  // circumference (Hevy names circumference columns by the user's chosen length unit — inches
  // OR centimetres); a partial export (some metrics never logged) still matches.
  if (
    has("date") &&
    !has("exercise_title") &&
    (has("weight_kg") || has("fat_percent") || cols.some((c) => c.endsWith("_in") || c.endsWith("_cm")))
  )
    return "hevy-measurements";
  if (has("workout name") && has("exercise name")) return "strong";
  if (has("activity id") && has("activity date")) return "strava";
  return null;
}

// --- Strava activities.csv adapter ------------------------------------------------------

/** Quote-aware CSV → raw rows (keeps the header row so duplicate column names survive —
 * Strava's activities.csv really does have two "Distance" and two "Elapsed Time" columns). */
function parseCsvRaw(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (cell !== "" || row.length) { row.push(cell); rows.push(row); row = []; cell = ""; }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Strava bulk-export dates look like "Jun 20, 2018, 6:15:23 AM" and are UTC. */
export function parseStravaDate(s: string): string | null {
  const m = s.trim().match(
    /^([A-Za-z]{3})\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}):(\d{2})(?: ?(AM|PM))?$/i,
  );
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    let h = Number(m[4]);
    const ap = m[7]?.toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    if (mon !== undefined) {
      const d = new Date(Date.UTC(Number(m[3]), mon, Number(m[2]), h, Number(m[5]), Number(m[6])));
      return d.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const numOf = (s: string | undefined): number | undefined => {
  if (s == null || s.trim() === "") return undefined;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Map a Strava bulk-export `activities.csv` to OpenBody records, one Session per activity,
 * by adapting each summary row into the `{ activity, streams }` shape `mapStrava` consumes
 * (with empty streams — the CSV has no samples). Summary fields only: sport, start time,
 * elapsed/moving time, distance, name.
 */
export function mapStravaActivitiesCsv(csv: string): LiveRecord[] {
  const rows = parseCsvRaw(csv.replace(/^\uFEFF/, ""));
  const header = (rows.shift() ?? []).map((h) => h.trim());
  const allIdx = (name: string) =>
    header.reduce<number[]>((acc, h, i) => (h === name ? [...acc, i] : acc), []);
  const firstIdx = (name: string) => header.indexOf(name);
  const cell = (row: string[], name: string) => {
    const i = firstIdx(name);
    return i >= 0 ? (row[i] ?? "") : "";
  };
  // Full exports carry the summary "Distance" (km) early and a second raw "Distance"
  // (metres) later in the row; prefer the metres one when both exist.
  const distIdx = allIdx("Distance");
  const elapsedIdx = allIdx("Elapsed Time");

  const records: LiveRecord[] = [];
  rows.forEach((row, i) => {
    if (row.every((c) => c.trim() === "")) return;
    const start = parseStravaDate(cell(row, "Activity Date"));
    if (!start) return; // not a data row we can anchor in time — skip
    const elapsed = numOf(row[elapsedIdx[0]]) ?? 0;
    const moving = numOf(cell(row, "Moving Time"));
    let distance: number | undefined;
    if (distIdx.length >= 2) distance = numOf(row[distIdx[1]]);
    if (distance === undefined && distIdx.length >= 1) {
      const km = numOf(row[distIdx[0]]);
      if (km !== undefined) distance = km * 1000;
    }
    const activity = {
      id: cell(row, "Activity ID") || `row${i + 1}`,
      sport_type: cell(row, "Activity Type") || "workout",
      start_date: start,
      elapsed_time: elapsed,
      moving_time: moving ?? elapsed,
      distance: distance ?? 0,
    };
    const mapped = mapStrava({ activity, streams: { time: { data: [] } } }).records;
    const name = cell(row, "Activity Name");
    for (const rec of mapped) {
      if (rec.recordType !== "Session") continue;
      if (name) rec.name = name;
      // Distance-less activities (yoga, weight training, …): drop the placeholder rather
      // than claim a real 0 m performance.
      if (distance === undefined) {
        for (const wu of rec.workUnits ?? []) delete wu.performance?.distance;
      }
    }
    records.push(...mapped);
  });
  return records;
}

// --- endurance summary -------------------------------------------------------------------

export interface EnduranceSessionLine {
  name: string;
  dateLabel: string;
  parts: string[]; // e.g. ["running", "10.0 km", "42 min"]
}

export interface EnduranceSummary {
  sessionCount: number;
  measurementCount: number;
  measurementsByType: [string, number][];
  disciplines: [string, number][];
  totalKm: number;
  totalSeconds: number;
  sessions: EnduranceSessionLine[];
}

/**
 * Pull the numeric value + unit out of a WorkUnit performance field. Mappers only ever
 * emit performed distance/time as an absolute measurement (`{ absolute: { value, unit } }`)
 * — the other ScalarOrTarget variants (range/relativeToThreshold/stopCondition) describe
 * prescriptions/targets, not what actually happened — so this narrows to that one shape.
 */
function absoluteOf(v: ScalarOrTarget | undefined): { value: number; unit?: string } | undefined {
  if (v && typeof v === "object" && "absolute" in v && typeof v.absolute.value === "number") {
    return { value: v.absolute.value, unit: v.absolute.unit };
  }
  return undefined;
}

const toKm = (value: number, unit: string): number => {
  switch (unit) {
    case "m": return value / 1000;
    case "km": return value;
    case "mi": return value * 1.609344;
    default: return 0;
  }
};

export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const min = Math.round((s % 3600) / 60);
  if (h > 0) return `${h} h ${min} min`;
  if (min > 0) return `${min} min`;
  return `${s} s`;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `totalSeconds` → "7:23 h" (or "42 min" under an hour) for the unified summary. */
export function formatHoursMinutes(totalSeconds: number): string {
  let h = Math.floor(totalSeconds / 3600);
  let min = Math.round((totalSeconds % 3600) / 60);
  if (min === 60) { h++; min = 0; }
  if (h > 0) return `${h}:${String(min).padStart(2, "0")} h`;
  if (min > 0) return `${min} min`;
  return `${Math.round(totalSeconds)} s`;
}

/** Presentation-only rollup of endurance-shaped records (Sessions + Measurements). */
export function summarizeEndurance(records: LiveRecord[]): EnduranceSummary {
  const disciplines = new Map<string, number>();
  const measurementsByType = new Map<string, number>();
  let sessionCount = 0;
  let measurementCount = 0;
  let totalKm = 0;
  let totalSeconds = 0;
  const sessions: EnduranceSessionLine[] = [];

  for (const rec of records) {
    if (rec.recordType === "Measurement") {
      measurementCount++;
      const t = String(rec.type ?? "unknown");
      measurementsByType.set(t, (measurementsByType.get(t) ?? 0) + 1);
      continue;
    }
    if (rec.recordType !== "Session") continue;
    sessionCount++;
    const discipline = String(rec.disciplines?.[0] ?? "unknown");
    disciplines.set(discipline, (disciplines.get(discipline) ?? 0) + 1);

    let km = 0;
    let seconds = 0;
    for (const wu of rec.workUnits ?? []) {
      const p = wu.performance ?? {};
      const dist = absoluteOf(p.distance);
      if (dist) km += toKm(dist.value, String(dist.unit ?? "m"));
      const time = absoluteOf(p.time);
      if (time && time.unit === "s") seconds += time.value;
    }
    if (seconds === 0 && rec.startTime && rec.endTime) {
      const span = (new Date(rec.endTime).getTime() - new Date(rec.startTime).getTime()) / 1000;
      if (Number.isFinite(span) && span > 0) seconds = span;
    }
    totalKm += km;
    totalSeconds += seconds;

    const parts = [discipline];
    if (km > 0) parts.push(`${km.toFixed(km >= 100 ? 0 : 1)} km`);
    if (seconds > 0) parts.push(formatDuration(seconds));
    sessions.push({
      name: rec.name || discipline.charAt(0).toUpperCase() + discipline.slice(1),
      dateLabel: dateLabel(String(rec.startTime ?? "")),
      parts,
    });
  }

  const byCountDesc = (a: [string, number], b: [string, number]) => b[1] - a[1];
  return {
    sessionCount,
    measurementCount,
    measurementsByType: [...measurementsByType.entries()].sort(byCountDesc),
    disciplines: [...disciplines.entries()].sort(byCountDesc),
    totalKm,
    totalSeconds,
    sessions,
  };
}

// --- unified post-conversion summary ------------------------------------------------------
// One presentation-only rollup for the summary card that renders after every conversion,
// regardless of source: sessions + date range + disciplines, top movements by set count
// (canonical registry ids where §6 resolution matched, lossless opaque names otherwise),
// and per-week activity buckets for the inline-SVG sparkline. Pure data — no DOM here.

export interface TopMovement {
  /** Canonical registry id when §6 resolution matched the app's name; undefined when opaque. */
  id?: string;
  /** Display label: the canonical id when resolved, else the app's own (lossless) name. */
  label: string;
  setCount: number;
}

export interface WeeklyPoint {
  /** UTC start of the bucket, as YYYY-MM-DD. */
  bucketStart: string;
  value: number;
}

export interface UnifiedSummary {
  sessionCount: number;
  /** ISO startTime of the earliest / latest dated session; undefined when none carry dates. */
  rangeStart?: string;
  rangeEnd?: string;
  disciplines: [string, number][];
  /** Strength: total logged sets + per-movement set counts, most-trained first. */
  totalSets: number;
  topMovements: TopMovement[];
  /** Endurance rollup (0 when the source has none). */
  totalKm: number;
  totalSeconds: number;
  measurementCount: number;
  measurementsByType: [string, number][];
  weekly: {
    points: WeeklyPoint[];
    /** Falls back to month buckets when weekly bars would span more than ~4 years. */
    bucket: "week" | "month";
    metric: "sets" | "km" | "hours";
  };
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** UTC-midnight Monday of the week containing `ms`. */
function weekStartMs(ms: number): number {
  const d = new Date(ms);
  const monOffset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - monOffset);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Roll every converted record up into the one summary card shown above the downloads. */
export function summarizeUnified(
  records: LiveRecord[],
  kind: "strength" | "endurance",
): UnifiedSummary {
  const disciplines = new Map<string, number>();
  const measurementsByType = new Map<string, number>();
  const movements = new Map<string, TopMovement>();
  let sessionCount = 0;
  let measurementCount = 0;
  let totalSets = 0;
  let totalKm = 0;
  let totalSeconds = 0;
  let minStartMs = Infinity;
  let maxStartMs = -Infinity;
  const perSession: { startMs: number; sets: number; km: number; seconds: number }[] = [];

  for (const rec of records) {
    if (rec.recordType === "Measurement") {
      measurementCount++;
      const t = String(rec.type ?? "unknown");
      measurementsByType.set(t, (measurementsByType.get(t) ?? 0) + 1);
      continue;
    }
    if (rec.recordType !== "Session") continue;
    sessionCount++;
    const discipline = String(rec.disciplines?.[0] ?? "unknown");
    disciplines.set(discipline, (disciplines.get(discipline) ?? 0) + 1);

    // Sets per movement — Session.exercises plus Block children (supersets).
    let sets = 0;
    const exercises = [
      ...(rec.exercises ?? []),
      ...(rec.blocks ?? []).flatMap((b) => b.children ?? []),
    ];
    for (const ex of exercises) {
      if (ex?.recordType !== "Exercise") continue;
      const n = (ex.workUnits ?? []).length;
      sets += n;
      const er = ex.exerciseRef;
      if (er === undefined) continue;
      const id = typeof er === "string" ? er : er.id;
      const opaque = typeof er === "string" ? undefined : er.opaque;
      const key = id ?? `opaque:${opaque ?? "(unnamed)"}`;
      const entry = movements.get(key) ?? { id, label: id ?? opaque ?? "(unnamed)", setCount: 0 };
      entry.setCount += n;
      movements.set(key, entry);
    }
    totalSets += sets;

    // Endurance totals — distance/time on WorkUnits, session span as the time fallback.
    let km = 0;
    let seconds = 0;
    for (const wu of rec.workUnits ?? []) {
      const p = wu.performance ?? {};
      const dist = absoluteOf(p.distance);
      if (dist) km += toKm(dist.value, String(dist.unit ?? "m"));
      const time = absoluteOf(p.time);
      if (time && time.unit === "s") seconds += time.value;
    }
    if (seconds === 0 && rec.startTime && rec.endTime) {
      const span = (new Date(rec.endTime).getTime() - new Date(rec.startTime).getTime()) / 1000;
      if (Number.isFinite(span) && span > 0) seconds = span;
    }
    totalKm += km;
    totalSeconds += seconds;

    const startMs = new Date(String(rec.startTime ?? "")).getTime();
    if (Number.isFinite(startMs)) {
      minStartMs = Math.min(minStartMs, startMs);
      maxStartMs = Math.max(maxStartMs, startMs);
      perSession.push({ startMs, sets, km, seconds });
    }
  }

  // Weekly buckets across the full range (zero-filled so quiet weeks read as gaps).
  const metric: "sets" | "km" | "hours" =
    kind === "strength" ? "sets" : totalKm > 0 ? "km" : "hours";
  const points: WeeklyPoint[] = [];
  let bucket: "week" | "month" = "week";
  if (perSession.length > 0) {
    const firstWeek = weekStartMs(minStartMs);
    const weekCount = Math.floor((weekStartMs(maxStartMs) - firstWeek) / WEEK_MS) + 1;
    bucket = weekCount > 208 ? "month" : "week";
    const keyOf = (ms: number): number => {
      if (bucket === "week") return weekStartMs(ms);
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    };
    const sums = new Map<number, number>();
    for (const s of perSession) {
      const v = metric === "sets" ? s.sets : metric === "km" ? s.km : s.seconds / 3600;
      const k = keyOf(s.startMs);
      sums.set(k, (sums.get(k) ?? 0) + v);
    }
    // Walk every bucket from first to last, filling gaps with 0.
    let k = keyOf(minStartMs);
    const last = keyOf(maxStartMs);
    while (k <= last) {
      points.push({ bucketStart: isoDate(k), value: sums.get(k) ?? 0 });
      if (bucket === "week") k += WEEK_MS;
      else {
        const d = new Date(k);
        k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      }
    }
  }

  const byCountDesc = (a: [string, number], b: [string, number]) => b[1] - a[1];
  return {
    sessionCount,
    rangeStart: Number.isFinite(minStartMs) && minStartMs !== Infinity
      ? new Date(minStartMs).toISOString()
      : undefined,
    rangeEnd: maxStartMs !== -Infinity ? new Date(maxStartMs).toISOString() : undefined,
    disciplines: [...disciplines.entries()].sort(byCountDesc),
    totalSets,
    topMovements: [...movements.values()].sort((a, b) => b.setCount - a.setCount),
    totalKm,
    totalSeconds,
    measurementCount,
    measurementsByType: [...measurementsByType.entries()].sort(byCountDesc),
    weekly: { points, bucket, metric },
  };
}
