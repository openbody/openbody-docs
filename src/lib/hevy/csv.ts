// VENDORED, browser-safe copy of openbody-ts's `src/mappers/csv.ts` (Apache-2.0), used by
// the client-side "convert your data" tool (see /tools/convert/).
//
// Why a copy instead of importing `@openbody/openbody-ts` directly: this repo *does* declare
// openbody-ts as a dependency (see package.json — currently pointed at the local sibling
// checkout via `file:../openbody-ts`, since the real package is unpublished and its GitHub
// repo is private; see README.md "Convert tool" section for the full story). But the
// package's only export ("."; see its `exports` field) re-exports `validate`/`standardDir`
// from `src/validate.ts`, which imports `node:fs`, `node:path`, and `node:url` at the top of
// the module. That's fine for Node-side use, but it makes the package **unsafe to import from
// browser-bundled code**: we tried it (`import { mapHevy } from "@openbody/openbody-ts"` in a
// client `<script>`), and the production build hard-fails —
//
//   "fileURLToPath" is not exported by "__vite-browser-external", imported by
//   ".../openbody-ts/dist/validate.js"
//
// — because Vite/Rollup externalizes Node builtins for the browser target rather than
// polyfilling them, and `validate.ts` uses a *named* import (`fileURLToPath`) that the
// externalized shim can't provide. `sideEffects: false` in the package's package.json isn't
// enough to save it: Rollup still has to resolve every import in the module graph before it
// can tree-shake, and that resolution step is what fails.
//
// TODO(openbody-ts): once the package exposes a browser-safe subpath export for just the
// mappers (e.g. an `"./mappers"` export that doesn't pull in `validate.ts`), or splits
// `validate` into its own entry point, delete this vendored copy and import `mapHevy` /
// `parseCsv` from the real package instead. Keep this file byte-for-byte close to
// `openbody-ts/src/mappers/csv.ts` in the meantime so the two don't drift silently.

/** Minimal quoted-CSV parser (handles quoted fields, embedded commas, "" escapes, CRLF/LF). */
export function parseCsv(text: string, delim = ","): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (cell !== "" || row.length) {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      }
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export const num = (s: string | undefined): number | undefined =>
  s == null || s === "" ? undefined : Number(s);

/** Best-effort RFC 3339 from a free-form date string (assumes UTC when no offset). */
export function toRfc3339(s: string): string {
  const d = new Date(s.replace(",", ""));
  return isNaN(d.getTime()) ? s : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type OpenBodyRecord = Record<string, any>;
export interface MapOptions {
  subject?: string;
}
