# openbody-docs

The documentation website for the **[OpenBody™](https://openbody.dev) standard** — an open,
vendor-neutral, language-agnostic standard for health & fitness data interoperability.
Built with **[Astro](https://astro.build) + [Starlight](https://starlight.astro.build)**.

> Status: the standard is a **pre-v1.0 draft (spec v0.3.1)**, in private review. This docs
> site reflects that — it does not claim broad adoption or a frozen standard.

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

The OpenBody **specification** is **OWFa 1.0**; **reference code** is **Apache-2.0**;
**registry data** is **CC0**. This docs site's own prose describes those artifacts; see
[`/licensing/`](https://openbody.dev/licensing/). “OpenBody” is a vendor-neutral standard
stewarded by Thabit Labs.
