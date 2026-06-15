import { describe, it, expect } from "vitest";
import { runSync } from "./pipeline";
import type { OdooHrPort } from "./odoo";
import type { FluidaSource } from "./source";
import type { AttendanceInterval, FluidaExport, LeaveRequest } from "./types";
import type { EmployeeDirectoryEntry } from "./mapping";

/** In-memory Odoo fake that records writes and supports idempotency lookups. */
class FakeOdoo implements OdooHrPort {
  attendance: (AttendanceInterval & { id: number })[] = [];
  leaves: (LeaveRequest & { id: number })[] = [];
  private seq = 1;
  constructor(private readonly directory: EmployeeDirectoryEntry[]) {}

  async listEmployees() {
    return this.directory;
  }
  async findAttendance(employeeId: number, checkIn: string) {
    const hit = this.attendance.find(
      (a) => a.employeeId === employeeId && a.checkIn === checkIn,
    );
    return hit ? hit.id : null;
  }
  async createAttendance(interval: AttendanceInterval) {
    const id = this.seq++;
    this.attendance.push({ ...interval, id });
    return id;
  }
  async updateAttendanceCheckOut(id: number, checkOut: string | null) {
    const row = this.attendance.find((a) => a.id === id);
    if (row) row.checkOut = checkOut;
  }
  async findLeave(
    employeeId: number,
    holidayStatusId: number,
    dateFrom: string,
  ) {
    const hit = this.leaves.find(
      (l) =>
        l.employeeId === employeeId &&
        l.holidayStatusId === holidayStatusId &&
        l.dateFrom === dateFrom,
    );
    return hit ? hit.id : null;
  }
  async createLeave(req: LeaveRequest) {
    const id = this.seq++;
    this.leaves.push({ ...req, id });
    return id;
  }
}

function fixedSource(data: FluidaExport): FluidaSource {
  return { name: "fixture", fetch: async () => data };
}

const directory: EmployeeDirectoryEntry[] = [
  { id: 10, barcode: "0001", workEmail: "mario@baboo.eu" },
  { id: 20, barcode: "0002", workEmail: "luigi@baboo.eu" },
];

const sample: FluidaExport = {
  punches: [
    { badge: "0001", timestamp: "2026-06-15T08:00:00+02:00", direction: "in" },
    { badge: "0001", timestamp: "2026-06-15T17:00:00+02:00", direction: "out" },
    { badge: "9999", timestamp: "2026-06-15T08:00:00+02:00", direction: "in" }, // unmapped
  ],
  leaves: [
    {
      badge: "0002",
      leaveType: "Ferie",
      start: "2026-06-15T00:00:00+02:00",
      end: "2026-06-16T00:00:00+02:00",
      approved: true,
    },
  ],
};

const opts = {
  rangeStartIso: "2026-06-15T00:00:00Z",
  rangeEndIso: "2026-06-16T00:00:00Z",
  now: () => new Date("2026-06-16T01:00:00Z"),
};

