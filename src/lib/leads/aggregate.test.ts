import { describe, it, expect } from "vitest";
import {
  bucketKey,
  bucketLeads,
  filterByRange,
  computeKpis,
  previousRange,
  breakdownBy,
  datasetBounds,
} from "./aggregate";
import type { Lead } from "./types";

function lead(id: number, createdAt: string, extra: Partial<Lead> = {}): Lead {
  return {
    id,
    createdAt,
    source: "Website",
    stage: "New",
    type: "lead",
    ...extra,
  };
}

describe("bucketKey", () => {
  it("buckets by UTC day", () => {
    expect(bucketKey("2026-06-12T09:30:00Z", "day")).toBe("2026-06-12");
  });

  it("buckets by ISO week (Monday)", () => {
    // 2026-06-12 is a Friday → week Monday is 2026-06-08.
    expect(bucketKey("2026-06-12T09:30:00Z", "week")).toBe("2026-06-08");
    // Sunday 2026-06-14 belongs to the same week.
    expect(bucketKey("2026-06-14T23:00:00Z", "week")).toBe("2026-06-08");
    // Monday 2026-06-15 starts a new week.
    expect(bucketKey("2026-06-15T00:00:00Z", "week")).toBe("2026-06-15");
  });

  it("buckets by month", () => {
    expect(bucketKey("2026-06-12T09:30:00Z", "month")).toBe("2026-06");
  });
});

describe("filterByRange", () => {
  it("includes both endpoints", () => {
    const leads = [
      lead(1, "2026-06-01T12:00:00Z"),
      lead(2, "2026-06-15T12:00:00Z"),
      lead(3, "2026-06-30T23:59:00Z"),
      lead(4, "2026-07-01T00:00:00Z"),
    ];
    const got = filterByRange(leads, { from: "2026-06-01", to: "2026-06-30" });
    expect(got.map((l) => l.id)).toEqual([1, 2, 3]);
  });
});

describe("bucketLeads", () => {
  it("fills gaps with zero-count buckets across the range (day)", () => {
    const leads = [
      lead(1, "2026-06-01T08:00:00Z"),
      lead(2, "2026-06-01T18:00:00Z"),
      lead(3, "2026-06-03T10:00:00Z"),
    ];
    const buckets = bucketLeads(leads, "day", {
      from: "2026-06-01",
      to: "2026-06-03",
    });
    expect(buckets.map((b) => [b.key, b.count])).toEqual([
      ["2026-06-01", 2],
      ["2026-06-02", 0],
      ["2026-06-03", 1],
    ]);
  });

  it("groups by month and fills empty months", () => {
    const leads = [
      lead(1, "2026-01-15T08:00:00Z"),
      lead(2, "2026-03-02T08:00:00Z"),
    ];
    const buckets = bucketLeads(leads, "month", {
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(buckets.map((b) => [b.key, b.count])).toEqual([
      ["2026-01", 1],
      ["2026-02", 0],
      ["2026-03", 1],
    ]);
  });

  it("aligns weekly buckets to Mondays", () => {
    const leads = [
      lead(1, "2026-06-08T08:00:00Z"), // Mon
      lead(2, "2026-06-14T08:00:00Z"), // Sun (same week)
      lead(3, "2026-06-15T08:00:00Z"), // Mon (next week)
    ];
    const buckets = bucketLeads(leads, "week", {
      from: "2026-06-08",
      to: "2026-06-21",
    });
    const map = Object.fromEntries(buckets.map((b) => [b.key, b.count]));
    expect(map["2026-06-08"]).toBe(2);
    expect(map["2026-06-15"]).toBe(1);
  });
});

describe("previousRange", () => {
  it("returns the equal-length window ending the day before from", () => {
    expect(previousRange({ from: "2026-06-08", to: "2026-06-14" })).toEqual({
      from: "2026-06-01",
      to: "2026-06-07",
    });
  });
});

describe("computeKpis", () => {
  const leads = [
    // previous period 2026-06-01..06-07: 2 leads
    lead(1, "2026-06-02T10:00:00Z"),
    lead(2, "2026-06-05T10:00:00Z"),
    // current period 2026-06-08..06-14: 3 leads
    lead(3, "2026-06-08T10:00:00Z"),
    lead(4, "2026-06-10T10:00:00Z"),
    lead(5, "2026-06-14T10:00:00Z"),
  ];

  it("computes totals and period-over-period change", () => {
    const k = computeKpis(leads, { from: "2026-06-08", to: "2026-06-14" });
    expect(k.totalAllTime).toBe(5);
    expect(k.inPeriod).toBe(3);
    expect(k.previousPeriod).toBe(2);
    expect(k.periodOverPeriod).toBeCloseTo(0.5); // (3-2)/2
  });

  it("returns null PoP when previous period is empty", () => {
    const k = computeKpis(leads, { from: "2026-06-08", to: "2026-06-14" });
    const empty = computeKpis([lead(9, "2026-06-10T10:00:00Z")], {
      from: "2026-06-08",
      to: "2026-06-14",
    });
    expect(k.periodOverPeriod).not.toBeNull();
    expect(empty.previousPeriod).toBe(0);
    expect(empty.periodOverPeriod).toBeNull();
  });
});

describe("breakdownBy", () => {
  it("counts and sorts a dimension within range, desc", () => {
    const leads = [
      lead(1, "2026-06-02T10:00:00Z", { source: "Website" }),
      lead(2, "2026-06-03T10:00:00Z", { source: "Referral" }),
      lead(3, "2026-06-04T10:00:00Z", { source: "Website" }),
      lead(4, "2026-07-01T10:00:00Z", { source: "Website" }), // out of range
    ];
    const got = breakdownBy(leads, "source", {
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(got).toEqual([
      { label: "Website", count: 2 },
      { label: "Referral", count: 1 },
    ]);
  });
});

describe("datasetBounds", () => {
  it("returns min/max dates", () => {
    const leads = [
      lead(1, "2026-06-10T10:00:00Z"),
      lead(2, "2026-01-01T10:00:00Z"),
      lead(3, "2026-12-31T10:00:00Z"),
    ];
    expect(datasetBounds(leads)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  it("returns null for empty input", () => {
    expect(datasetBounds([])).toBeNull();
  });
});
