# ADR 0001 — Auth provider: Clerk

- **Status:** Accepted
- **Date:** 2026-06-12
- **Decider:** Atlas (CTO)
- **Context tickets:** [BAB-16](/BAB/issues/BAB-16) (this work), [BAB-3](/BAB/issues/BAB-3) §7 (one-way-door list), [BAB-15](/BAB/issues/BAB-15) (data model)

## Decision

Use **Clerk** (`@clerk/nextjs`) as the authentication / identity provider for
the support-deflection MVP: sign-up, login, email verification, session
management, and the hosted auth UI. **Do not** use Clerk Organizations as the
source of truth for tenancy — our own Postgres `orgs` / `memberships` tables
(BAB-15) own that. Clerk owns _credentials and sessions_; we own the _domain_.

## Why this is a real decision

BAB-3 §7 flags the auth/identity provider as **moderately one-way-door**: user
records, credentials, and live sessions accrete against whatever we pick, and
migrating them later is painful (passwords can't be exported in plaintext;
social links and sessions break). So we choose once and write down why.

## Options considered

|                                 | **Clerk (chosen)**                                                                                           | Supabase Auth                                                                                                     | Hand-rolled        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------ |
| Next.js App Router DX           | Best-in-class: `clerkMiddleware`, `auth()`, `currentUser()`, drop-in `<SignIn/>`/`<SignUp/>`/`<UserButton/>` | Good, but SDK assumes you use Supabase Postgres                                                                   | n/a                |
| Fits a **self-hosted** Postgres | Yes — Clerk is a standalone identity service; it never assumes it owns our DB                                | Awkward — GoTrue wants its own `auth` schema in _its_ Postgres; we already run our own pgvector Postgres (BAB-15) | Yes                |
| Effort to MVP                   | Lowest                                                                                                       | Medium (run/wire GoTrue separately)                                                                               | Highest + riskiest |
| Security surface we own         | Minimal                                                                                                      | Medium                                                                                                            | All of it (bad)    |
| Free tier at MVP scale          | 10k MAU free                                                                                                 | 50k MAU free                                                                                                      | —                  |
| EU data residency               | Configurable per BAB-3 §7                                                                                    | Configurable                                                                                                      | —                  |

"Never hand-roll auth" is an explicit BAB-16 constraint, so option 3 is out.

The deciding factor between Clerk and Supabase Auth: **our datastore is already
a self-managed Postgres + pgvector** (BAB-15), and our tenancy model lives there
behind Row-Level Security. Supabase Auth is most valuable when Supabase _is_
your database; bolting GoTrue onto a separate Postgres is plumbing we'd own for
no benefit. Clerk is purpose-built to be the identity layer for an app whose
data lives elsewhere, and has the strongest Next.js App Router integration —
which lets a one-engineer team ship the MVP fastest. That matches the BAB-3
build-vs-buy guidance ("Never hand-roll auth; both have free tiers").

## How we contain the lock-in (making a one-way-ish door more reversible)

1. **Our DB is the source of truth.** `users` (global identity), `orgs`,
   `memberships` are ours. Clerk only authenticates; it does not model tenancy.
2. **Identity is mirrored, not borrowed.** On first authenticated request we
   upsert the Clerk user into `users` with
   `auth_provider = 'clerk'` + `auth_subject = <clerk user id>`
   (columns BAB-15 pre-provisioned for exactly this). The mapping is explicit
   and migratable; a future provider swap is a re-map of subjects, not a
   domain rebuild.
3. **The provider is behind a thin adapter.** Only three files import the Clerk
   SDK: the root `<ClerkProvider>` (`src/app/layout.tsx`), `src/middleware.ts`,
   and `src/lib/auth/identity.ts` (`getAuthIdentity()` → provider-neutral
   `AuthIdentity`). Everything else depends on `AuthIdentity` and our own model.
   Swapping providers means re-implementing `getAuthIdentity()` + middleware.

## Cost / governance

Clerk is **free at MVP scale** (10k monthly active users). No spend or contract
is committed by this decision. Per AGENTS.md, creating the external Clerk
**account** and provisioning its **API keys** into the deploy environment is a
governance/secret-handling step handed to the CEO (agents can't read secrets) —
tracked on BAB-16. Before any move to a paid tier, the CTO will flag it.

## Consequences

- New env vars: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and the
  `NEXT_PUBLIC_CLERK_SIGN_{IN,UP}*` URLs (see `.env.example`).
- `next build` and unit tests run **without** keys (auth pages are dynamic);
  live sign-in/up requires real keys at runtime.
- Tenant data access still goes through `withOrg(activeOrg.id, …)`; onboarding
  (which spans tenants before an org exists) uses `withServiceRole`.
