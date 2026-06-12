"use server";

import { redirect } from "next/navigation";
import { withServiceRole } from "@/lib/db";
import { getAuthIdentity } from "@/lib/auth/identity";
import {
  createOrgWithOwner,
  getOrCreateUser,
  listOrgsForUser,
} from "@/lib/auth/onboarding";

export type CreateOrgState = { error?: string };

/**
 * Create the signed-in user's first organization and make them its owner, then
 * land them on the dashboard. Idempotent-ish: if the user already has an org
 * (double submit, back button) we just forward to /dashboard.
 */
export async function createOrgAction(
  _prev: CreateOrgState,
  formData: FormData,
): Promise<CreateOrgState> {
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) {
    return { error: "Organization name must be at least 2 characters." };
  }
  if (name.length > 120) {
    return { error: "Organization name must be 120 characters or fewer." };
  }

  const identity = await getAuthIdentity();
  if (!identity) redirect("/sign-in");

  await withServiceRole(async (client) => {
    const user = await getOrCreateUser(client, identity);
    const existing = await listOrgsForUser(client, user.id);
    if (existing.length > 0) return; // already onboarded
    await createOrgWithOwner(client, { userId: user.id, name });
  });

  redirect("/dashboard");
}
