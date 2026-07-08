# openbody-docs

The documentation website for the **[OpenBody™](https://openbody.dev) standard** — an open,
vendor-neutral, language-agnostic standard for health & fitness data interoperability.
Built with **[Astro](https://astro.build) + [Starlight](https://starlight.astro.build)**.

> Status: the standard is a **public pre-v1.0 draft**. This docs site reflects
> that — it does not claim broad adoption or a frozen standard. The exact spec version is
> rendered from the synced `SPEC.md` (see `scripts/sync-spec.mjs`), never hardcoded here.

## Single-sourced spec

This repo **never holds a hand-edited fork of the standard.** At build time,
`scripts/sync-spec.mjs` copies the canonical artifacts from the standard repository
(`../openbody`, override with `OPENBODY_STANDARD`) into generated content, each wrapped with
a "Generated from the canonical source" banner and a link back:

| Canonical source | Rendered at |
|---|---|
| `SPEC.md` | `/specification/spec/` |
| `CHANGELOG.md` | `/specification/changelog/` |
| `conformance/README.md` | `/conformance/conformance-readme/` |
| `schema/openbody.schema.json` | `/schema/openbody.schema.json` (download) + `/specification/schema/` |

The generated files are **gitignored** — they are produced fresh on every `dev`/`build`.

## Convert tool (`/tools/convert/`)

`src/pages/tools/convert.astro` is a custom Astro page (outside the `docs` content
collection — it needs real interactivity: file upload, in-browser CSV parsing, a
client-side download) that lets a visitor upload a **Hevy CSV export** and see it parsed
into portable OpenBody JSON, entirely client-side. No file is ever sent to a server.

**The `openbody-ts` wrinkle.** The parsing logic is "the OpenBody mapping logic" —
`mapHevy()` from [`openbody-ts`](https://github.com/openbody/openbody-ts), imported
directly (`import { mapHevy } from "@openbody/openbody-ts"` in `convert.astro`'s client
script) — no vendored copy. Originally this didn't work, for two independent reasons; one
is now fixed upstream, one remains open:

1. ~~It isn't safe to import into browser-bundled code as-is~~ **Fixed.** `openbody-ts`'s
   `src/validate.ts` used to `fs.readFileSync` the schema at module top level, so importing
   the package's main entry pulled `node:fs`/`node:path`/`node:url` into the module graph
   and broke the production Vite/Rollup client build. It now statically imports the vendored
   schema JSON instead (zero Node built-ins); the `OPENBODY_STANDARD` dev-override logic
   moved to a separate, Node-only `schema-loader-node.ts` that isn't re-exported from the
   package's public entry. Verified here: `astro check` (0 errors) and `astro build`
   succeed, and the built client bundle for `/tools/convert/` contains the real `mapHevy`
   logic (`dist/_astro/convert.astro_astro_type_script_index_0_lang.*.js`).
2. **Still open: it isn't published to npm, and its GitHub repo is currently private.** The
   intended, "real" dependency is `github:openbody/openbody-ts` — but that fails to install
   for anyone without collaborator access while the repo stays private. `package.json`
   **currently** pins `@openbody/openbody-ts` to `file:../openbody-ts` instead — a relative
   path to the sibling checkout — purely so `npm install` succeeds in local dev on a machine
   laid out like this one (`openbody-docs/` next to `openbody-ts/`). **This is a stopgap,
   not the intended shipped state**: swap it back to `github:openbody/openbody-ts` once that
   repo is public, or to a real npm version once the package is published.

**Status:**
- **Production deploy.** The CI workflow (`.github/workflows/deploy.yml`) has a second
  checkout step for `openbody-ts`, reusing the same `STANDARD_REPO_TOKEN` secret already
  used for `../openbody` (see `DEPLOY.md`) — its fine-grained PAT's repo access list now
  covers both `openbody/openbody` and `openbody/openbody-ts`, one credential for both
  private checkouts this workflow needs. Once `openbody-ts` is published to npm / made
  public, this second checkout step (and eventually `STANDARD_REPO_TOKEN` itself, per
  `DEPLOY.md`'s existing go-public checklist) can be retired.
- **Email capture backend is a stub.** After a successful conversion the tool shows an
  optional "want to know when more apps are supported?" prompt. It POSTs to
  `/api/subscribe`, which does not exist — this is a static site with no Worker / Pages
  Function / KV / D1 wired up yet. The failure is surfaced honestly in the UI (see the
  `TODO(backend)` comment in `convert.astro`) rather than faking a success state.

## Develop

```bash
npm install
npm run dev      # runs the spec sync, then starts the dev server (needs ../openbody)
npm run build    # runs the spec sync, then a static build into dist/
npm run check    # astro check (types + content)
npm run sync     # just the spec-sync step
```

The site expects the canonical [`openbody`](https://github.com/openbody/openbody) repo as a
sibling checkout (`../openbody`). Point elsewhere with `OPENBODY_STANDARD=/path/to/openbody`.

`npm install` also expects a sibling checkout of
[`openbody-ts`](https://github.com/openbody/openbody-ts) at `../openbody-ts` — see "Convert
tool" above for why, and why that will not work for a fresh clone without that sibling repo
or private-repo access.

## Structure

```
src/
  content/docs/        # pages (.mdx authored here; spec/*.md + conformance-readme.md are generated)
    index.mdx          # landing
    getting-started/   # install, validate, run vectors
    concepts/          # data model, pillars, exercise identity, canonicalization
    specification/     # overview, synced SPEC.md, JSON Schema, changelog
    mapping/           # Hevy / Strong / Strava / Apple Health guides
    conformance/       # profiles + synced conformance README
    registry/          # the exercise registry
    governance/        # governance & contributing
    licensing/         # the three-license model
  pages/tools/convert.astro  # the "convert your data" demo tool (see above)
  lib/hevy/             # vendored client-safe Hevy CSV parser/mapper + preview formatting
  assets/              # logo mark
  styles/custom.css    # minimal, technical styling
  generated/           # (gitignored) spec-meta.json + schema, produced by sync
scripts/sync-spec.mjs  # the build-time spec sync
.github/workflows/     # Cloudflare Pages deploy
```

## Deploy

Static build → **Cloudflare Pages**, apex domain **openbody.dev**. See
[DEPLOY.md](./DEPLOY.md) for the one-time manual setup (GitHub repo, Pages project, DNS,
secrets).

## Licensing

This repo's **site code** (the Astro/TypeScript that builds openbody.dev) is licensed
**Apache-2.0** — see [`LICENSE`](./LICENSE). The mirrored **specification** content under
`src/content/docs/specification/` is generated from the canonical
[`openbody`](https://github.com/openbody/openbody) repo and remains **OWFa 1.0** as governed
there — this repo does not relicense it.

For context, the three-repo license model is: the OpenBody **specification** is **OWFa 1.0**;
**reference code** is **Apache-2.0**; **registry data** is **CC0**. This docs site's own prose
describes those artifacts; see [`/licensing/`](https://openbody.dev/licensing/). “OpenBody”
is a vendor-neutral standard stewarded by Thabit Labs.
