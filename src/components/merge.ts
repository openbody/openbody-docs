// Pure, DOM-free multi-source merge for /tools/convert/ (Phase B of the "convert cockpit").
//
// Phase A converted ONE upload at a time. Phase B accumulates several uploads as "source
// layers" and unifies their records into one legible history — losslessly. This module is
// the core of that: given the layers, it returns the merged record array plus stats, and it
// NEVER drops a record silently. It's pure (no DOM, no network) so the same logic is
// node-smoke-testable and reused by the page's client script unchanged.
//
// Three safety properties, in priority order over UI nicety:
//  1. Lossless — every enabled layer's records are represented; only TRUE duplicates collapse.
//  2. Schema-valid — id namespacing and link-adding keep every record valid (no '#', §8.3).
//  3. Idempotent — merging the same layers twice, or re-importing a single source's own
//     openbody.json alongside itself, does not grow the merged set (exact-duplicate collapse).
//
// The dedup model follows SPEC §7.3 (preserve-and-link, not destructive dedup):
//  - EXACT duplicates (byte-identical canonical content, detected via `normalizeDocument`,
//    the same fingerprint `equivalent` compares) collapse to one record.
//  - NEAR duplicates (same activity seen by two apps) are NEVER deleted — they get a
//    reciprocal `sameActivityAs` link (§7.2) and are surfaced as "appears in N sources".
import { normalizeDocument, LosslessNumber, type LiveRecord, type Link } from "@openbody/openbody-ts";

/**
 * One accumulated upload. `records` is the layer's own mapped output and is treated as
 * immutable here (merge always works on clones). `namespaced` marks sources whose ids are
 * constant/positional literals (`apple-workout-6`, `fit-session`, `gpx-session`) that COLLIDE
 * across different files — those get an id prefix so two files can't be conflated; content-
 * stable sources (Hevy/Strong/Strava/Fitbit/Concept2) and re-imported OpenBody JSON keep
 * their ids so their dedup benefit (re-import → same id → exact collapse) survives.
 */
export interface SourceLayer {
  /** Stable per-layer key; doubles as the id-namespace prefix. MUST NOT contain '#'. */
  id: string;
  label: string;
  records: LiveRecord[];
  enabled: boolean;
  namespaced: boolean;
}

export interface PerSourceStat {
  id: string;
  label: string;
  /** Top-level records this layer contributed to the union (before dedup). */
  count: number;
}

export interface MergeStats {
  /** Records in the merged output (top-level). */
  total: number;
  /** Records removed because an exact (canonical-equivalent) duplicate was already present. */
  exactCollapsed: number;
  /** Records that gained a cross-source `sameActivityAs` link this merge. */
  linked: number;
  /** Number of enabled source layers. */
  sources: number;
  perSource: PerSourceStat[];
  /** Kinds present in the merged set, so the dashboard can show every relevant panel. */
  hasStrength: boolean;
  hasEndurance: boolean;
  hasMeasurements: boolean;
}

export interface MergeResult {
  merged: LiveRecord[];
  stats: MergeStats;
}

type AnyRec = Record<string, any>;

/**
 * Coerce a `parseLossless` tree to plain JS numbers, for the openbody.json re-import path.
 * `parseLossless` preserves every number as a `LosslessNumber` (exact source decimal) — great
 * for canonical equivalence, but `validate` (ajv) rejects the object form, and
 * `JSON.stringify` would quote it (via `toJSON`), corrupting the export. Mapper output is
 * already plain numbers, so coercing re-imports to plain keeps the WHOLE pipeline consistent:
 * they then validate, dedup (fingerprints are identical across plain/lossless — both
 * canonicalize to the same fixed-point), and export cleanly. The only cost is the >2^53 /
 * high-precision-decimal edge `parseLossless` guards against — irrelevant for fitness data,
 * and no worse than a plain `JSON.parse` would have done.
 */
