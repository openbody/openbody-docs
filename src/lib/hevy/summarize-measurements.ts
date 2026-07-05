// Turns the `Measurement` records from `mapHevyMeasurements` (Hevy's `measurement_data.csv`)
// into a small, presentation-only shape for the /tools/convert/ preview. Measurements aren't
// sessions — there's nothing to resolve against the exercise registry and no set-by-set
// preview to show; this is just a date-grouped view over point-in-time body metrics. Not part
// of the OpenBody data model itself.
import type { LiveRecord, WireNumber } from "@openbody/openbody-ts";

export interface MeasurementLine {
  /** Raw, side-agnostic `Measurement.type` token (e.g. `body_mass`, `bicep_circumference`). */
  type: string;
  /** Humanized label (e.g. "Body mass", "Bicep circumference (left)"). */
  label: string;
  /** True when the type is a namespaced (`ns:token`) fallback with no canonical registry
   * token — now rare/none, since the mapper emits canonical anthropometry tokens. */
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
  /** Distinct humanized labels that are still namespaced (the registry-gap caveat). Now
   * typically empty — the mapper emits canonical tokens for every Hevy metric. */
  namespacedLabels: string[];
  rangeStart?: string;
  rangeEnd?: string;
  groups: MeasurementDateGroup[];
}

const CANONICAL_LABEL: Record<string, string> = {
  body_mass: "Body mass",
  body_fat_percentage: "Body fat percentage",
};

/** True when a `Measurement.type` token is namespaced (`ns:token`) — i.e. a registry-gap
 * fallback with no canonical token. Canonical tokens carry no `:`, so this is now typically
 * false for every Hevy metric. */
export function isNamespacedType(type: string): boolean {
  return /^[a-z0-9]+:/.test(type);
}

/** Humanize a `Measurement.type` token (plus its optional `laterality`, §4.1) for display.
 * Canonical body-composition tokens get a friendly name from the lookup; the SIDE-AGNOSTIC
 * anthropometry circumference tokens (`<part>_circumference`, e.g. `bicep_circumference`)
 * render as "Bicep circumference", with the side appended from `laterality` when present
 * ("Bicep circumference (left)"); any remaining namespaced fallback (`ns:token`) is
 * de-namespaced and de-underscored. */
export function humanizeType(type: string, laterality?: string): string {
  const canonical = CANONICAL_LABEL[type];
  if (canonical) return canonical;
  const circ = type.match(/^(.+)_circumference$/);
  if (circ) {
    const part = circ[1].replace(/_/g, " ");
    const cap = part.charAt(0).toUpperCase() + part.slice(1);
    return laterality ? `${cap} circumference (${laterality})` : `${cap} circumference`;
  }
  const ns = type.match(/^[a-z0-9]+:(.+)$/);
  if (ns) return ns[1].replace(/_/g, " ");
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
    const isNamespaced = isNamespacedType(type);
    const label = humanizeType(type, rec.laterality);
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
