/**
 * Resolve Fluida identifiers to Odoo `hr.employee` ids.
 *
 * Per the schema agreed in BAB-73:
 *  - primary key   = `hr.employee.barcode`  <-> Fluida badge
 *  - fallback key  = `hr.employee.work_email` <-> Fluida user email
 *
 * Matching is case-insensitive and trims whitespace. The directory is supplied
 * by the caller (read from Odoo in production, a fixture in tests) so this
 * module stays pure and testable.
 */
import type { MappingResult } from "./types";

export interface EmployeeDirectoryEntry {
  id: number;
  barcode?: string | null;
  workEmail?: string | null;
}

export interface EmployeeResolver {
  resolve(badge: string, email?: string): MappingResult;
}

const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();

/**
 * Build a resolver from a directory of employees. Barcode collisions keep the
 * first entry and are the caller's responsibility to clean up (a badge must be
 * unique); email collisions likewise favour the first.
 */
export function buildResolver(
  directory: EmployeeDirectoryEntry[],
): EmployeeResolver {
  const byBarcode = new Map<string, number>();
  const byEmail = new Map<string, number>();
  for (const e of directory) {
    const b = norm(e.barcode);
    if (b && !byBarcode.has(b)) byBarcode.set(b, e.id);
    const m = norm(e.workEmail);
    if (m && !byEmail.has(m)) byEmail.set(m, e.id);
  }

  return {
    resolve(badge: string, email?: string): MappingResult {
      const b = norm(badge);
      if (b && byBarcode.has(b)) {
        return { badge, email, employeeId: byBarcode.get(b)!, via: "barcode" };
      }
      const m = norm(email);
      if (m && byEmail.has(m)) {
        return {
          badge,
          email,
          employeeId: byEmail.get(m)!,
          via: "work_email",
        };
      }
      return { badge, email, employeeId: null, via: "unmatched" };
    },
  };
}
