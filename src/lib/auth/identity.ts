/**
 * Provider-neutral authentication identity.
 *
 * This is the ONLY application module (besides the root `<ClerkProvider>` and
 * `src/middleware.ts`) that touches the auth provider's SDK directly. Everything
 * else in the app depends on the neutral `AuthIdentity` shape and on our own
 * `users` / `orgs` / `memberships` tables — never on Clerk types.
 *
 * That boundary is deliberate: the auth provider is a moderately one-way-door
 * decision (see docs/adr/0001-auth-provider.md). Containing it here means a
 * future provider swap is "re-implement getAuthIdentity()", not "rewrite the
 * app". The chosen provider is mirrored into `users.auth_provider` /
 * `users.auth_subject` so the mapping is explicit and migratable.
 */
import { currentUser } from "@clerk/nextjs/server";

/** The auth provider in use. Stored verbatim in `users.auth_provider`. */
export const AUTH_PROVIDER = "clerk" as const;

export type AuthIdentity = {
  /** Which external provider vouched for this identity. */
  provider: typeof AUTH_PROVIDER;
  /** Stable external subject id (Clerk user id). Goes to `users.auth_subject`. */
  subject: string;
  /** Primary email; required — we cannot onboard a user without one. */
  email: string;
  /** Display name if the provider has one. */
  fullName: string | null;
};

/**
 * Resolve the current request's authenticated identity, provider-neutral.
 * Returns `null` when there is no signed-in user (or no usable email).
 *
 * Must be called from a server context (Server Component, Route Handler, or
 * Server Action) — it reads the request's auth state via the provider SDK.
 */
export async function getAuthIdentity(): Promise<AuthIdentity | null> {
  const user = await currentUser();
  if (!user) return null;

  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    null;
  if (!email) return null;

  const fullName =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;

  return { provider: AUTH_PROVIDER, subject: user.id, email, fullName };
}
