// Pure, DOM-free insight helpers for /tools/convert/ (Phase A of the "convert cockpit").
//
// Everything here is presentation-shaping over already-mapped OpenBody `Measurement`
// records — no DOM, no network, no dependencies beyond @openbody/openbody-ts and the sibling
// humanize/format helpers. Keeping it pure means the same logic is node-smoke-testable and
// reusable by later phases (merged multi-source series, more metric trends, etc.).
import type { LiveRecord, WireNumber } from "@openbody/openbody-ts";
import {
  humanizeType,
  formatWireNumber,
  isNamespacedType,
} from "../lib/hevy/summarize-measurements";

// --- numbers ---------------------------------------------------------------------------

/** WireNumber → JS number, for charting/statistics only. Display still goes through
 * `formatWireNumber` so the exact decimal is never lost to a float round-trip; this is used
 * where we genuinely need arithmetic (EWMA, min/max, means). */
export function wireToNumber(v: WireNumber | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const n = v.coefficient * 10 ** v.exponent;
  return Number.isFinite(n) ? n : undefined;
}

/** `[in_i]` (UCUM international inch) → "in"; everything else passes through. */
function displayUnit(unit: string): string {
  return unit === "[in_i]" ? "in" : unit;
}

/** YYYY-MM-DD day key from an ISO instant (day-level grouping; body logs are daily). */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function dayLabel(dayIso: string): string {
  const d = new Date(`${dayIso}T00:00:00Z`);
  if (isNaN(d.getTime())) return dayIso;
  return d.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
}

// --- bodyweight trend (EWMA / "Hacker's Diet") -----------------------------------------

// Smoothing constant for the exponentially-weighted moving average. This is the Hacker's
// Diet "trend line" idea: raw daily bodyweight is dominated by water-weight / gut-content
// noise (±1–2 kg day to day), so we track an EWMA instead. alpha ≈ 0.1 means each day's
// reading contributes 10% and the running trend keeps 90% — a ~10-reading (~1–2 week) memory,
// which is the classic value that strips daily noise while still turning within a couple of
// weeks of a real change. Exported so callers/tests can override.
export const DEFAULT_EWMA_ALPHA = 0.1;

/** One merged calendar day of a single metric. */
export interface DailyValue {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** UTC-midnight epoch ms of that day — the x coordinate for time-accurate plotting. */
  t: number;
  /** Numeric value (mean of same-day readings). */
  value: number;
}

export interface TrendPoint extends DailyValue {
  /** EWMA-smoothed trend value at this day. */
  trend: number;
}

export interface BodyweightTrend {
  points: TrendPoint[];
  /** Display unit (e.g. "kg"). */
  unit: string;
  alpha: number;
  /** Convenience readouts for labelling. */
  first: TrendPoint;
  last: TrendPoint;
  /** Trend min / max over the range (for the y-scale + guide labels). */
  trendMin: number;
  trendMax: number;
  /** Raw min / max over the range (so faint dots never clip the plot box). */
  rawMin: number;
  rawMax: number;
}

/**
 * Collapse `body_mass` measurements into one mean value per calendar day, chronologically.
 * Same-day duplicates (e.g. two sources merged later) are averaged — this is why Phase B can
 * feed a pre-merged multi-source series straight in without changing anything here.
 */
export function dailyBodyMass(records: LiveRecord[]): { series: DailyValue[]; unit: string } {
  const byDay = new Map<string, { sum: number; n: number; t: number }>();
  let unit = "kg";
  for (const rec of records) {
    if (rec.recordType !== "Measurement" || rec.type !== "body_mass") continue;
    const value = wireToNumber(rec.quantity);
    const iso = String(rec.startTime ?? "");
    if (value === undefined || iso === "") continue;
    if (rec.unit) unit = displayUnit(String(rec.unit));
    const day = dayKey(iso);
    const t = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    const cur = byDay.get(day) ?? { sum: 0, n: 0, t };
    cur.sum += value;
    cur.n += 1;
    byDay.set(day, cur);
  }
  const series = [...byDay.entries()]
    .map(([day, { sum, n, t }]) => ({ day, t, value: sum / n }))
    .sort((a, b) => a.t - b.t);
  return { series, unit };
}

/**
 * Attach an EWMA trend to a chronological daily series. Pure over the (already day-merged)
 * sequence: `trend[0] = value[0]`, then `trend[i] = trend[i-1] + alpha·(value[i] − trend[i-1])`.
 * Gaps between logged days aren't time-weighted in Phase A (each logged day is one step) —
 * a deliberate simplification; gap-aware decay is a Phase B/C refinement.
 */
export function withEwmaTrend(series: DailyValue[], alpha = DEFAULT_EWMA_ALPHA): TrendPoint[] {
  let trend = 0;
  return series.map((p, i) => {
    trend = i === 0 ? p.value : trend + alpha * (p.value - trend);
    return { ...p, trend };
  });
}

