/**
 * The authenticated request context: who is signed in (our `users` row), which
 * orgs they belong to, and the currently-active org. This is what app pages and
 * route handlers consume — they never see Clerk types, only our own model.
 *
 * Resolution runs under `withServiceRole` because it spans tenants: mirroring
 * the user and listing *all* their memberships happens before any single org is
 * selected, so per-org RLS would hide the very rows we need. Once an active org
 * is chosen, downstream tenant data access must use `withOrg(activeOrg.id, …)`.
 */
import { withServiceRole } from "@/lib/db";
import { getAuthIdentity } from "./identity";
import {
  getOrCreateUser,
  listOrgsForUser,
  type AppUser,
  type OrgMembership,
} from "./onboarding";

export type AppContext = {
  user: AppUser;
  orgs: OrgMembership[];
  /** First membership for now; org switching lands in a later milestone. */
  activeOrg: OrgMembership | null;
};

/**
 * Resolve the current request's app context, creating the `users` row on first
 * sign-in. Returns `null` when no one is signed in — callers redirect to
 * `/sign-in`. A non-null context with `activeOrg === null` means "signed in but
 * no org yet" → callers redirect to `/onboarding`.
 */
export async function getAppContext(): Promise<AppContext | null> {
  const identity = await getAuthIdentity();
  if (!identity) return null;

  return withServiceRole(async (client) => {
    const user = await getOrCreateUser(client, identity);
    const orgs = await listOrgsForUser(client, user.id);
    return { user, orgs, activeOrg: orgs[0] ?? null };
  });
}
