// Turns raw OpenBody wire records (as produced by `mapHevy`) into a small, presentation-only
// shape for the human-readable preview on /tools/convert/. Not part of the OpenBody data
// model itself — just a view over it.
import type { Exercise, LiveRecord, ScalarOrTargetWithRamp } from "@openbody/openbody-ts";

export interface SetSummary {
  index: number;
  role?: string;
  reps?: number;
  loadValue?: number;
  loadUnit?: string;
  loadBasis?: string;
  distanceKm?: number;
  seconds?: number;
  rpe?: number;
}

export interface ExerciseSummary {
  name: string;
  supersetGroup?: string;
  sets: SetSummary[];
}

export interface SessionSummary {
  id: string;
  name: string;
  dateLabel: string;
  exercises: ExerciseSummary[];
}

/**
 * Read a plain-number ScalarOrTarget/ScalarOrTargetWithRamp field. The other variants
 * (range/relativeToThreshold/stopCondition/ramp) describe prescriptions/targets, not a
 * performed value, so they're deliberately not unwrapped here — mapHevy only ever emits
 * performed reps/time/load as bare numbers.
 */
function numberOf(v: ScalarOrTargetWithRamp | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Same idea for performed distance, which mapHevy emits as `{ absolute: { value, unit } }`. */
function absoluteOf(v: ScalarOrTargetWithRamp | undefined): { value: number; unit?: string } | undefined {
  if (v && typeof v === "object" && "absolute" in v && typeof v.absolute.value === "number") {
    return { value: v.absolute.value, unit: v.absolute.unit };
  }
  return undefined;
}

function exerciseSummary(ex: Exercise): ExerciseSummary {
  const ref = ex.exerciseRef;
  const opaque = typeof ref === "string" ? undefined : ref?.opaque;
  // Bug fix: this read `.registryId`, a field the wire format has never had (the canonical
  // registry id lives on `.id`) — resolved refs always fell through to "Unknown exercise".
  const id = typeof ref === "string" ? ref : ref?.id;
  const name = opaque ?? id ?? "Unknown exercise";
  const sets: SetSummary[] = (ex.workUnits ?? []).map((wu, i) => {
    const p = wu.performance ?? {};
    const distance = absoluteOf(p.distance);
    return {
      index: i + 1,
      role: wu.setRole,
      reps: numberOf(p.reps),
      loadValue: numberOf(p.load?.value),
      loadUnit: p.load?.unit,
      loadBasis: p.load?.basis,
      distanceKm: distance?.value,
      seconds: numberOf(p.time),
      rpe: p.effortLoad?.[0]?.value,
    };
  });
  return { name, sets };
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Flatten a session's `exercises` (or `blocks[].children`, for supersets) into one list. */
export function summarizeSessions(records: LiveRecord[]): SessionSummary[] {
  return records
    .filter((r) => r.recordType === "Session")
    .map((session) => {
      const exercises: ExerciseSummary[] = [];
      if (Array.isArray(session.exercises)) {
        for (const ex of session.exercises) exercises.push(exerciseSummary(ex));
      } else if (Array.isArray(session.blocks)) {
        for (const block of session.blocks) {
          const isSuperset = block.grouping === "superset";
          for (const child of block.children ?? []) {
            if (child.recordType !== "Exercise") continue;
            const summary = exerciseSummary(child);
            if (isSuperset) summary.supersetGroup = block.id;
            exercises.push(summary);
          }
        }
      }
      return {
        id: session.id ?? "",
        name: session.name || "Untitled workout",
        dateLabel: dateLabel(session.startTime ?? ""),
        exercises,
      };
    });
}

const SET_ROLE_LABEL: Record<string, string> = {
  warmup: "warmup",
  drop: "drop set",
  failure: "to failure",
};

/** e.g. "10 reps × 21 kg (assist) · RPE 8.5" — used for each set line in the preview. */
export function formatSetLine(set: SetSummary): string {
  const parts: string[] = [];
  if (set.reps != null) parts.push(`${set.reps} reps`);
  if (set.loadValue != null) {
    const basis = set.loadBasis === "assist" ? " (assist)" : "";
    parts.push(`${set.loadValue} ${set.loadUnit ?? "kg"}${basis}`);
  }
  if (set.distanceKm != null) parts.push(`${set.distanceKm} km`);
  if (set.seconds != null) parts.push(`${set.seconds}s`);
  if (parts.length === 0) parts.push("(no logged performance)");
  const line = parts.join(" × ");
  const tags: string[] = [];
  if (set.role && SET_ROLE_LABEL[set.role]) tags.push(SET_ROLE_LABEL[set.role]);
  if (set.rpe != null) tags.push(`RPE ${set.rpe}`);
  return tags.length ? `${line} · ${tags.join(" · ")}` : line;
}
