// Pure, DOM-free text-ingest logic for /tools/convert/ — the CPU-heavy parse step, factored
// out so it can run in EITHER a Web Worker (src/scripts/convert-worker.ts, the default so a
// large Apple Health export.xml never freezes the tab — OB-97) OR, as a fallback, on the main
// thread (if the worker can't be created). One source of truth, no `document`/`window` here.
//
// It owns exactly the decision the convert tool used to inline: is this uploaded text an
// OpenBody JSON re-import, a recognized app export, or unrecognized — and, for an app export,
// the mapper call itself. FIT (binary) and Fitbit (many-files→one-call) are NOT handled here;
// they stay on their own paths in the page script.
import {
  mapHevy,
  mapHevyMeasurements,
  mapStrong,
  mapAppleHealth,
  mapGpx,
  mapTcx,
  mapConcept2,
  mapTheCrag,
  MapperInputError,
  validate,
  parseLossless,
  type MapOptions,
  type MapWarning,
} from "@openbody/openbody-ts";
import { toPlainNumbers } from "./merge";
import { detectSource, mapStravaActivitiesCsv, type SourceId } from "./convert-sources";

/**
 * Route one app export's raw text to its openbody-ts mapper. FIT and Fitbit are handled on
 * their own paths (binary decode / many-files batch) and throw here so the exhaustive switch
 * stays total — this function only ever runs for the text sources.
 */
export function mapForSource(
  source: SourceId,
  text: string,
  opts: MapOptions,
): { records: any[]; warnings: MapWarning[] } {
  switch (source) {
    case "hevy": return mapHevy(text, opts);
    // Hevy's body-measurement export → point-in-time Measurement records (no sessions).
    case "hevy-measurements": return mapHevyMeasurements(text, opts);
    case "strong": return mapStrong(text, opts);
    case "apple-health": return mapAppleHealth(text, opts);
    // mapStravaActivitiesCsv is a docs-only adapter (fans out per-row mapStrava calls),
    // not one of the package's mappers — it already returns a plain record array.
    case "strava": return { records: mapStravaActivitiesCsv(text, opts.subject), warnings: [] };
    // GPX/TCX (XML tracks) + Concept2/theCrag (CSV): each mapper already consumes the raw
    // export text and returns { records, warnings }, so no adapter — just pass it through
    // with the shared subject option, exactly like the Hevy/Strong/Apple Health mappers.
    case "gpx": return mapGpx(text, opts);
    case "tcx": return mapTcx(text, opts);
    case "concept2": return mapConcept2(text, opts);
    case "thecrag": return mapTheCrag(text, opts);
    // Fitbit is many-files→one-call: it's batched in the page script (ingestFitbitBatch) and
    // never routed through this per-file path. Guard so the exhaustive switch stays total.
    case "fitbit":
      throw new MapperInputError(
        "fitbit", "Fitbit Takeout is mapped as a batch of files, not one file at a time",
      );
    // FIT is binary: decoded + mapped on its own path (ingestFitFile), never routed through
    // this text mapper. Guard so the exhaustive switch stays total.
    case "fit":
      throw new MapperInputError(
        "fit", "FIT is a binary source, decoded and mapped on its own path, not as text",
      );
  }
}

/** Recognize an OpenBody document: a JSON array whose items carry a `recordType`. */
export function looksLikeOpenBody(fileName: string, text: string): any[] | null {
  if (!/\.json$/i.test(fileName) && !text.trimStart().startsWith("[")) return null;
  let parsed: unknown;
  try {
    // parseLossless is robust (RFC-strict, __proto__-safe); toPlainNumbers coerces its
    // LosslessNumber values to plain JS numbers so records validate, dedup and export.
    parsed = toPlainNumbers(parseLossless(text));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const looksRecord = parsed.some(
    (r) => r && typeof r === "object" && typeof (r as any).recordType === "string",
  );
  return looksRecord ? (parsed as any[]) : null;
}

// --- the unified text-ingest step (worker- AND main-thread-callable) ------------------------

export interface MapTextRequest {
  fileName: string;
  text: string;
  subject?: string;
}

/**
 * A discriminated description of what one uploaded text file mapped to. Deliberately plain
 * data (no DOM, no Error instances) so it survives `postMessage` structured-clone back from
 * the worker. The page script turns this into a layer + a user-facing status message.
 */
export type MapTextResult =
  | { kind: "openbody"; valid: any[]; invalidCount: number; firstReason?: string }
  | { kind: "source"; source: SourceId; records: any[]; warnings: MapWarning[] }
  | { kind: "unrecognized" }
  | { kind: "error"; message: string; isMapperInputError: boolean };

/**
 * The heavy step: classify + map one uploaded text file. This is what runs off the main
 * thread. Never throws — a mapper failure is returned as a `{ kind: "error" }` result so the
 * caller (worker or fallback) handles both transports identically.
 */
export function mapTextFile(req: MapTextRequest): MapTextResult {
  const { fileName, text, subject } = req;

  // OpenBody JSON re-import (the round-trip path): validate each record; surface — never
  // silently drop — any that fail. Subject is re-stamped so cross-source dedup can match.
  const obRecords = looksLikeOpenBody(fileName, text);
  if (obRecords) {
    const valid: any[] = [];
    let invalidCount = 0;
    let firstReason: string | undefined;
    for (const r of obRecords) {
      const v = validate(r);
      if (v.valid) valid.push(r);
      else {
        invalidCount++;
        if (firstReason === undefined && v.errors) firstReason = v.errors;
      }
    }
    if (subject) for (const r of valid) r.subject = subject;
    return { kind: "openbody", valid, invalidCount, firstReason };
  }

  // App export path.
  const source = detectSource(fileName, text);
  if (!source) return { kind: "unrecognized" };
  try {
    const { records, warnings } = mapForSource(source, text, { subject });
    return { kind: "source", source, records, warnings };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      isMapperInputError: err instanceof MapperInputError,
    };
  }
}
