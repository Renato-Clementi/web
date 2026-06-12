/**
 * Onboarding DB wiring: mirror an external identity into our own `users`
 * table, and create orgs + owner memberships. Provider-agnostic — it only
 * speaks our schema and the neutral `AuthIdentity` shape.
 *
 * These functions take an explicit `PoolClient` and must run inside a
 * `withServiceRole(...)` transaction: onboarding is cross-tenant bootstrap (a
 * brand-new user belongs to zero orgs, so RLS scoped to a single org would hide
 * everything they need). `withServiceRole` is the sanctioned path for exactly
 * this "which orgs does this user belong to?" lookup — see src/lib/db/index.ts.
 */
import type { PoolClient } from "pg";
import { query } from "@/lib/db";
import type { AuthIdentity } from "./identity";

/** A row from our own `users` table (global identity, not org-scoped). */
export type AppUser = {
  id: string;
  email: string;
  full_name: string | null;
  auth_provider: string | null;
  auth_subject: string | null;
};

/** An org the user belongs to, with their role in it. */
export type OrgMembership = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

const USER_COLUMNS = "id, email, full_name, auth_provider, auth_subject";

/**
 * Turn an org name into a URL-safe slug: strip diacritics, lowercase, collapse
 * non-alphanumerics to single hyphens, trim, and cap length. May return "" for
 * a name with no usable characters — callers fall back to a default base.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop combining marks (diacritics)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/**
 * Find-or-create the global user for an external identity.
 *   1. Match on (auth_provider, auth_subject) — the returning user.
 *   2. Else match on email and link the identity, but only if that user has no
 *      conflicting external identity yet (prevents account takeover).
 *   3. Else insert a fresh user.
 */
export async function getOrCreateUser(
  client: PoolClient,
  identity: AuthIdentity,
): Promise<AppUser> {
  const byIdentity = await query<AppUser>(
    client,
    `SELECT ${USER_COLUMNS} FROM users
       WHERE auth_provider = $1 AND auth_subject = $2`,
    [identity.provider, identity.subject],
  );
  if (byIdentity.rows[0]) return byIdentity.rows[0];

  const linked = await query<AppUser>(
    client,
    `UPDATE users
        SET auth_provider = $1,
            auth_subject  = $2,
            full_name     = COALESCE(full_name, $4)
      WHERE lower(email) = lower($3)
        AND auth_provider IS NULL
        AND auth_subject IS NULL
      RETURNING ${USER_COLUMNS}`,
    [identity.provider, identity.subject, identity.email, identity.fullName],
  );
  if (linked.rows[0]) return linked.rows[0];

  const created = await query<AppUser>(
    client,
    `INSERT INTO users (email, full_name, auth_provider, auth_subject)
       VALUES ($1, $2, $3, $4)
       RETURNING ${USER_COLUMNS}`,
    [identity.email, identity.fullName, identity.provider, identity.subject],
  );
  return created.rows[0];
}

/** Orgs the user belongs to, oldest first, with their role. */
export async function listOrgsForUser(
  client: PoolClient,
  userId: string,
): Promise<OrgMembership[]> {
  const { rows } = await query<OrgMembership>(
    client,
    `SELECT o.id, o.name, o.slug, m.role
       FROM memberships m
       JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY o.created_at ASC`,
    [userId],
  );
  return rows;
}

/**
 * Pick a slug for `base` that no org currently uses: `base`, else `base-2`,
 * `base-3`, … There is a small TOCTOU window vs. concurrent onboarding, but the
 * `orgs.slug` UNIQUE constraint is the hard backstop — a rare loser just retries.
 */
async function uniqueSlug(client: PoolClient, base: string): Promise<string> {
  const { rows } = await query<{ slug: string }>(
    client,
    `SELECT slug FROM orgs WHERE slug = $1 OR slug LIKE $1 || '-%'`,
    [base],
  );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Create a new org and make `userId` its owner, in one transaction. Returns the
 * created org as an `OrgMembership` (role is always 'owner' here).
 */
export async function createOrgWithOwner(
  client: PoolClient,
  params: { userId: string; name: string },
): Promise<OrgMembership> {
  const name = params.name.trim();
  const slug = await uniqueSlug(client, slugify(name) || "org");

  const org = (
    await query<{ id: string; name: string; slug: string }>(
      client,
      `INSERT INTO orgs (name, slug) VALUES ($1, $2)
         RETURNING id, name, slug`,
      [name, slug],
    )
  ).rows[0];

  await query(
    client,
    `INSERT INTO memberships (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
    [org.id, params.userId],
  );

  return { ...org, role: "owner" };
}
