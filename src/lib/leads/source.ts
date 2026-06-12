/**
 * Picks the leads data source for the dashboard.
 *
 * Order of precedence:
 *   1. Live Odoo (`crm.lead`) when ODOO_* env vars are configured.
 *   2. Deterministic demo data otherwise — clearly flagged in the result so
 *      the UI can show a "no live CRM connected" banner.
 *
 * If Odoo IS configured but the request fails, we surface the error via the
 * note and fall back to demo data rather than crashing the page.
 *
 * Server-only: imported by the dashboard's Server Component, never the client.
 */
import type { LeadsLoadResult } from "./types";
import { demoLeads } from "./demo";
import { loadLiveLeads } from "./odoo";

export async function loadLeads(): Promise<LeadsLoadResult> {
  try {
    const live = await loadLiveLeads();
    if (live !== null) {
      return {
        leads: live,
        source: "odoo",
        note: "Live data from Odoo crm.lead.",
      };
    }
  } catch (err) {
    return {
      leads: demoLeads(),
      source: "demo",
      note: `Odoo is configured but unreachable (${(err as Error).message}). Showing demo data.`,
    };
  }

  return {
    leads: demoLeads(),
    source: "demo",
    note: "No live Odoo connection configured — showing demo data. Set ODOO_URL/ODOO_DB/ODOO_USERNAME/ODOO_API_KEY to read the real crm.lead source.",
  };
}