export function toPlainNumbers<T>(value: T): T {
  if (value instanceof LosslessNumber) return Number(value.toString()) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => toPlainNumbers(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) out[k] = toPlainNumbers((value as AnyRec)[k]);
    return out as unknown as T;
  }
  return value;
}

const clone = <T>(x: T): T =>
  typeof structuredClone === "function" ? structuredClone(x) : JSON.parse(JSON.stringify(x));

/**
 * Canonical fingerprint of one top-level record: the sorted canonical byte strings its
 * subtree normalizes to (a Session expands to its flattened Exercise/WorkUnit records via
 * §8.3), joined. Two records with the same fingerprint are `equivalent` — the exact-dup key.
 * Falls back to a raw stringify only if normalization ever rejects a record (it shouldn't:
 * we only ever fingerprint mapper output or already-validated re-imports).
 */
function fingerprint(rec: LiveRecord): string {
  try {
    return normalizeDocument([rec]).join("");
  } catch {
    return "raw" + JSON.stringify(rec);
  }
}

/**
 * Prefix every id in a namespaced layer, and rewrite the intra-layer references that point at
 * those ids (links, supersedes, Program.sessions) so the record graph stays internally
 * consistent. Registry ids (exerciseRef) and participant refs are NOT record ids and are left
 * untouched. Operates on clones. The prefix uses ':' — legal in ids; only '#' is reserved.
 */
function namespaceRecords(records: AnyRec[], prefix: string): AnyRec[] {
  const own = new Set<string>();
  for (const r of records) if (typeof r.id === "string") own.add(r.id);
  const map = (id: unknown): unknown =>
    typeof id === "string" && own.has(id) ? `${prefix}:${id}` : id;

  for (const r of records) {
    if (typeof r.id === "string") r.id = `${prefix}:${r.id}`;
    if (typeof r.supersedes === "string") r.supersedes = map(r.supersedes);
    if (Array.isArray(r.links)) {
      for (const l of r.links as Link[]) if (l && typeof l.ref === "string") l.ref = map(l.ref) as string;
    }
    if (r.recordType === "Program" && Array.isArray(r.sessions)) {
      r.sessions = r.sessions.map(map);
      for (const ph of r.phases ?? []) if (Array.isArray(ph.sessions)) ph.sessions = ph.sessions.map(map);
    }
  }
  return records;
}

const NEAR_DUP_TOLERANCE_MS = 120_000; // clock-skew slack when matching the same activity across apps.

