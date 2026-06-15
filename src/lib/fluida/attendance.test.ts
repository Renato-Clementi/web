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

  it("pairs a doubled-in sequence by position and flags it anomalous", () => {
    // in,in,out: the labels are incoherent, so we pair by time (08->10) and
    // report the trailing 17:00 as an orphan rather than guessing a shift.
    const punches = [
      punch("2026-06-15T08:00:00+02:00", "in"),
      punch("2026-06-15T10:00:00+02:00", "in"), // forgot to clock out / re-scan
      punch("2026-06-15T17:00:00+02:00", "out"),
    ];
    const out = buildAttendance(punches, [10, 10, 10]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      checkIn: "2026-06-15 06:00:00",
      checkOut: "2026-06-15 08:00:00",
    });
    expect(out[0].warnings.join(" ")).toContain("mislabeled");
    expect(out[1].checkOut).toBeNull();
    expect(out[1].warnings.join(" ")).toContain("orphan punch");
  });

  it("records an orphan out as an open review item, never a 0h record", () => {
    const punches = [punch("2026-06-15T17:00:00+02:00", "out")];
    const out = buildAttendance(punches, [10]);
    expect(out).toHaveLength(1);
    expect(out[0].checkOut).toBeNull(); // not written; reported for review
    expect(out[0].warnings.join(" ")).toContain("orphan punch");
  });

  it("recovers a valid morning from a scrambled day (BAB-89: Lorenzo 12/06)", () => {
    // IN07:25 OUT13:44 OUT14:40 IN15:40 — double-out then closes on an in.
    // Old pairing emitted a 0h orphan at 14:40 and dropped 15:40; positional
    // pairing recovers both the morning and the afternoon, flagged for review.
    const punches = [
      punch("2026-06-12T07:25:00+02:00", "in"),
      punch("2026-06-12T13:44:00+02:00", "out"),
      punch("2026-06-12T14:40:00+02:00", "out"),
      punch("2026-06-12T15:40:00+02:00", "in"),
    ];
    const out = buildAttendance(punches, [7, 7, 7, 7]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      employeeId: 7,
      checkIn: "2026-06-12 05:25:00",
      checkOut: "2026-06-12 11:44:00",
    });
    expect(out[1]).toMatchObject({
      checkIn: "2026-06-12 12:40:00",
      checkOut: "2026-06-12 13:40:00",
    });
    // no degenerate 0h record, and the day is flagged for HR review
    expect(out.every((iv) => iv.checkIn !== iv.checkOut)).toBe(true);
    expect(
      out.every((iv) => iv.warnings.join(" ").includes("mislabeled")),
    ).toBe(true);
  });

  it("recovers a full day from inverted directions (BAB-89: Tommaso 12/06)", () => {
    // OUT07:17 IN18:27 — directions inverted. Old pairing wrote a 0h at 07:17
    // and dropped the day; positional pairing recovers the 11h interval.
    const punches = [
      punch("2026-06-12T07:17:00+02:00", "out"),
      punch("2026-06-12T18:27:00+02:00", "in"),
    ];
    const out = buildAttendance(punches, [17, 17]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      employeeId: 17,
      checkIn: "2026-06-12 05:17:00",
      checkOut: "2026-06-12 16:27:00",
    });
    expect(out[0].checkIn).not.toBe(out[0].checkOut);
    expect(out[0].warnings.join(" ")).toContain("mislabeled");
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
