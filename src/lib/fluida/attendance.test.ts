import { describe, it, expect } from "vitest";
import { buildAttendance } from "./attendance";
import type { FluidaPunch } from "./types";

function punch(
  timestamp: string,
  direction: FluidaPunch["direction"] = "unknown",
  badge = "B1",
): FluidaPunch {
  return { badge, timestamp, direction };
}

describe("buildAttendance", () => {
  it("pairs a simple in/out into one interval (UTC-normalized)", () => {
    const punches = [
      punch("2026-06-15T08:00:00+02:00", "in"),
      punch("2026-06-15T17:00:00+02:00", "out"),
    ];
    const out = buildAttendance(punches, [10, 10]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      employeeId: 10,
      checkIn: "2026-06-15 06:00:00",
      checkOut: "2026-06-15 15:00:00",
      warnings: [],
    });
  });

  it("ignores punches with a null (unmapped) employee", () => {
    const punches = [
      punch("2026-06-15T08:00:00+02:00", "in"),
      punch("2026-06-15T17:00:00+02:00", "out"),
    ];
    expect(buildAttendance(punches, [null, null])).toHaveLength(0);
  });

  it("infers direction by alternating when source is unknown", () => {
    const punches = [
      punch("2026-06-15T08:00:00+02:00"),
      punch("2026-06-15T12:00:00+02:00"),
      punch("2026-06-15T13:00:00+02:00"),
      punch("2026-06-15T17:00:00+02:00"),
    ];
    const out = buildAttendance(punches, [10, 10, 10, 10]);
    expect(out).toHaveLength(2);
    expect(out[0].checkIn).toBe("2026-06-15 06:00:00");
    expect(out[0].checkOut).toBe("2026-06-15 10:00:00");
    expect(out[1].checkIn).toBe("2026-06-15 11:00:00");
    expect(out[1].checkOut).toBe("2026-06-15 15:00:00");
  });

  it("collapses double scans within the dedup window", () => {
    const punches = [
      punch("2026-06-15T08:00:00+02:00", "in"),
      punch("2026-06-15T08:00:30+02:00", "in"), // duplicate scan
      punch("2026-06-15T17:00:00+02:00", "out"),
    ];
    const out = buildAttendance(punches, [10, 10, 10]);
    expect(out).toHaveLength(1);
    expect(out[0].checkIn).toBe("2026-06-15 06:00:00");
    expect(out[0].checkOut).toBe("2026-06-15 15:00:00");
  });

  it("flags a forgotten check-out as an open, warned interval", () => {
    const punches = [punch("2026-06-15T08:00:00+02:00", "in")];
    const out = buildAttendance(punches, [10]);
    expect(out).toHaveLength(1);
    expect(out[0].checkOut).toBeNull();
    expect(out[0].warnings.join(" ")).toContain("no check-out");
  });

  it("closes a dangling in when a new in arrives, with a warning", () => {
    const punches = [
      punch("2026-06-15T08:00:00+02:00", "in"),
      punch("2026-06-15T10:00:00+02:00", "in"), // forgot to clock out
      punch("2026-06-15T17:00:00+02:00", "out"),
    ];
    const out = buildAttendance(punches, [10, 10, 10]);
    expect(out).toHaveLength(2);
    expect(out[0].checkOut).toBeNull();
    expect(out[0].warnings.join(" ")).toContain("missing check-out");
    expect(out[1].checkOut).toBe("2026-06-15 15:00:00");
  });

  it("records an orphan out with a warning instead of dropping it", () => {
    const punches = [punch("2026-06-15T17:00:00+02:00", "out")];
    const out = buildAttendance(punches, [10]);
    expect(out).toHaveLength(1);
    expect(out[0].warnings.join(" ")).toContain("orphan punch");
  });

  it("separates two employees and two days deterministically", () => {
    const punches = [
      punch("2026-06-16T08:00:00+02:00", "in", "B2"),
      punch("2026-06-16T17:00:00+02:00", "out", "B2"),
      punch("2026-06-15T08:00:00+02:00", "in", "B1"),
      punch("2026-06-15T17:00:00+02:00", "out", "B1"),
    ];
    const out = buildAttendance(punches, [20, 20, 10, 10]);
    expect(out.map((i) => i.employeeId)).toEqual([10, 20]);
  });
});