function ms(iso: unknown): number | undefined {
  if (typeof iso !== "string" || iso === "") return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** Coarse discipline set (lower-cased) for near-dup compatibility. */
function disciplineSet(rec: AnyRec): Set<string> {
  const out = new Set<string>();
  for (const d of rec.disciplines ?? []) if (typeof d === "string") out.add(d.toLowerCase());
  return out;
}

/**
 * Whether two Session survivors from DISTINCT sources plausibly describe the same activity
 * (§7.3 heuristic): same subject, compatible discipline (share a token, or one is unlabelled),
 * and overlapping time windows (with a small skew tolerance). Deliberately conservative — a
 * shown duplicate is cheaper than a wrong merge, so anything ambiguous returns false.
 */
function sameActivity(a: AnyRec, b: AnyRec): boolean {
  if (a.recordType !== "Session" || b.recordType !== "Session") return false;
  if (!a.subject || !b.subject || a.subject !== b.subject) return false;

  const da = disciplineSet(a);
  const db = disciplineSet(b);
  if (da.size > 0 && db.size > 0) {
    let shared = false;
    for (const d of da) if (db.has(d)) shared = true;
    if (!shared) return false;
  }

  const aStart = ms(a.startTime);
  const bStart = ms(b.startTime);
  if (aStart === undefined || bStart === undefined) return false;
  const aEnd = ms(a.endTime) ?? aStart;
  const bEnd = ms(b.endTime) ?? bStart;
  const tol = NEAR_DUP_TOLERANCE_MS;
  // Intervals (each padded by tol) intersect.
  return aStart - tol <= bEnd + tol && bStart - tol <= aEnd + tol;
}

function addLink(rec: AnyRec, ref: string): boolean {
  const links: Link[] = (rec.links ??= []);
  if (links.some((l) => l.type === "sameActivityAs" && l.ref === ref)) return false;
  links.push({ type: "sameActivityAs", ref });
  return true;
}

/**
 * Merge the ENABLED layers into one lossless, schema-valid, idempotent record set.
 * See the module header for the full contract.
 */
export function mergeLayers(layers: SourceLayer[]): MergeResult {
  const enabled = layers.filter((l) => l.enabled);

  // 1. Union: clone every layer's records, namespace the collision-prone ones, tag origin.
  interface Item { rec: AnyRec; layerId: string; }
  const items: Item[] = [];
  const perSource = new Map<string, PerSourceStat>();
  for (const layer of enabled) {
    perSource.set(layer.id, { id: layer.id, label: layer.label, count: 0 });
    const cloned = layer.records.map((r) => clone(r) as AnyRec);
    const effective = layer.namespaced ? namespaceRecords(cloned, layer.id) : cloned;
    for (const rec of effective) items.push({ rec, layerId: layer.id });
  }

  // 2. Exact-duplicate collapse: group by canonical fingerprint, keep first occurrence,
  //    remember every source a record appeared in.
  const byFp = new Map<string, { rec: AnyRec; layers: Set<string> }>();
  const order: string[] = [];
  for (const it of items) {
    perSource.get(it.layerId)!.count++;
    const fp = fingerprint(it.rec as LiveRecord);
    const hit = byFp.get(fp);
    if (hit) hit.layers.add(it.layerId);
    else {
      byFp.set(fp, { rec: it.rec, layers: new Set([it.layerId]) });
      order.push(fp);
    }
  }
  const survivors = order.map((fp) => byFp.get(fp)!);
  const merged = survivors.map((s) => s.rec);
  const exactCollapsed = items.length - merged.length;

  // 3. Near-duplicate linking (§7.3): sessions from distinct sources that plausibly describe
  //    the same activity get a reciprocal sameActivityAs link. Nothing is deleted.
  const primaryLayer = (s: { layers: Set<string> }) => [...s.layers][0];
  const linkedRecs = new Set<AnyRec>();
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const A = survivors[i];
      const B = survivors[j];
      if (primaryLayer(A) === primaryLayer(B)) continue; // same upload — not a cross-source pair
      if (!sameActivity(A.rec, B.rec)) continue;
      const idA = A.rec.id;
      const idB = B.rec.id;
      if (typeof idA !== "string" || typeof idB !== "string") continue;
      const a1 = addLink(A.rec, idB);
      const a2 = addLink(B.rec, idA);
      if (a1) linkedRecs.add(A.rec);
      if (a2) linkedRecs.add(B.rec);
    }
  }

  // 4. Stats + kind detection (drives which dashboard panels render).
  let hasStrength = false;
  let hasEndurance = false;
  let hasMeasurements = false;
  for (const rec of merged) {
    if (rec.recordType === "Measurement") { hasMeasurements = true; continue; }
    if (rec.recordType !== "Session") continue;
    const s = rec as AnyRec;
    const hasSets =
      (s.exercises?.length ?? 0) > 0 || (s.blocks?.length ?? 0) > 0;
    if (hasSets) hasStrength = true;
    else hasEndurance = true;
  }

  return {
    merged: merged as LiveRecord[],
    stats: {
      total: merged.length,
      exactCollapsed,
      linked: linkedRecs.size,
      sources: enabled.length,
      perSource: [...perSource.values()],
      hasStrength,
      hasEndurance,
      hasMeasurements,
    },
  };
}
