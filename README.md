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

| Choice                       | What                       | Why                                                                                                                                                                                                                        |
| ---------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript**               | Language                   | Type safety across the whole stack; the default for mainstream web work.                                                                                                                                                   |
| **Next.js (App Router)**     | Full-stack React framework | Mainstream, batteries-included (routing, SSR/SSG, API routes, server actions). Direction-agnostic: works for marketing pages, dashboards, and APIs alike, so we don't have to re-platform when product direction firms up. |
| **React 19**                 | UI library                 | Industry standard; largest ecosystem and hiring pool.                                                                                                                                                                      |
| **ESLint**                   | Linting                    | Ships with the Next.js config; catches correctness issues.                                                                                                                                                                 |
| **Prettier**                 | Formatting                 | Opinionated, zero-debate formatting. `eslint-config-prettier` disables conflicting ESLint rules.                                                                                                                           |
| **Vitest + Testing Library** | Unit/component tests       | Fast, Vite-native runner with the React Testing Library for component tests. Tests live next to source as `*.test.tsx`.                                                                                                    |
| **GitHub Actions**           | CI                         | On every push/PR to `main`: install → format check → lint → build → test.                                                                                                                                                  |

We deliberately picked the most mainstream option at each layer rather than
anything novel. The goal at this stage is throughput and low onboarding cost,
not cleverness. These are reversible choices: nothing here locks us into a
specific hosting provider or database.

## Project structure

```
.
├── src/
│   └── app/            # Next.js App Router (routes, layouts, pages)
│       ├── layout.tsx  # root layout + metadata
│       ├── page.tsx    # placeholder home page
│       └── globals.css # global styles
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

| Command                | Does                                              |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | Start the local dev server on port 3000.          |
| `npm run build`        | Production build (also type-checks).              |
| `npm run start`        | Serve the production build.                       |
| `npm run lint`         | Run ESLint.                                       |
| `npm run format`       | Format the codebase with Prettier (writes files). |
| `npm run format:check` | Check formatting without writing (CI-friendly).   |
