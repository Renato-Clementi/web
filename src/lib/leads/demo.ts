/**
 * Deterministic demo dataset, used only when no live Odoo is configured.
 *
 * This is NOT production data — it exists so the dashboard renders and can be
 * verified end-to-end (and screenshotted) without a live CRM. The shape matches
 * exactly what the Odoo reader produces, so swapping in real data changes
 * nothing downstream. See `source.ts` for how the real source takes precedence.
 *
 * Determinism: a seeded LCG + a fixed anchor date make the data identical on
 * every run, so screenshots and any snapshot tests are stable.
 */
import type { Lead } from "./types";

const SOURCES = [
  "Website",
  "Referral",
  "LinkedIn Ads",
  "Cold Outreach",
  "Trade Show",
];
// Stage labels mirror a typical Odoo CRM pipeline. The distribution below
// skews toward earlier stages, so they're applied inline rather than picked
// uniformly.

/** Last day covered by the demo data (kept fixed for deterministic output). */
const ANCHOR_DAY = "2026-06-11";
/** How many days of history to generate. */
const SPAN_DAYS = 140;
const MS_PER_DAY = 86_400_000;

/** Tiny seeded PRNG (mulberry32) — deterministic across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
}

/**
 * Generate the demo lead set: a gentle upward trend with weekday seasonality
 * (fewer leads on weekends) so the "trend over time" chart looks realistic.
 */
export function demoLeads(): Lead[] {
  const random = rng(20260611);
  const anchorMs = Date.UTC(
    Number(ANCHOR_DAY.slice(0, 4)),
    Number(ANCHOR_DAY.slice(5, 7)) - 1,
    Number(ANCHOR_DAY.slice(8, 10)),
  );
  const leads: Lead[] = [];
  let id = 1000;

  for (let i = SPAN_DAYS - 1; i >= 0; i--) {
    const dayMs = anchorMs - i * MS_PER_DAY;
    const date = new Date(dayMs);
    const dow = date.getUTCDay(); // 0=Sun..6=Sat
    const isWeekend = dow === 0 || dow === 6;

    // Base volume trends up over the window; weekends are quieter.
    const progress = (SPAN_DAYS - 1 - i) / (SPAN_DAYS - 1); // 0..1
    const trend = 2 + progress * 6; // ~2 → ~8 per day
    const weekendFactor = isWeekend ? 0.35 : 1;
    const noise = 0.6 + random() * 0.9;
    const count = Math.max(0, Math.round(trend * weekendFactor * noise));

    for (let n = 0; n < count; n++) {
      // Spread leads through business hours (UTC) for the same day.
      const hour = 7 + Math.floor(random() * 11);
      const minute = Math.floor(random() * 60);
      const createdMs = dayMs + hour * 3_600_000 + minute * 60_000;

      // Stage distribution skews toward earlier stages.
      const stageRoll = random();
      const stage =
        stageRoll < 0.4
          ? "New"
          : stageRoll < 0.65
            ? "Qualified"
            : stageRoll < 0.82
              ? "Proposition"
              : stageRoll < 0.92
                ? "Won"
                : "Lost";

      leads.push({
        id: id++,
        createdAt: new Date(createdMs).toISOString(),
        source: pick(SOURCES, random()),
        stage,
        type: random() < 0.55 ? "lead" : "opportunity",
      });
    }
  }

  return leads;
}