/** Full bodyweight trend (day-merged raw + EWMA), or null when there's no body_mass data. */
export function bodyweightTrend(
  records: LiveRecord[],
  alpha = DEFAULT_EWMA_ALPHA,
): BodyweightTrend | null {
  const { series, unit } = dailyBodyMass(records);
  if (series.length === 0) return null;
  const points = withEwmaTrend(series, alpha);
  const trends = points.map((p) => p.trend);
  const raws = points.map((p) => p.value);
  return {
    points,
    unit,
    alpha,
    first: points[0],
    last: points[points.length - 1],
    trendMin: Math.min(...trends),
    trendMax: Math.max(...trends),
    rawMin: Math.min(...raws),
    rawMax: Math.max(...raws),
  };
}

// --- compact per-day measurements table ------------------------------------------------

export interface MeasurementColumn {
  /** Stable per-column key: `type` plus laterality (so left/right circumferences split). */
  key: string;
  type: string;
  laterality?: string;
  /** Humanized header, e.g. "Body mass", "Bicep circumference (left)". */
  label: string;
  /** Display unit shown in the header (e.g. "kg", "%", "in"); "" when unitless. */
  unit: string;
  /** True when the underlying type is a namespaced registry-gap fallback (`ns:token`). */
  namespaced: boolean;
}

export interface MeasurementRow {
  /** YYYY-MM-DD (UTC). */
  day: string;
  dateLabel: string;
  /** column.key → formatted value string; missing cells are simply absent (blank). */
  cells: Record<string, string>;
}

export interface MeasurementTable {
  columns: MeasurementColumn[];
  /** One row per calendar day, chronological (oldest → newest), aligned with the chart. */
  rows: MeasurementRow[];
  dayCount: number;
}

/** Priority so the two headline body-composition metrics always lead the table. */
const COLUMN_PRIORITY: Record<string, number> = {
  body_mass: 0,
  body_fat_percentage: 1,
};

function columnKey(type: string, laterality?: string): string {
  return laterality ? `${type}|${laterality}` : type;
}

/**
 * Pivot `Measurement` records into ONE compact table: a row per calendar day, a column per
 * (type, laterality) present. This is the density fix — it replaces the old stack of one
 * <article> card per day. Sparse cells are simply omitted (rendered blank). Same-day, same-
 * column duplicates are meaned; the exact wire decimal is preserved for the common
 * single-reading case so no precision is invented.
 */
export function measurementTable(records: LiveRecord[]): MeasurementTable {
  const columns = new Map<string, MeasurementColumn>();
  const columnFirstSeen = new Map<string, number>();
  const rowByDay = new Map<
    string,
    { day: string; cells: Map<string, { formatted: string; sum: number; n: number }> }
  >();
  let seq = 0;

  for (const rec of records) {
    if (rec.recordType !== "Measurement") continue;
    const type = String(rec.type ?? "unknown");
    const laterality = rec.laterality;
    const iso = String(rec.startTime ?? "");
    if (iso === "") continue;
    const key = columnKey(type, laterality);

    if (!columns.has(key)) {
      columns.set(key, {
        key,
        type,
        laterality,
        label: humanizeType(type, laterality),
        unit: displayUnit(String(rec.unit ?? "")),
        namespaced: isNamespacedType(type),
      });
      columnFirstSeen.set(key, seq++);
    }

    const day = dayKey(iso);
    const row = rowByDay.get(day) ?? { day, cells: new Map() };
    const num = wireToNumber(rec.quantity);
    const formatted = rec.quantity === undefined ? "—" : formatWireNumber(rec.quantity);
    const cell = row.cells.get(key);
    if (cell === undefined) {
      row.cells.set(key, { formatted, sum: num ?? 0, n: num === undefined ? 0 : 1 });
    } else if (num !== undefined) {
      // A second same-day reading for this column: fall back to a mean (loses the exact
      // decimal, but multi-reading days are the uncommon path this guards against).
      cell.sum += num;
      cell.n += 1;
      cell.formatted = String(Math.round((cell.sum / cell.n) * 100) / 100);
    }
    rowByDay.set(day, row);
  }

  const orderedColumns = [...columns.values()].sort((a, b) => {
    const pa = COLUMN_PRIORITY[a.type] ?? 100;
    const pb = COLUMN_PRIORITY[b.type] ?? 100;
    if (pa !== pb) return pa - pb;
    return (columnFirstSeen.get(a.key) ?? 0) - (columnFirstSeen.get(b.key) ?? 0);
  });

  const rows: MeasurementRow[] = [...rowByDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((r) => {
      const cells: Record<string, string> = {};
      for (const [key, v] of r.cells) cells[key] = v.formatted;
      return { day: r.day, dateLabel: dayLabel(r.day), cells };
    });

  return { columns: orderedColumns, rows, dayCount: rows.length };
}
