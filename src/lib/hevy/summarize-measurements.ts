// Turns the `Measurement` records from `mapHevyMeasurements` (Hevy's `measurement_data.csv`)
// into a small, presentation-only shape for the /tools/convert/ preview. Measurements aren't
// sessions — there's nothing to resolve against the exercise registry and no set-by-set
// preview to show; this is just a date-grouped view over point-in-time body metrics. Not part
// of the OpenBody data model itself.
import type { LiveRecord, WireNumber } from "@openbody/openbody-ts";

export interface MeasurementLine {
  /** Raw `Measurement.type` token (e.g. `body_mass`, `hevy:circumference_bicep_left`). */
  type: string;
  /** Humanized label (e.g. "Body mass", "Bicep circumference (left)"). */
  label: string;
  /** True when the type is a `hevy:`-namespaced fallback (no canonical registry token yet). */
  namespaced: boolean;
  /** Exact decimal, straight from the wire number — no float round-trip. */
  value: string;
  /** Display unit (`[in_i]` shown as `in`). */
  unit: string;
}

export interface MeasurementDateGroup {
  iso: string;
  dateLabel: string;
  lines: MeasurementLine[];
}

export interface MeasurementsSummary {
  count: number;
  /** Distinct measurement types across all rows. */
  typeCount: number;
  /** Distinct humanized labels that are `hevy:`-namespaced (the registry-gap caveat). */
  namespacedLabels: string[];
  rangeStart?: string;
  rangeEnd?: string;
  groups: MeasurementDateGroup[];
}

const CANONICAL_LABEL: Record<string, string> = {
  body_mass: "Body mass",
  body_fat_percentage: "Body fat percentage",
};

/** Humanize a `Measurement.type` token for display. Canonical tokens get a friendly name;
 * `hevy:circumference_<part>[_<side>]` becomes e.g. "Bicep circumference (left)". */
export function humanizeType(type: string): string {
  const canonical = CANONICAL_LABEL[type];
  if (canonical) return canonical;
  const m = type.match(/^hevy:circumference_(.+)$/);
  if (m) {
    const side = m[1].match(/^(.*)_(left|right)$/);
    const base = side ? side[1] : m[1];
    const cap = base.charAt(0).toUpperCase() + base.slice(1);
    return side ? `${cap} circumference (${side[2]})` : `${cap} circumference`;
  }
  return type;
}

/** `[in_i]` (UCUM international inch) → "in"; everything else passes through. */
function displayUnit(unit: string): string {
  return unit === "[in_i]" ? "in" : unit;
}

/**
 * Render a wire number as its exact decimal string (§4.2 fixed-point is `coefficient ×
 * 10^exponent`). Reconstructed digit-wise rather than via `Number()` so we don't reintroduce
 * float artifacts the mapper deliberately avoided.
 */
export function formatWireNumber(v: WireNumber): string {
  if (typeof v === "number") return String(v);
  const { coefficient, exponent } = v;
  if (exponent >= 0) return String(coefficient * 10 ** exponent);
  const sign = coefficient < 0 ? "-" : "";
  const digits = String(Math.abs(coefficient)).padStart(-exponent + 1, "0");
  const cut = digits.length + exponent;
  const dec = `${digits.slice(0, cut)}.${digits.slice(cut)}`.replace(/\.?0+$/, "");
  return sign + dec;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Group `Measurement` records by their instant, most recent first. */
export function summarizeMeasurements(records: LiveRecord[]): MeasurementsSummary {
  const byIso = new Map<string, MeasurementLine[]>();
  const types = new Set<string>();
  const namespaced = new Map<string, string>(); // type → label, dedup for the caveat
  let min = Infinity;
  let max = -Infinity;

  for (const rec of records) {
    if (rec.recordType !== "Measurement") continue;
    const type = String(rec.type ?? "unknown");
    types.add(type);
    const isNamespaced = type.startsWith("hevy:");
    const label = humanizeType(type);
    if (isNamespaced) namespaced.set(type, label);

    const iso = String(rec.startTime ?? "");
    const line: MeasurementLine = {
      type,
      label,
      namespaced: isNamespaced,
      value: rec.quantity === undefined ? "—" : formatWireNumber(rec.quantity),
      unit: displayUnit(String(rec.unit ?? "")),
    };
    const bucket = byIso.get(iso) ?? [];
    if (bucket.length === 0) byIso.set(iso, bucket);
    bucket.push(line);

    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms)) {
      min = Math.min(min, ms);
      max = Math.max(max, ms);
    }
  }

  const groups: MeasurementDateGroup[] = [...byIso.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)) // newest first
    .map(([iso, lines]) => ({ iso, dateLabel: dateLabel(iso), lines }));

  return {
    count: groups.reduce((n, g) => n + g.lines.length, 0),
    typeCount: types.size,
    namespacedLabels: [...namespaced.values()],
    rangeStart: min !== Infinity ? new Date(min).toISOString() : undefined,
    rangeEnd: max !== -Infinity ? new Date(max).toISOString() : undefined,
    groups,
  };
}
