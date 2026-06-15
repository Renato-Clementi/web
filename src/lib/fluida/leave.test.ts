import { describe, it, expect } from "vitest";
import { buildLeaves } from "./leave";
import type { FluidaLeave } from "./types";

function leave(extra: Partial<FluidaLeave> = {}): FluidaLeave {
  return {
    badge: "0001",
    leaveType: "Ferie",
    start: "2026-06-15T00:00:00+02:00",
    end: "2026-06-16T00:00:00+02:00",
    approved: true,
    ...extra,
  };
}

describe("buildLeaves", () => {
  it("maps known leave types to the BAB-73 type ids and UTC dates", () => {
    const { requests } = buildLeaves([leave()], [10]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      employeeId: 10,
      holidayStatusId: 1,
      dateFrom: "2026-06-14 22:00:00",
      dateTo: "2026-06-15 22:00:00",
    });
  });

  it("maps ROL / ex-festività to type 5", () => {
    const { requests } = buildLeaves([leave({ leaveType: "ROL" })], [10]);
    expect(requests[0].holidayStatusId).toBe(5);
  });

  it("skips unapproved leaves", () => {
    const { requests } = buildLeaves([leave({ approved: false })], [10]);
    expect(requests).toHaveLength(0);
  });

  it("skips unmatched employees", () => {
    const { requests } = buildLeaves([leave()], [null]);
    expect(requests).toHaveLength(0);
  });

  it("reports unknown leave types instead of guessing", () => {
    const { requests, unknownTypes } = buildLeaves(
      [leave({ leaveType: "Congedo Marziano" })],
      [10],
    );
    expect(requests).toHaveLength(0);
    expect(unknownTypes).toEqual(["Congedo Marziano"]);
  });
});
