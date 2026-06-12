# Baboo

The Baboo web application. This repository is the engineering substrate every
product direction builds on — a modern, boring, well-supported web stack that is
fast to ship and easy for the next engineer to pick up without archaeology.

## Quick start

Requirements: **Node.js 20+** (developed on Node 24) and npm.

```bash
npm install   # install dependencies
npm run dev   # start the local dev server
```

Open <http://localhost:3000> — you should see the Baboo placeholder page
confirming the app boots locally. That single `npm run dev` command is the
documented "fresh clone → app runs locally" path.

## Stack & rationale

| Choice                       | What                       | Why                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript**               | Language                   | Type safety across the whole stack; the default for mainstream web work.                                                                                                                                                         |
| **Next.js (App Router)**     | Full-stack React framework | Mainstream, batteries-included (routing, SSR/SSG, API routes, server actions). Direction-agnostic: works for marketing pages, dashboards, and APIs alike, so we don't have to re-platform when product direction firms up.       |
| **React 19**                 | UI library                 | Industry standard; largest ecosystem and hiring pool.                                                                                                                                                                            |
| **ESLint**                   | Linting                    | Ships with the Next.js config; catches correctness issues.                                                                                                                                                                       |
| **Prettier**                 | Formatting                 | Opinionated, zero-debate formatting. `eslint-config-prettier` disables conflicting ESLint rules.                                                                                                                                 |
| **Vitest + Testing Library** | Unit/component tests       | Fast, Vite-native runner with the React Testing Library for component tests. Tests live next to source as `*.test.tsx`.                                                                                                          |
| **GitHub Actions**           | CI                         | On every push/PR to `main`: install → format check → lint → build → test.                                                                                                                                                        |
| **Clerk**                    | Auth / identity            | Standalone identity layer (sign-up, login, sessions, hosted UI) that doesn't assume it owns our DB — the right fit for a self-managed Postgres. Tenancy stays in our own tables. See [ADR 0001](docs/adr/0001-auth-provider.md). |

We deliberately picked the most mainstream option at each layer rather than
anything novel. The goal at this stage is throughput and low onboarding cost,
not cleverness. These are reversible choices: nothing here locks us into a
specific hosting provider or database.

## Project structure

```
.
├── src/
│   ├── middleware.ts   # Clerk route protection (/dashboard, /onboarding)
│   ├── app/            # Next.js App Router (routes, layouts, pages)
│   │   ├── layout.tsx  # root layout + <ClerkProvider> + metadata
│   │   ├── page.tsx    # marketing landing (sign-up / sign-in CTAs)
│   │   ├── (auth)/     # Clerk-hosted sign-in / sign-up routes
│   │   ├── onboarding/ # create-org flow (first run)
│   │   ├── dashboard/  # authenticated app shell
│   │   └── globals.css # global styles
│   └── lib/
│       ├── auth/       # provider-neutral auth: identity, onboarding, context
│       └── db/         # tenant-scoped Postgres access layer (withOrg/…)
├── docs/adr/           # architecture decision records (0001 = auth provider)
├── db/                 # SQL migrations, runner, smoke test (see db/README.md)
├── public/             # static assets served at /
├── eslint.config.mjs   # ESLint flat config (Next + Prettier)
├── .prettierrc.json    # Prettier formatting rules
├── .env.example        # documented env vars — copy to .env.local
├── next.config.ts      # Next.js config
└── tsconfig.json       # TypeScript config (path alias @/* → src/*)
```

Conventions:

- **Imports**: use the `@/*` alias for anything under `src/` (e.g.
  `import { x } from "@/lib/x"`) instead of long relative paths.
- **Routes**: add pages/layouts under `src/app/` following App Router
  conventions.
- **Co-locate**: keep component-specific styles/helpers next to the component.

## Environment variables

Copy `.env.example` to `.env.local` and fill in real values:

```bash
cp .env.example .env.local
```

- `.env.local` is git-ignored — **never commit secrets**.
- Variables prefixed `NEXT_PUBLIC_` are exposed to the browser bundle.
  Everything else stays server-only; keep secrets unprefixed.

## Scripts

| Command                | Does                                                  |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Start the local dev server on port 3000.              |
| `npm run build`        | Production build (also type-checks).                  |
| `npm run start`        | Serve the production build.                           |
| `npm run lint`         | Run ESLint.                                           |
| `npm run format`       | Format the codebase with Prettier (writes files).     |
| `npm run format:check` | Check formatting without writing (CI-friendly).       |
| `npm run db:migrate`   | Apply `db/migrations/*.sql` (needs `DATABASE_URL`).   |
| `npm run db:smoke`     | Schema smoke test against a live DB (`DATABASE_URL`). |

The data model (multi-tenant Postgres + pgvector) is documented in
[`db/README.md`](db/README.md).

## Features

### Leads dashboard — `/dashboard/leads`

Lead trends over time for the board: a primary "leads per day/week/month" chart
with a selectable date range, headline KPIs (total leads, leads in the selected
period, period-over-period % change), and a breakdown by source / stage / type.

Data source precedence (`src/lib/leads/source.ts`):

1. **Live Odoo** — reads `crm.lead` over JSON-RPC when `ODOO_URL`, `ODOO_DB`,
   `ODOO_USERNAME`, and `ODOO_API_KEY` are set (see `.env.example`). This is the
   same self-managed Odoo 18 source the `mcp-odoo/` connector targets.
2. **Demo data** — deterministic synthetic leads otherwise, with an explicit
   in-app banner so demo data is never mistaken for production. Connecting a
   live Odoo is the only remaining step to show real numbers.

Aggregation lives in `src/lib/leads/aggregate.ts` (pure, unit-tested; bucketing
is UTC-based, with a business-timezone refinement noted as a follow-up).

### Auth & org onboarding

Sign-up, login, and sessions are handled by **Clerk** — chosen over Supabase
Auth because our datastore is a self-managed Postgres + pgvector and Clerk is a
standalone identity layer that doesn't assume it owns the DB. Full rationale and
the lock-in-containment plan: [`docs/adr/0001-auth-provider.md`](docs/adr/0001-auth-provider.md).

Flow: `/sign-up` → email verify (Clerk) → `/onboarding` (name your org) →
`/dashboard` (authenticated shell). Routes under `/dashboard` and `/onboarding`
are protected by `src/middleware.ts`; the session persists across reloads.

Key boundary — **our Postgres is the source of truth for tenancy**, not Clerk:

- `orgs` / `memberships` / `users` (BAB-15) model orgs and roles; Clerk only
  authenticates. The signed-in Clerk user is mirrored into `users` with
  `auth_provider`/`auth_subject` on first request.
- The provider is isolated behind a thin adapter so a swap stays cheap. Only
  three files import the Clerk SDK: `src/app/layout.tsx` (`<ClerkProvider>`),
  `src/middleware.ts`, and `src/lib/auth/identity.ts` (`getAuthIdentity()` →
  provider-neutral `AuthIdentity`). The rest of the app uses our own model via
  `src/lib/auth/context.ts` (`getAppContext()`).
- Onboarding (find-or-create user, create org + owner membership) lives in
  `src/lib/auth/onboarding.ts`, unit-tested in `onboarding.test.ts`. It runs
  under `withServiceRole` because it spans tenants before any org exists.

`next build` and unit tests run **without** Clerk keys. Live sign-in/up needs
real keys at runtime — set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY` (see `.env.example`).
