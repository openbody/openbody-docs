# Deploying the OpenBody docs

The site is a static Astro + Starlight build deployed to **Cloudflare Pages**, intended for
the apex domain **`openbody.dev`** (the domain is already on Cloudflare).

This repo ships a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds the
site and deploys it on every push to `main`. **None of the Cloudflare project or DNS is
created by this repo** — the steps below are manual, one-time, and must be done by the
author/owner.

## The deploy model (read this first — it explains every step below)

This site is built from **two repositories**:

- **`openbody-docs`** — this repo (the site).
- **`openbody`** — the canonical standard. At build time `scripts/sync-spec.mjs` copies
  `SPEC.md`, `CHANGELOG.md`, the JSON Schema, and the conformance README out of it (single
  source of truth — this repo never holds a hand-edited fork). Override its location with
  `OPENBODY_STANDARD`.

**Therefore whatever runs `npm run build` must have *both* repos available.** That one fact
decides the architecture:

> ⚠️ **Do NOT use Cloudflare's "Connect to Git" build.** Cloudflare Pages' Git integration
> clones exactly **one** repo into its build container — there is no "second repo" option. So
> `npm run build` would run without `../openbody`, and the sync step would fail.
>
> **We build in GitHub Actions and have Cloudflare only *host* the result.** The workflow
> checks out both repos (`actions/checkout` twice), runs the build, then uses Wrangler to
> upload the finished `dist/` to a Cloudflare Pages **Direct Upload** project. The only
> credential for the private `openbody` repo (`STANDARD_REPO_TOKEN`) stays in GitHub secrets.

*Alternatives considered and rejected:* (a) cloning `openbody` inside Cloudflare's own build
command — works, but copies a GitHub token into Cloudflare's env (a second place to hold and
rotate a credential); (b) committing a generated spec snapshot into this repo so a one-repo
build suffices — works, but puts a generated fork of the spec in git, against the
single-source design. Use one of these only if you deliberately want a Cloudflare-native or
standalone build; the default path is GitHub Actions.

## 1. Create the GitHub repository — DONE

The repo exists and `main` is pushed: **`openbody/openbody-docs`** (private). Nothing more to
do here. (For reference, it was created with `gh repo create openbody/openbody-docs --private`
and `git push -u origin main`.)

## 2. Create the Cloudflare Pages project — **automatic**

You don't need to create the project by hand. The workflow's **"Ensure Cloudflare Pages
project exists"** step creates a Direct Upload project named `openbody-docs`
(`--production-branch=main`) on its first run if it's missing, and skips creation on later
runs. Just make sure the three secrets in step 4 are set before you trigger it.

- The project **must** be Direct Upload (which is what the workflow creates). Do **not**
  create it via the dashboard's **"Connect to Git"** flow — see the deploy model above for
  why a Cloudflare-side Git build can't work here.
- If you'd rather create it manually anyway: Cloudflare dashboard → **Workers & Pages →
  Create → Pages → "Upload assets"**, name it exactly `openbody-docs`, and drag in any
  throwaway folder to finish. The real content still comes from the workflow. Don't set a
  build command/output dir on the Cloudflare side — all build settings live in the workflow.

Do steps 4 (secrets) and 5 (trigger), then 3 (domain).

## 3. Add the custom domain (manual)

In the Pages project → **Custom domains → Set up a custom domain**:

- Add **`openbody.dev`** (apex). Cloudflare will add the required `CNAME`/flattened record
  automatically because the zone is already on Cloudflare.
- (Optional) add `www.openbody.dev` and redirect it to the apex.
- Confirm TLS is active (Cloudflare provisions the certificate).

The site is configured with `site: "https://openbody.dev"` in `astro.config.mjs` (sitemap,
canonical URLs). If you deploy to a different host, update that value.

## 4. Configure GitHub Actions secrets (manual) — **all three required**

The workflow (`.github/workflows/deploy.yml`) needs all three of these. Add them in the docs
repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | What | Where to get it |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with the **Account › Cloudflare Pages › Edit** permission. | Cloudflare → My Profile → API Tokens → Create Token. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID. | Cloudflare → Workers & Pages (right sidebar), or any zone's Overview. |
| `STANDARD_REPO_TOKEN` | Read access to the **private** `openbody/openbody`, so the build can clone the canonical spec. A fine-grained PAT scoped to that one repo, **Contents: Read**, is enough. | GitHub → Settings → Developer settings → Personal access tokens → Fine-grained. |

> Once `openbody/openbody` is public, `STANDARD_REPO_TOKEN` is no longer needed — drop the
> `token:` line from the "Checkout openbody standard" step in the workflow.

## 5. Trigger & verify

- **Trigger:** push any commit to `main`, or run it manually — Actions tab → **Deploy docs to
  Cloudflare Pages** → **Run workflow**.
- Watch the workflow succeed (it checks out both repos, builds, and uploads `dist/` to the
  Pages project).
- Visit the Pages `*.pages.dev` URL, then `https://openbody.dev` once DNS/TLS is live (step 3).
- Spot-check the **Specification** page renders the synced `SPEC.md` with the "Generated from
  the canonical source" banner, and that `/schema/openbody.schema.json` downloads.

## Auto-rebuild on spec changes

The site re-syncs the canonical spec **only when this repo builds**. So an edit to `SPEC.md`
in `openbody/openbody` won't reach the live site on its own. Two mechanisms keep it fresh:

1. **Daily schedule (already on, zero setup).** The deploy workflow has a `schedule:` cron
   (06:17 UTC) that rebuilds and redeploys, picking up any spec change within ~24 h. A day
   with no change just re-uploads identical bytes — harmless for a static site.

2. **Instant trigger (optional — needs a workflow in `openbody/openbody`).** The deploy
   workflow also listens for a `spec-updated` `repository_dispatch`. To fire it the moment the
   spec changes, add this workflow to the **`openbody/openbody`** repo:

   ```yaml
   # openbody/openbody/.github/workflows/notify-docs.yml
   name: Notify docs of spec change
   on:
     push:
       branches: [main]
       paths: ["SPEC.md", "CHANGELOG.md", "schema/**", "conformance/README.md"]
   jobs:
     notify:
       runs-on: ubuntu-latest
       steps:
         - name: Dispatch docs rebuild
           env:
             GH_TOKEN: ${{ secrets.DOCS_DISPATCH_TOKEN }}
           run: gh api -X POST repos/openbody/openbody-docs/dispatches -f event_type=spec-updated
   ```

   Then add a secret **`DOCS_DISPATCH_TOKEN`** to `openbody/openbody` → a fine-grained PAT
   scoped to **`openbody/openbody-docs`** with **Contents: Read and write** (the permission
   the `dispatches` endpoint requires). The docs deploy runs within a minute of a spec merge.

   Until this is added, the daily schedule is the fallback — nothing breaks without it.

## Local build

```bash
npm install
npm run dev      # sync + dev server (expects ../openbody as a sibling checkout)
npm run build    # sync + static build into dist/
```

Override the canonical-spec location with `OPENBODY_STANDARD=/path/to/openbody`.
