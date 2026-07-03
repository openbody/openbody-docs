// sync-spec.mjs — single-source the canonical standard.
//
// This docs repo MUST NOT hold a hand-edited fork of the spec. At build time we copy
// the normative artifacts from the canonical OpenBody repo (`../openbody`, override with
// OPENBODY_STANDARD) into generated content, each wrapped with a banner noting it is
// generated and a link back to the source of truth. The generated files are gitignored.
//
// Inputs (canonical repo):
//   SPEC.md, CHANGELOG.md, conformance/README.md, schema/openbody.schema.json
// Outputs (this repo, all gitignored):
//   src/content/docs/specification/spec.md
//   src/content/docs/specification/changelog.md
//   src/content/docs/conformance/conformance-readme.md
//   public/schema/openbody.schema.json     (downloadable)
//   src/generated/openbody.schema.json      (embeddable)
//   src/generated/spec-meta.json            (version etc., consumed by pages)

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const STANDARD = process.env.OPENBODY_STANDARD
  ? resolve(process.env.OPENBODY_STANDARD)
  : resolve(ROOT, "..", "openbody");

// The canonical source-of-truth URL, used in every "generated from" banner.
const SRC_REPO = "https://github.com/openbody/openbody";

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function read(rel) {
  const p = join(STANDARD, rel);
  if (!existsSync(p)) {
    console.error(`\n[sync-spec] MISSING canonical source: ${p}`);
    console.error(`[sync-spec] Set OPENBODY_STANDARD to the openbody/ checkout. Aborting.\n`);
    process.exit(1);
  }
  return readFileSync(p, "utf8");
}

/** Drop a single leading H1 (Starlight renders the frontmatter `title` as the page H1). */
function stripLeadingH1(md) {
  return md.replace(/^\s*#\s+.*\r?\n/, "");
}

/**
 * Rewrite relative Markdown links to the canonical GitHub blob URL. A source file like
 * conformance/README.md links siblings relatively (`[EQUIVALENCE.md](./EQUIVALENCE.md)`);
 * those paths don't exist on the docs site and 404. Resolve them against the source
 * file's directory in the canonical repo instead. Absolute URLs and #anchors pass through.
 */
function rewriteRelativeLinks(md, sourceFile) {
  const srcDir = dirname(sourceFile);
  return md.replace(/\]\((?!https?:\/\/|#|\/)([^)\s]+?\.md(?:#[^)\s]*)?)\)/g, (_, target) => {
    const [path, anchor = ""] = target.split(/(?=#)/);
    const resolved = join(srcDir, path).replace(/\\/g, "/").replace(/^\.\//, "");
    return `](${SRC_REPO}/blob/main/${resolved}${anchor})`;
  });
}

/** Escape YAML double-quoted scalar. */
function yamlStr(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function banner(sourceFile, extra = "") {
  return [
    ":::note[Generated from the canonical source]",
    `This page is generated verbatim from [\`${sourceFile}\`](${SRC_REPO}/blob/main/${sourceFile}) in the`,
    `canonical [OpenBody standard repository](${SRC_REPO}) at build time. **Do not edit it here** —`,
    `the docs site never holds a hand-edited fork of the standard. ${extra}`.trim(),
    ":::",
    "",
  ].join("\n");
}

function writeDoc(outFile, frontmatter, body) {
  ensureDir(outFile);
  const fm = ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), "---", ""].join("\n");
  writeFileSync(outFile, fm + body, "utf8");
  console.log(`[sync-spec] wrote ${outFile.replace(ROOT + "/", "")}`);
}

// ---- version detection -------------------------------------------------------
const specRaw = read("SPEC.md");
const versionMatch = specRaw.match(/Draft\s+v?(\d+\.\d+\.\d+)/i);
const SPEC_VERSION = versionMatch ? versionMatch[1] : "0.0.0";

// ---- 1. SPEC.md --------------------------------------------------------------
writeDoc(
  join(ROOT, "src/content/docs/specification/spec.md"),
  {
    title: yamlStr(`OpenBody Specification — v${SPEC_VERSION}`),
    description: yamlStr(
      "The normative OpenBody standard, rendered from the canonical SPEC.md. Draft, pre-v1.0.",
    ),
    tableOfContents: "{ minHeadingLevel: 2, maxHeadingLevel: 3 }",
  },
  banner("SPEC.md", "Section/heading anchors and the normative text mirror the source exactly.") +
    "\n" +
    rewriteRelativeLinks(stripLeadingH1(specRaw), "SPEC.md"),
);

// ---- 2. CHANGELOG.md ---------------------------------------------------------
writeDoc(
  join(ROOT, "src/content/docs/specification/changelog.md"),
  {
    title: yamlStr("Changelog"),
    description: yamlStr("Version history of the OpenBody standard (semantic versioning)."),
  },
  banner("CHANGELOG.md") + "\n" + rewriteRelativeLinks(stripLeadingH1(read("CHANGELOG.md")), "CHANGELOG.md"),
);

// ---- 3. conformance/README.md ------------------------------------------------
writeDoc(
  join(ROOT, "src/content/docs/conformance/conformance-readme.md"),
  {
    title: yamlStr("Conformance — reference README"),
    description: yamlStr("The canonical conformance README: profiles, vectors, and the corpus."),
  },
  banner("conformance/README.md") +
    "\n" +
    rewriteRelativeLinks(stripLeadingH1(read("conformance/README.md")), "conformance/README.md"),
);

// ---- 4. JSON Schema (copy for download + embed) ------------------------------
const schemaRel = "schema/openbody.schema.json";
const schemaSrc = join(STANDARD, schemaRel);
if (!existsSync(schemaSrc)) {
  console.error(`[sync-spec] MISSING ${schemaSrc}. Aborting.`);
  process.exit(1);
}
for (const dest of [
  join(ROOT, "public/schema/openbody.schema.json"),
  join(ROOT, "src/generated/openbody.schema.json"),
]) {
  ensureDir(dest);
  copyFileSync(schemaSrc, dest);
  console.log(`[sync-spec] copied schema → ${dest.replace(ROOT + "/", "")}`);
}

// ---- 5. spec-meta.json (consumed by pages) -----------------------------------
// Derive the schema's own identity from the copied schema, so pages never hardcode it
// (the schema `$id` is versioned on its own major.minor line — see VERSIONING.md §4).
const schemaJson = JSON.parse(readFileSync(schemaSrc, "utf8"));
const schemaId = schemaJson.$id ?? "";
const schemaVersion = schemaId.match(/schema\/v(\d+\.\d+)\//)?.[1] ?? null;

const metaFile = join(ROOT, "src/generated/spec-meta.json");
ensureDir(metaFile);
writeFileSync(
  metaFile,
  JSON.stringify(
    {
      specVersion: SPEC_VERSION,
      schemaId,
      schemaVersion,
      status: "draft",
      sourceRepo: SRC_REPO,
      syncedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(`[sync-spec] wrote ${metaFile.replace(ROOT + "/", "")} (spec v${SPEC_VERSION}, schema ${schemaId})`);
console.log(`[sync-spec] done. Canonical source: ${STANDARD}`);
