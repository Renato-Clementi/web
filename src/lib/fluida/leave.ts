/**
 * Pure transform: approved Fluida leaves -> `hr.leave` requests.
 *
 * Fluida emits free-text leave-type labels; Odoo needs an `hr.leave.type` id.
 * The mapping below uses the type ids configured in BAB-73:
 *   1 Ferie · 2 Malattia · 3 Recupero/Banca Ore · 4 Permesso non retribuito ·
 *   5 Permessi (ROL / Ex-festività).
 * Unknown labels are reported (never guessed) so HR can extend the map.
 */
import type { FluidaLeave, LeaveRequest } from "./types";
import { parseInstant, toOdooUtc } from "./time";

/** Default Fluida-label -> Odoo `hr.leave.type` id map (BAB-73 ids). */
export const DEFAULT_LEAVE_TYPE_MAP: Record<string, number> = {
  ferie: 1,
  "ferie e permessi": 1,
  malattia: 2,
  recupero: 3,
  "banca ore": 3,
  "recupero / banca ore": 3,
  "permesso non retribuito": 4,
  "permesso non pagato": 4,
  rol: 5,
  permessi: 5,
  "ex festivita": 5,
  "ex-festivita": 5,
  "ex festività": 5,
  "ex-festività": 5,
  "permessi (rol / ex-festività)": 5,
};

const normLabel = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

export interface LeaveBuildResult {
  requests: LeaveRequest[];
  /** Labels we could not map (unique), surfaced for HR to extend the map. */
  unknownTypes: string[];
}

/**
 * Convert approved leaves into Odoo `hr.leave` requests. `leaveEmployeeIds[i]`
 * is the resolved employee for `leaves[i]`; null entries and unapproved leaves
 * are skipped (the caller reports unmatched ones separately).
 */
export function buildLeaves(
  leaves: FluidaLeave[],
  leaveEmployeeIds: (number | null)[],
  typeMap: Record<string, number> = DEFAULT_LEAVE_TYPE_MAP,
): LeaveBuildResult {
  const requests: LeaveRequest[] = [];
  const unknown = new Set<string>();

  leaves.forEach((lv, i) => {
    const employeeId = leaveEmployeeIds[i];
    if (employeeId == null) return; // unmatched — reported by caller
    if (!lv.approved) return; // never import drafts/pending

    const holidayStatusId = typeMap[normLabel(lv.leaveType)];
    if (holidayStatusId == null) {
      unknown.add(lv.leaveType.trim());
      return;
    }
    requests.push({
      employeeId,
      holidayStatusId,
      dateFrom: toOdooUtc(parseInstant(lv.start)),
      dateTo: toOdooUtc(parseInstant(lv.end)),
    });
  });

  requests.sort((a, b) =>
    a.employeeId !== b.employeeId
      ? a.employeeId - b.employeeId
      : a.dateFrom.localeCompare(b.dateFrom),
  );
  return { requests, unknownTypes: [...unknown] };
}
