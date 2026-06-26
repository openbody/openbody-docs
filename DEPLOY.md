# Deploying the OpenBody docs

The site is a static Astro + Starlight build deployed to **Cloudflare Pages**, intended for
the apex domain **`openbody.dev`** (the domain is already on Cloudflare).

This repo ships a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds the
site and deploys it on every push to `main`. **None of the Cloudflare project or DNS is
created by this repo** — the steps below are manual, one-time, and must be done by the
author/owner.

> The build single-sources the spec: `scripts/sync-spec.mjs` copies `SPEC.md`,
> `CHANGELOG.md`, the JSON Schema, and the conformance README from the **canonical
> `openbody/openbody` repo** at build time. CI checks that repo out as a sibling — so the
> deploy needs read access to it (see secrets below).

## 1. Create the GitHub repository (manual)

The docs live on a local branch only; nothing has been pushed.

1. Create a repo under the **`openbody` org**, e.g. `openbody/openbody-docs` (private until
   the public draft release).
2. Add the remote and push:
   ```bash
   cd ~/src/openbody/openbody-docs
   git remote add origin git@github.com:openbody/openbody-docs.git
   git push -u origin main
   ```

## 2. Create the Cloudflare Pages project (manual)

In the Cloudflare dashboard → **Workers & Pages → Create → Pages**:

- **Connect to Git** and select `openbody/openbody-docs` *(optional — the included GitHub
  Actions workflow can deploy via Wrangler instead; pick one path, see step 4).*
- **Project name:** `openbody-docs` (must match `--project-name` in the workflow).
- **Production branch:** `main`.
- **Framework preset:** Astro.
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Node version:** 20 (set `NODE_VERSION=20` in the project's environment variables if the
  default is older).

> ⚠️ **Cross-repo spec sync.** If you let Cloudflare's own Git integration build the site, the
> Cloudflare build container will **not** have the sibling `openbody/openbody` checkout, so
> `npm run build` (which runs `sync-spec.mjs`) will fail. Two options:
> - **Recommended:** deploy via the **GitHub Actions workflow** in this repo (step 4), which
>   checks out both repos. Leave the Cloudflare project as a direct-upload (Wrangler) target
>   and do **not** enable its automatic Git builds.
> - Or vendor the standard into this repo (e.g. a git submodule at `../openbody` or a
>   committed snapshot) so a standalone build can find it — at the cost of a second source of
>   truth to keep synced.

## 3. Add the custom domain (manual)

In the Pages project → **Custom domains → Set up a custom domain**:

- Add **`openbody.dev`** (apex). Cloudflare will add the required `CNAME`/flattened record
  automatically because the zone is already on Cloudflare.
- (Optional) add `www.openbody.dev` and redirect it to the apex.
- Confirm TLS is active (Cloudflare provisions the certificate).

The site is configured with `site: "https://openbody.dev"` in `astro.config.mjs` (sitemap,
canonical URLs). If you deploy to a different host, update that value.

## 4. Configure GitHub Actions secrets/variables (manual)

For the included workflow (`.github/workflows/deploy.yml`), add these in the docs repo →
**Settings → Secrets and variables → Actions**:

| Secret | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with the **Account › Cloudflare Pages › Edit** permission. |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID. |
| `STANDARD_REPO_TOKEN` | A token (fine-grained PAT or GitHub App token) with **read** access to `openbody/openbody`, used to check out the canonical spec during the build. Not needed once that repo is public — you can switch to the default `GITHUB_TOKEN`/no token then. |

If you prefer Cloudflare's native Git builds over Actions, you don't need the Cloudflare
secrets — but read the cross-repo caveat in step 2.

## 5. Verify

- Push to `main`, watch the **Deploy docs to Cloudflare Pages** workflow succeed.
- Visit the Pages `*.pages.dev` preview URL, then `https://openbody.dev` once DNS/TLS is live.
- Spot-check the **Specification** page renders the synced `SPEC.md` with the "Generated from
  the canonical source" banner, and that `/schema/openbody.schema.json` downloads.

## Local build

```bash
npm install
npm run dev      # sync + dev server (expects ../openbody as a sibling checkout)
npm run build    # sync + static build into dist/
```

Override the canonical-spec location with `OPENBODY_STANDARD=/path/to/openbody`.
