# CI/CD & Deployment

This document records how Baboo builds, tests, and ships the web app, and the
choices behind it. (Issue BAB-4.)

## CI — GitHub Actions

Workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

Runs on every push to `main` and every pull request targeting `main`:

1. `npm ci` — install from the lockfile
2. `npm run lint` — ESLint (Next.js core-web-vitals + TS rules)
3. `npm run build` — production Next.js build (also type-checks)
4. `npm test` — Vitest unit/smoke tests

Node version is pinned via [`.nvmrc`](.nvmrc) (Node 24) and consumed by both the
workflow and local dev. Concurrency is capped so superseded runs cancel
themselves, keeping us inside free-tier minutes.

All four steps pass locally as of the initial commit.

## Hosting — Vercel (Hobby / free tier)

**Choice: Vercel Hobby plan ($0/month).** No paid commitment.

Why Vercel:

- First-party Next.js support — zero build configuration, App Router and
  React 19 work out of the box.
- Git integration auto-deploys `main` to production and opens a preview URL for
  every PR, complementing (not duplicating) the GitHub Actions checks.
- Generous free tier suitable for a placeholder/early product; no credit card
  required to start.

Alternatives considered:

- **Cloudflare Pages / Netlify** — both viable and free, but need extra adapters
  or config for full Next.js SSR/runtime features. Kept as fallbacks.
- **GitHub Pages** — static-export only; rejected because it forecloses on
  server-side features we will want as the product grows.

Vercel is zero-config for this app, so no `vercel.json` is required. If we later
need custom headers/redirects, add one at the repo root.

## One-time provisioning (requires account credentials)

CI config and deploy strategy are committed as code, but pushing CI and serving a
live URL require external accounts that must be provisioned once:

1. **GitHub repository** — create the repo (e.g. `baboo/web`), push `main`.
   GitHub Actions then runs `ci.yml` automatically.
2. **Vercel project** — sign in with the GitHub account, "Import Project" →
   select the repo. Vercel detects Next.js and deploys. The production URL
   (e.g. `https://baboo-web.vercel.app`) is the live placeholder.

These two steps are the only blockers to a green CI badge + public URL; the
engineering is done and verified locally.
