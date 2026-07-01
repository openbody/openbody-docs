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

2. **Instant trigger (already wired — needs one secret).** The deploy workflow also listens
   for a `spec-updated` `repository_dispatch`, and the sender that fires it already lives in
   the spec repo: **`openbody/openbody/.github/workflows/notify-docs.yml`**. It POSTs the
   dispatch whenever `SPEC.md` / `CHANGELOG.md` / `schema/**` / `conformance/README.md` change
   on `main` (or when run manually). The only thing left is the token it authenticates with.

   **Set up `DOCS_DISPATCH_TOKEN`** (a one-time step, done in the **`openbody/openbody`** repo):

   1. GitHub → your avatar → **Settings → Developer settings → Personal access tokens →
      Fine-grained tokens → Generate new token**.
   2. **Resource owner:** the `openbody` org. **Repository access:** *Only select
      repositories* → **`openbody/openbody-docs`**.
   3. **Repository permissions:** **Contents → Read and write** (this is what the
      `POST /repos/{owner}/{repo}/dispatches` endpoint requires). Leave everything else at *No
      access*.
   4. Generate, copy the token.
   5. In **`openbody/openbody`** → **Settings → Secrets and variables → Actions → New
      repository secret**: name **`DOCS_DISPATCH_TOKEN`**, paste the token.

   Verify: `openbody/openbody` → Actions → **notify-docs** → **Run workflow**; it should
   succeed and kick off a **Deploy docs to Cloudflare Pages** run in `openbody-docs` within a
   minute. Until the secret is set, `notify-docs` errors on that step — harmless, and the daily
   schedule still keeps the site fresh.

## When `openbody/openbody` goes public — token cleanup

> Part of the project-wide **[`GO-PUBLIC.md`](https://github.com/openbody/openbody/blob/main/GO-PUBLIC.md)**
> checklist (standard repo). This section is the docs/CI slice of it.

Two CI secrets exist **only** to grant read access to the currently-private
`openbody/openbody`. When that repo becomes public, retire them:

- [ ] **`openbody-docs`** → `STANDARD_REPO_TOKEN`. The deploy workflow's *Checkout openbody
      standard* step hard-codes `token: ${{ secrets.STANDARD_REPO_TOKEN }}`, so this needs a
      **code change**: delete the `token:` line (a public repo checks out with no token), then
      delete the repo secret.
- [ ] **`openbody-ts`** → `STANDARD_REPO_TOKEN`. Its `conformance.yml` already falls back
      (`token: ${{ secrets.STANDARD_REPO_TOKEN || github.token }}`), so **just delete the repo
      secret** — the fallback handles a public repo automatically. No code change required.

**Do _not_ remove `DOCS_DISPATCH_TOKEN`** (in `openbody/openbody`). It is **permanent** infra,
unrelated to visibility: a cross-repo `repository_dispatch` always needs a PAT because the
default `GITHUB_TOKEN` cannot trigger events in another repository, public or not.

> A tracking issue mirrors this checklist so it resurfaces at go-public time —
> `openbody/openbody-docs` issues, labelled `go-public`.

## Local build

```bash
npm install
npm run dev      # sync + dev server (expects ../openbody as a sibling checkout)
npm run build    # sync + static build into dist/
```

Override the canonical-spec location with `OPENBODY_STANDARD=/path/to/openbody`.
