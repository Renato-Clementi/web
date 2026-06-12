import type { Metadata } from "next";
import { loadLeads } from "@/lib/leads/source";
import { LeadsDashboard } from "./LeadsDashboard";

export const metadata: Metadata = {
  title: "Leads dashboard · Baboo",
  description: "Lead trends over time, KPIs, and breakdowns.",
};

// Always render fresh: leads change over time and may come from a live CRM.
export const dynamic = "force-dynamic";

export default async function LeadsDashboardPage() {
  const { leads, source, note } = await loadLeads();
  return <LeadsDashboard leads={leads} source={source} note={note} />;
}
