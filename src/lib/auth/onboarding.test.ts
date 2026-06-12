import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import {
  createOrgWithOwner,
  getOrCreateUser,
  listOrgsForUser,
  slugify,
  type AppUser,
} from "./onboarding";
import type { AuthIdentity } from "./identity";

/**
 * A fake PoolClient that returns a scripted result per `query()` call and
 * records every (text, params) so we can assert what SQL was issued. Each
 * scripted entry is either a result object or a function of (text, params).
 */
type Scripted =
  | { rows: unknown[] }
  | ((text: string, params: unknown[]) => { rows: unknown[] });

function fakeClient(script: Scripted[]) {
  const calls: { text: string; params: unknown[] }[] = [];
  let i = 0;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const next = script[i++];
      if (typeof next === "function") return next(text, params);
      return next ?? { rows: [] };
    },
  };
  return { client: client as unknown as PoolClient, calls };
}

const IDENTITY: AuthIdentity = {
  provider: "clerk",
  subject: "user_abc123",
  email: "Dana@Example.com",
  fullName: "Dana Scully",
};

const USER: AppUser = {
  id: "u-1",
  email: "dana@example.com",
  full_name: "Dana Scully",
  auth_provider: "clerk",
  auth_subject: "user_abc123",
};

describe("slugify", () => {
  it("lowercases, strips diacritics, and hyphenates", () => {
    expect(slugify("Café Münchën GmbH")).toBe("cafe-munchen-gmbh");
  });

  it("trims leading/trailing separators and collapses runs", () => {
    expect(slugify("  --Acme   Inc.!!  ")).toBe("acme-inc");
  });

  it("returns empty string for a name with no usable characters", () => {
    expect(slugify("!!! ??? ")).toBe("");
  });

  it("caps length", () => {
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("getOrCreateUser", () => {
  it("returns the existing user matched by external identity (one query)", async () => {
    const { client, calls } = fakeClient([{ rows: [USER] }]);
    const user = await getOrCreateUser(client, IDENTITY);
    expect(user).toEqual(USER);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/auth_provider = \$1 AND auth_subject = \$2/);
    expect(calls[0].params).toEqual(["clerk", "user_abc123"]);
  });

  it("links the identity to an existing email-matched user", async () => {
    const { client, calls } = fakeClient([
      { rows: [] }, // no identity match
      { rows: [USER] }, // UPDATE … RETURNING linked row
    ]);
    const user = await getOrCreateUser(client, IDENTITY);
    expect(user).toEqual(USER);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toMatch(/UPDATE users/);
    expect(calls[1].text).toMatch(/auth_provider IS NULL/);
    expect(calls[1].params).toEqual([
      "clerk",
      "user_abc123",
      "Dana@Example.com",
      "Dana Scully",
    ]);
  });

  it("inserts a new user when neither identity nor email matches", async () => {
    const { client, calls } = fakeClient([
      { rows: [] }, // no identity match
      { rows: [] }, // no email link
      { rows: [USER] }, // INSERT … RETURNING
    ]);
    const user = await getOrCreateUser(client, IDENTITY);
    expect(user).toEqual(USER);
    expect(calls).toHaveLength(3);
    expect(calls[2].text).toMatch(/INSERT INTO users/);
    expect(calls[2].params).toEqual([
      "Dana@Example.com",
      "Dana Scully",
      "clerk",
      "user_abc123",
    ]);
  });
});

describe("listOrgsForUser", () => {
  it("joins memberships to orgs and returns role", async () => {
    const rows = [{ id: "o-1", name: "Acme", slug: "acme", role: "owner" }];
    const { client, calls } = fakeClient([{ rows }]);
    const orgs = await listOrgsForUser(client, "u-1");
    expect(orgs).toEqual(rows);
    expect(calls[0].text).toMatch(/JOIN orgs o ON o.id = m.org_id/);
    expect(calls[0].params).toEqual(["u-1"]);
  });
});

describe("createOrgWithOwner", () => {
  it("uses the base slug when free and inserts org + owner membership", async () => {
    const { client, calls } = fakeClient([
      { rows: [] }, // uniqueSlug lookup: nothing taken
      { rows: [{ id: "o-9", name: "Acme Inc", slug: "acme-inc" }] }, // INSERT org
      { rows: [] }, // INSERT membership
    ]);
    const org = await createOrgWithOwner(client, {
      userId: "u-1",
      name: "Acme Inc",
    });
    expect(org).toEqual({
      id: "o-9",
      name: "Acme Inc",
      slug: "acme-inc",
      role: "owner",
    });

    // org insert used the base slug
    expect(calls[1].text).toMatch(/INSERT INTO orgs/);
    expect(calls[1].params).toEqual(["Acme Inc", "acme-inc"]);

    // membership insert is owner, linked to the new org + user
    expect(calls[2].text).toMatch(/INSERT INTO memberships/);
    expect(calls[2].text).toMatch(/'owner'/);
    expect(calls[2].params).toEqual(["o-9", "u-1"]);
  });

  it("disambiguates the slug when the base is taken", async () => {
    const { client, calls } = fakeClient([
      { rows: [{ slug: "acme" }, { slug: "acme-2" }] }, // taken
      { rows: [{ id: "o-9", name: "Acme", slug: "acme-3" }] }, // INSERT org
      { rows: [] }, // INSERT membership
    ]);
    const org = await createOrgWithOwner(client, {
      userId: "u-1",
      name: "Acme",
    });
    expect(org.slug).toBe("acme-3");
    expect(calls[1].params).toEqual(["Acme", "acme-3"]);
  });

  it("falls back to 'org' when the name has no slug-able characters", async () => {
    const { client, calls } = fakeClient([
      { rows: [] },
      { rows: [{ id: "o-9", name: "!!!", slug: "org" }] },
      { rows: [] },
    ]);
    await createOrgWithOwner(client, { userId: "u-1", name: "!!!" });
    expect(calls[0].params).toEqual(["org"]);
    expect(calls[1].params).toEqual(["!!!", "org"]);
  });
});
