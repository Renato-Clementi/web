/**
 * Lead domain types for the leads dashboard.
 *
 * The canonical source of truth is Odoo's `crm.lead` model (see mcp-odoo
 * connector). We project it down to the small, serializable shape the
 * dashboard actually needs so the whole lead list can be handed to the
 * client component and aggregated reactively.
 */

/** Odoo `crm.lead.type` — a record is either a raw lead or a qualified opportunity. */
export type LeadType = "lead" | "opportunity";

/** A single lead, projected from `crm.lead`. */
export interface Lead {
  /** Odoo record id. */
  id: number;
  /** `create_date`, as an ISO 8601 string (UTC). The dashboard's time axis. */
  createdAt: string;
  /** `source_id` display name (e.g. "Website", "Referral"), or "Unknown". */
  source: string;
  /** `stage_id` display name (e.g. "New", "Qualified", "Won"), or "Unknown". */
  stage: string;
  /** `type`: lead vs opportunity. */
  type: LeadType;
}

/** Where the dashboard's data came from, surfaced in the UI. */
export type LeadDataSource = "odoo" | "demo";

/** Result of loading leads: the records plus provenance for the UI banner. */
export interface LeadsLoadResult {
  leads: Lead[];
  source: LeadDataSource;
  /** Human-readable note about provenance (e.g. why demo data is in use). */
  note: string;
}
