// Client-side FIT decoding for /tools/convert/. FIT is the hard source: a *binary* protocol
// (Garmin/Wahoo/Zwift device exports), unlike every other source which is CSV/XML/JSON text.
//
// Design (deliberate, mirrors the FIT mapping guide):
// - openbody-ts's `mapFit` never decodes the binary itself — it takes the *decoded* message
//   lists (`fit-file-parser`'s `mode: "list"` shape) and does the FIT → OpenBody semantic
//   translation. So this module owns exactly the bytes-to-messages step openbody-ts leaves to
//   the caller, then adapts the parser's output to `FitInput` and hands it to `mapFit`.
// - Decoder: `fit-file-parser` (MIT). Garmin's official `@garmin/fitsdk` is NOT used — its
//   license forbids redistribution, so it can't be bundled into a shipped web page.
// - `fit-file-parser` reads strings from the binary via the `buffer` npm package
//   (`import { Buffer } from "buffer"`); that package is a browser Buffer polyfill and is what
//   lands in the client bundle (see astro.config.mjs `optimizeDeps.include` + the alias note).
//   Everything here runs in the browser — nothing is uploaded.
import FitParser from "fit-file-parser";
import type { FitInput } from "@openbody/openbody-ts";

/**
 * Binary FIT detection. The other sources are sniffed from text; FIT can't be — it's binary.
 * A FIT file's 12- or 14-byte header carries the ASCII data-type ".FIT" at bytes 8–11
 * (0x2E 0x46 0x49 0x54), with the header size in byte 0 (12 legacy, 14 with a header CRC).
 * That magic is the authoritative signal; the `.fit` extension is a cheap pre-gate the caller
 * uses to decide whether to read these bytes at all.
 */
export function looksLikeFitHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const headerSize = bytes[0];
  if (headerSize !== 12 && headerSize !== 14) return false;
  return (
    bytes[8] === 0x2e && // "."
    bytes[9] === 0x46 && // "F"
    bytes[10] === 0x49 && // "I"
    bytes[11] === 0x54 // "T"
  );
}

// `fit-file-parser` emits FIT date fields as JS `Date` objects, but `FitInput`'s decoded shape
// (and therefore `mapFit`'s output) is string-typed ISO instants. Convert on the way in so the
// mapped records carry ISO-string `startTime`/`endTime` (which is what validates + serializes).
const toIso = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
function isoize<T extends Record<string, unknown>>(obj: T, keys: string[]): T {
  const out = { ...obj };
  for (const k of keys) if (k in out) (out as Record<string, unknown>)[k] = toIso(out[k]);
  return out;
}

/**
 * Decode a `.fit` binary and adapt the parser's `mode: "list"` output to `mapFit`'s `FitInput`.
 * `fit-file-parser`'s list output already hoists `sessions`/`laps`/`records` as arrays; the
 * date fields are `Date` objects, normalized to ISO strings here. Structured-workout messages
 * (`workout`/`workout_step`) are passed through best-effort — see the note below.
 */
export async function decodeFitToInput(buffer: ArrayBuffer): Promise<FitInput> {
  // `force: true` keeps the decode going past a bad/partial message instead of aborting the
  // whole file — a real device export occasionally carries a truncated trailing record.
  const parser = new FitParser({ mode: "list", force: true });
  // `ParsedFit` types the known message arrays; we read them structurally (and reach a couple
  // of loosely-typed keys like `workout`), so widen to an index signature via `unknown`.
  const parsed = (await parser.parseAsync(buffer)) as unknown as Record<string, unknown>;

  const input: FitInput = {};
  if (Array.isArray(parsed.sessions)) {
    input.sessions = parsed.sessions.map((s) => isoize(s, ["start_time", "timestamp"])) as FitInput["sessions"];
  }
  if (Array.isArray(parsed.laps)) {
    input.laps = parsed.laps.map((l) => isoize(l, ["start_time", "timestamp"])) as FitInput["laps"];
  }
  if (Array.isArray(parsed.records)) {
    input.records = parsed.records.map((r) => isoize(r, ["timestamp"])) as FitInput["records"];
  }
  // Structured-workout (.fit workout definition) support is best-effort: fit-file-parser 3.x
  // has no dedicated case for `workout`/`workout_step` messages, so its list mode leaves them
  // as single (last-wins) objects under `parsed.workout` / `parsed.workout_step` rather than
  // arrays. Recorded ACTIVITY files (the common device export — sessions/laps/records) are the
  // supported path and decode cleanly; multi-step workout *definitions* aren't fully recoverable
  // from this decoder and would need one that arrays those messages.
  if (parsed.workout && typeof parsed.workout === "object") {
    input.workouts = [parsed.workout] as FitInput["workouts"];
  }
  if (parsed.workout_step) {
    input.workout_steps = ([] as unknown[]).concat(parsed.workout_step) as FitInput["workout_steps"];
  }
  return input;
}