describe("runSync", () => {
  it("creates attendance + leave and reports unmatched records", async () => {
    const odoo = new FakeOdoo(directory);
    const report = await runSync(fixedSource(sample), odoo, opts);

    expect(report.attendance.created).toBe(1);
    expect(report.leave.created).toBe(1);
    expect(report.unmatched).toEqual([
      { badge: "9999", email: undefined, kind: "punch" },
    ]);
    expect(report.hadErrors).toBe(false);
    expect(odoo.attendance[0]).toMatchObject({
      employeeId: 10,
      checkIn: "2026-06-15 06:00:00",
      checkOut: "2026-06-15 15:00:00",
    });
    expect(odoo.leaves[0]).toMatchObject({
      employeeId: 20,
      holidayStatusId: 1,
    });
  });

  it("is idempotent: a second run over the same data writes nothing new", async () => {
    const odoo = new FakeOdoo(directory);
    await runSync(fixedSource(sample), odoo, opts);
    const second = await runSync(fixedSource(sample), odoo, opts);

    expect(second.attendance.created).toBe(0);
    expect(second.attendance.updated).toBe(1); // existing check_in re-touched
    expect(second.leave.created).toBe(0);
    expect(second.leave.skipped).toBe(1);
    expect(odoo.attendance).toHaveLength(1);
    expect(odoo.leaves).toHaveLength(1);
  });

  it("dry-run computes counts but performs no writes", async () => {
    const odoo = new FakeOdoo(directory);
    const report = await runSync(fixedSource(sample), odoo, {
      ...opts,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.attendance.created).toBe(1);
    expect(report.leave.created).toBe(1);
    expect(odoo.attendance).toHaveLength(0);
    expect(odoo.leaves).toHaveLength(0);
  });

  it("reports forgotten-checkout punches for review instead of writing them", async () => {
    const odoo = new FakeOdoo(directory);
    const forgotten: FluidaExport = {
      punches: [
        // in with no matching out → open/forgotten interval
        {
          badge: "0001",
          timestamp: "2026-06-15T08:00:00+02:00",
          direction: "in",
        },
      ],
      leaves: [],
    };
    const report = await runSync(fixedSource(forgotten), odoo, opts);

    expect(odoo.attendance).toHaveLength(0); // nothing written
    expect(report.attendance.created).toBe(0);
    expect(report.incompleteForReview).toHaveLength(1);
    expect(report.incompleteForReview[0]).toMatchObject({ employeeId: 10 });
    expect(report.hadErrors).toBe(false); // a forgotten punch is not an error
  });

  // --- BAB-89: robust pairing of out-of-order / mislabeled punches ----------
  const hrDirectory: EmployeeDirectoryEntry[] = [
    { id: 7, barcode: "B7", workEmail: "lorenzo@baboo.eu" },
    { id: 17, barcode: "B17", workEmail: "tommaso@baboo.eu" },
  ];
  const juneOpts = {
    rangeStartIso: "2026-06-12T00:00:00Z",
    rangeEndIso: "2026-06-13T00:00:00Z",
    now: () => new Date("2026-06-13T01:00:00Z"),
  };

  it("recovers Lorenzo's scrambled day (12/06) without a 0h record", async () => {
    // IN07:25 OUT13:44 OUT14:40 IN15:40 — double-out closing on an in.
    const odoo = new FakeOdoo(hrDirectory);
    const data: FluidaExport = {
      punches: [
        {
          badge: "B7",
          timestamp: "2026-06-12T07:25:00+02:00",
          direction: "in",
        },
        {
          badge: "B7",
          timestamp: "2026-06-12T13:44:00+02:00",
          direction: "out",
        },
        {
          badge: "B7",
          timestamp: "2026-06-12T14:40:00+02:00",
          direction: "out",
        },
        {
          badge: "B7",
          timestamp: "2026-06-12T15:40:00+02:00",
          direction: "in",
        },
      ],
      leaves: [],
    };
    const report = await runSync(fixedSource(data), odoo, juneOpts);

    // Two valid intervals written; neither is a degenerate 0h record.
    expect(report.attendance.created).toBe(2);
    expect(odoo.attendance).toHaveLength(2);
    expect(odoo.attendance.every((a) => a.checkIn !== a.checkOut)).toBe(true);
    expect(odoo.attendance.map((a) => [a.checkIn, a.checkOut])).toEqual([
      ["2026-06-12 05:25:00", "2026-06-12 11:44:00"],
      ["2026-06-12 12:40:00", "2026-06-12 13:40:00"],
    ]);
    // The anomalous day is logged to the JSON channel for Chronos (HR).
    expect(
      report.logs.some(
        (l) =>
          l.level === "warn" &&
          JSON.stringify(l.context ?? {}).includes("mislabeled"),
      ),
    ).toBe(true);
    expect(report.hadErrors).toBe(false);
  });

  it("recovers Tommaso's inverted day (12/06) without a 0h record", async () => {
    // OUT07:17 IN18:27 — directions inverted.
    const odoo = new FakeOdoo(hrDirectory);
    const data: FluidaExport = {
      punches: [
        {
          badge: "B17",
          timestamp: "2026-06-12T07:17:00+02:00",
          direction: "out",
        },
        {
          badge: "B17",
          timestamp: "2026-06-12T18:27:00+02:00",
          direction: "in",
        },
      ],
      leaves: [],
    };
    const report = await runSync(fixedSource(data), odoo, juneOpts);

    expect(report.attendance.created).toBe(1);
    expect(odoo.attendance).toHaveLength(1);
    expect(odoo.attendance[0]).toMatchObject({
      employeeId: 17,
      checkIn: "2026-06-12 05:17:00",
      checkOut: "2026-06-12 16:27:00",
    });
    expect(odoo.attendance[0].checkIn).not.toBe(odoo.attendance[0].checkOut);
    expect(report.hadErrors).toBe(false);
  });

  it("never writes a 0h record on a dry-run over the mislabeled days", async () => {
    const odoo = new FakeOdoo(hrDirectory);
    const data: FluidaExport = {
      punches: [
        {
          badge: "B7",
          timestamp: "2026-06-12T07:25:00+02:00",
          direction: "in",
        },
        {
          badge: "B7",
          timestamp: "2026-06-12T13:44:00+02:00",
          direction: "out",
        },
        {
          badge: "B7",
          timestamp: "2026-06-12T14:40:00+02:00",
          direction: "out",
        },
        {
          badge: "B7",
          timestamp: "2026-06-12T15:40:00+02:00",
          direction: "in",
        },
        {
          badge: "B17",
          timestamp: "2026-06-12T07:17:00+02:00",
          direction: "out",
        },
        {
          badge: "B17",
          timestamp: "2026-06-12T18:27:00+02:00",
          direction: "in",
        },
      ],
      leaves: [],
    };
    const report = await runSync(fixedSource(data), odoo, {
      ...juneOpts,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.attendance.created).toBe(3); // 2 Lorenzo + 1 Tommaso
    expect(odoo.attendance).toHaveLength(0); // dry-run: nothing persisted
  });

  it("records a fatal source error without throwing", async () => {
    const broken: FluidaSource = {
      name: "broken",
      fetch: async () => {
        throw new Error("portal down");
      },
    };
    const report = await runSync(broken, new FakeOdoo(directory), opts);
    expect(report.hadErrors).toBe(true);
    expect(report.logs.some((l) => l.message.includes("aborted"))).toBe(true);
  });
});
