import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, getPool, toVector } from "./index";

describe("toVector", () => {
  it("formats a full-dimension embedding as a pgvector literal", () => {
    const v = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 1000);
    const literal = toVector(v);
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    expect(literal.split(",")).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("rejects a wrong-dimension embedding", () => {
    expect(() => toVector([0.1, 0.2, 0.3])).toThrow(/Expected 1024/);
  });
});

describe("getPool", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("throws a clear error when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    expect(() => getPool()).toThrow(/DATABASE_URL is not set/);
  });
});
