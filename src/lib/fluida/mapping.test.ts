import { describe, it, expect } from "vitest";
import { buildResolver } from "./mapping";

const directory = [
  { id: 10, barcode: "0001", workEmail: "mario@baboo.eu" },
  { id: 20, barcode: null, workEmail: "Luigi@Gmail.com" },
  { id: 30, barcode: "0003", workEmail: null },
];

describe("buildResolver", () => {
  const r = buildResolver(directory);

  it("matches on barcode first (primary key)", () => {
    expect(r.resolve("0001", "someone@else.com")).toMatchObject({
      employeeId: 10,
      via: "barcode",
    });
  });

  it("falls back to work_email when badge is unknown", () => {
    expect(r.resolve("9999", "mario@baboo.eu")).toMatchObject({
      employeeId: 10,
      via: "work_email",
    });
  });

  it("is case-insensitive on the email fallback", () => {
    expect(r.resolve("", "luigi@gmail.com")).toMatchObject({
      employeeId: 20,
      via: "work_email",
    });
  });

  it("returns unmatched when neither key resolves", () => {
    expect(r.resolve("nope", "nobody@x.com")).toMatchObject({
      employeeId: null,
      via: "unmatched",
    });
  });

  it("does not match on empty badge against empty barcodes", () => {
    expect(r.resolve("", undefined)).toMatchObject({ employeeId: null });
  });
});
