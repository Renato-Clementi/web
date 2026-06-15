import { describe, it, expect } from "vitest";
import { toOdooUtc, localToInstant, localDateKey, parseInstant } from "./time";

describe("toOdooUtc", () => {
  it("formats an instant as Odoo naive-UTC", () => {
    expect(toOdooUtc(new Date("2026-06-15T09:05:03Z"))).toBe(
      "2026-06-15 09:05:03",
    );
  });
  it("converts an offset instant to UTC", () => {
    // 11:00 in +02:00 == 09:00 UTC
    expect(toOdooUtc(new Date("2026-06-15T11:00:00+02:00"))).toBe(
      "2026-06-15 09:00:00",
    );
  });
  it("throws on an invalid date", () => {
    expect(() => toOdooUtc(new Date("nope"))).toThrow();
  });
});

describe("localToInstant (Europe/Rome)", () => {
  it("handles summer (CEST, +02:00)", () => {
    // 15 Jun 2026 09:00 Rome == 07:00 UTC
    expect(toOdooUtc(localToInstant("2026-06-15 09:00:00"))).toBe(
      "2026-06-15 07:00:00",
    );
  });
  it("handles winter (CET, +01:00)", () => {
    // 15 Jan 2026 09:00 Rome == 08:00 UTC
    expect(toOdooUtc(localToInstant("2026-01-15 09:00:00"))).toBe(
      "2026-01-15 08:00:00",
    );
  });
  it("accepts a T separator and missing seconds", () => {
    expect(toOdooUtc(localToInstant("2026-06-15T09:00"))).toBe(
      "2026-06-15 07:00:00",
    );
  });
  it("throws on garbage", () => {
    expect(() => localToInstant("15/06/2026 9am")).toThrow();
  });
});

describe("localDateKey", () => {
  it("uses the local calendar day, not UTC", () => {
    // 23:30 UTC on the 14th is 01:30 Rome on the 15th (summer +2)
    expect(localDateKey(new Date("2026-06-14T23:30:00Z"))).toBe("2026-06-15");
  });
});

describe("parseInstant", () => {
  it("throws on unparseable input", () => {
    expect(() => parseInstant("not-a-date")).toThrow();
  });
});
