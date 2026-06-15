/**
 * BAB-88 read-only probe: does the missing OUT punch exist in Fluida?
 *
 * For each incomplete-attendance day flagged on BAB-88, this lists ALL raw
 * Fluida stampings (IN/OUT) for that person over a wide window, so HR/CEO can
 * see whether a real OUT punch exists (recoverable, no fabrication) or is
 * genuinely absent (employee forgot to punch out → must be regularised).
 *
 * Read-only: hits GET /api/v1/stampings/list only. Writes nothing.
 *   FLUIDA_API_KEY (env) + companyId below.
 *   tsx scripts/bab88_probe.ts
 */
import { FluidaApiSource } from "../src/lib/fluida/source";

const COMPANY_ID = "fc9f83c2-8698-4e0d-9ed9-a6d1bd934f41"; // CEO-provided (BAB-79), not secret
const FROM = "2026-06-01T00:00:00.000Z";
const TO = "2026-06-16T00:00:00.000Z";

// Persons flagged on BAB-88 (by Fluida user_email, lowercased). Odoo emp id in label.
const FOCUS = [
  { emp: 4, name: "Dima Ditlashok" },
  { emp: 7, name: "Lorenzo Pizzi" },
  { emp: 12, name: "Orient Zekaj" },
  { emp: 14, name: "Federico Guarnori" },
  { emp: 15, name: "Mourad Jaouhari Lebrari" },
  { emp: 17, name: "Tommaso Ferrarese" },
  { emp: 18, name: "Fabio Favino" },
];

function romeDate(iso: string): string {
  // YYYY-MM-DD in Europe/Rome
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
function romeTime(iso: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

async function main(): Promise<void> {
  const apiKey = process.env.FLUIDA_API_KEY?.trim();
  if (!apiKey) throw new Error("FLUIDA_API_KEY not set");
  const src = new FluidaApiSource({ apiKey, companyId: COMPANY_ID });

  const { punches } = await src.fetch(FROM, TO);
  console.log(`Fetched ${punches.length} stampings ${FROM.slice(0, 10)}..${TO.slice(0, 10)}\n`);

  // Group punches by email -> date -> sorted punches
  const byEmail = new Map<string, typeof punches>();
  for (const p of punches) {
    const k = (p.email ?? p.badge).toLowerCase();
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k)!.push(p);
  }

  // Try to match each focus person by name token against the emails present.
  const emails = [...byEmail.keys()];
  for (const f of FOCUS) {
    const tokens = f.name.toLowerCase().split(/\s+/);
    const match = emails.find((e) => tokens.some((t) => t.length > 3 && e.includes(t)));
    console.log(`=== emp ${f.emp} ${f.name}  ->  ${match ?? "(no email match in stampings)"}`);
    if (!match) continue;
    const list = [...byEmail.get(match)!].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
    // group by Rome date
    const days = new Map<string, typeof punches>();
    for (const p of list) {
      const d = romeDate(p.timestamp);
      if (!days.has(d)) days.set(d, []);
      days.get(d)!.push(p);
    }
    for (const [d, ps] of [...days.entries()].sort()) {
      const seq = ps
        .map((p) => `${p.direction.toUpperCase()}@${romeTime(p.timestamp)}`)
        .join("  ");
      const ins = ps.filter((p) => p.direction === "in").length;
      const outs = ps.filter((p) => p.direction === "out").length;
      const flag = ins !== outs ? "  ⚠️ UNBALANCED" : "";
      console.log(`   ${d}  [${ins}IN/${outs}OUT]  ${seq}${flag}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
