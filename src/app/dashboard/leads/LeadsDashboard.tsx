"use client";

import { useMemo, useState } from "react";
import {
  bucketLeads,
  breakdownBy,
  computeKpis,
  datasetBounds,
  type DateRange,
  type Granularity,
} from "@/lib/leads/aggregate";
import type { Lead, LeadDataSource } from "@/lib/leads/types";
import styles from "./leads.module.css";

interface Props {
  leads: Lead[];
  source: LeadDataSource;
  note: string;
}

const GRANULARITIES: Granularity[] = ["day", "week", "month"];
const BREAKDOWN_DIMS = [
  { key: "source", label: "By source" },
  { key: "stage", label: "By stage" },
  { key: "type", label: "By type" },
] as const;

const numberFmt = new Intl.NumberFormat("en-US");

function formatPct(p: number | null): {
  text: string;
  tone: "up" | "down" | "flat";
} {
  if (p === null) return { text: "—", tone: "flat" };
  const pct = Math.round(p * 1000) / 10;
  if (pct > 0) return { text: `+${pct}%`, tone: "up" };
  if (pct < 0) return { text: `${pct}%`, tone: "down" };
  return { text: "0%", tone: "flat" };
}

/** Pure-SVG vertical bar chart for the time series. */
function TimeSeriesChart({
  data,
}: {
  data: { key: string; label: string; count: number }[];
}) {
  if (data.length === 0) {
    return <p className={styles.empty}>No leads in the selected range.</p>;
  }
  const W = 960;
  const H = 320;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 48;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...data.map((d) => d.count));
  const slot = plotW / data.length;
  const barW = Math.max(1, Math.min(slot * 0.7, 48));
  // Show at most ~12 axis labels to avoid crowding.
  const labelStep = Math.ceil(data.length / 12);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const uniqueTicks = [...new Set(ticks)];

  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Leads over time"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Y gridlines + labels */}
      {uniqueTicks.map((t) => {
        const y = padT + plotH - (t / max) * plotH;
        return (
          <g key={t}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y}
              y2={y}
              className={styles.gridline}
            />
            <text x={padL - 8} y={y + 4} className={styles.axisLabelY}>
              {t}
            </text>
          </g>
        );
      })}
      {/* Bars */}
      {data.map((d, i) => {
        const x = padL + i * slot + (slot - barW) / 2;
        const h = (d.count / max) * plotH;
        const y = padT + plotH - h;
        return (
          <g key={d.key}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={2}
              className={styles.bar}
            >
              <title>{`${d.label}: ${d.count}`}</title>
            </rect>
            {i % labelStep === 0 && (
              <text
                x={x + barW / 2}
                y={H - padB + 18}
                className={styles.axisLabelX}
              >
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal bar list for a breakdown dimension. */
function BreakdownChart({
  data,
}: {
  data: { label: string; count: number }[];
}) {
  if (data.length === 0) {
    return <p className={styles.empty}>No data in the selected range.</p>;
  }
  const max = Math.max(1, ...data.map((d) => d.count));
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <ul className={styles.breakdownList}>
      {data.map((d) => {
        const pct = total === 0 ? 0 : Math.round((d.count / total) * 100);
        return (
          <li key={d.label} className={styles.breakdownRow}>
            <span className={styles.breakdownLabel} title={d.label}>
              {d.label}
            </span>
            <span className={styles.breakdownTrack}>
              <span
                className={styles.breakdownFill}
                style={{ width: `${(d.count / max) * 100}%` }}
              />
            </span>
            <span className={styles.breakdownValue}>
              {numberFmt.format(d.count)}
              <span className={styles.breakdownPct}> · {pct}%</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function LeadsDashboard({ leads, source, note }: Props) {
  const bounds = useMemo(() => datasetBounds(leads), [leads]);
  const [granularity, setGranularity] = useState<Granularity>("week");
  const [dim, setDim] =
    useState<(typeof BREAKDOWN_DIMS)[number]["key"]>("source");
  const [range, setRange] = useState<DateRange>(
    bounds ?? { from: "1970-01-01", to: "1970-01-01" },
  );

  const series = useMemo(
    () => bucketLeads(leads, granularity, range),
    [leads, granularity, range],
  );
  const kpis = useMemo(() => computeKpis(leads, range), [leads, range]);
  const breakdown = useMemo(
    () => breakdownBy(leads, dim, range),
    [leads, dim, range],
  );
  const pop = formatPct(kpis.periodOverPeriod);

  return (
    <main className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Baboo · CRM</p>
          <h1 className={styles.title}>Leads dashboard</h1>
          <p className={styles.subtitle}>Lead trends over time.</p>
        </div>
        <span
          className={`${styles.sourceBadge} ${
            source === "odoo" ? styles.sourceLive : styles.sourceDemo
          }`}
          title={note}
        >
          {source === "odoo" ? "● Live · Odoo" : "● Demo data"}
        </span>
      </header>

      {source === "demo" && (
        <div className={styles.banner} role="status">
          <strong>Demo data.</strong> {note}
        </div>
      )}

      {/* Controls */}
      <section className={styles.controls}>
        <label className={styles.control}>
          <span className={styles.controlLabel}>From</span>
          <input
            type="date"
            className={styles.dateInput}
            value={range.from}
            min={bounds?.from}
            max={range.to}
            onChange={(e) =>
              setRange((r) => ({ ...r, from: e.target.value || r.from }))
            }
          />
        </label>
        <label className={styles.control}>
          <span className={styles.controlLabel}>To</span>
          <input
            type="date"
            className={styles.dateInput}
            value={range.to}
            min={range.from}
            max={bounds?.to}
            onChange={(e) =>
              setRange((r) => ({ ...r, to: e.target.value || r.to }))
            }
          />
        </label>
        <div className={styles.control}>
          <span className={styles.controlLabel}>Granularity</span>
          <div className={styles.segmented}>
            {GRANULARITIES.map((g) => (
              <button
                key={g}
                type="button"
                className={`${styles.segment} ${
                  granularity === g ? styles.segmentActive : ""
                }`}
                onClick={() => setGranularity(g)}
              >
                {g[0].toUpperCase() + g.slice(1)}
              </button>
            ))}
          </div>
        </div>
        {bounds && (
          <button
            type="button"
            className={styles.resetBtn}
            onClick={() => setRange(bounds)}
          >
            Reset range
          </button>
        )}
      </section>

      {/* KPIs */}
      <section className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <p className={styles.kpiLabel}>Total leads (all time)</p>
          <p className={styles.kpiValue}>
            {numberFmt.format(kpis.totalAllTime)}
          </p>
        </div>
        <div className={styles.kpiCard}>
          <p className={styles.kpiLabel}>Leads in period</p>
          <p className={styles.kpiValue}>{numberFmt.format(kpis.inPeriod)}</p>
          <p className={styles.kpiSub}>
            {range.from} → {range.to}
          </p>
        </div>
        <div className={styles.kpiCard}>
          <p className={styles.kpiLabel}>vs previous period</p>
          <p className={`${styles.kpiValue} ${styles[`tone_${pop.tone}`]}`}>
            {pop.text}
          </p>
          <p className={styles.kpiSub}>
            {numberFmt.format(kpis.previousPeriod)} prior
          </p>
        </div>
      </section>

      {/* Time series */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Leads per {granularity}</h2>
        </div>
        <TimeSeriesChart data={series} />
      </section>

      {/* Breakdown */}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Breakdown</h2>
          <div className={styles.segmented}>
            {BREAKDOWN_DIMS.map((d) => (
              <button
                key={d.key}
                type="button"
                className={`${styles.segment} ${
                  dim === d.key ? styles.segmentActive : ""
                }`}
                onClick={() => setDim(d.key)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <BreakdownChart data={breakdown} />
      </section>
    </main>
  );
}
