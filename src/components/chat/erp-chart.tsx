"use client";

import { memo, type ReactNode } from "react";
import type { ErpChart } from "@/types/chat";

/*
 * Charts of "client-diagram" responses, drawn as plain SVG (no chart library): line,
 * vertical-bar and pie, with a legend and the values as a table for reading exact numbers.
 */

const COLORS = ["#79c0ff", "#56d364", "#e3b341", "#ff7b72", "#d2a8ff", "#ffa657", "#39c5cf", "#f778ba"];
const WIDTH = 640;
const HEIGHT = 300;
const PAD = { top: 16, right: 16, bottom: 56, left: 64 };

const format = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const compact = (n: number) => n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
const shorten = (text: string, max = 14) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Rounded axis ticks covering [min, max], always including 0. */
function ticks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const span = hi - lo || 1;
  const step = 10 ** Math.floor(Math.log10(span / 4));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= 5) ?? step * 10;
  const out: number[] = [];
  for (let v = Math.floor(lo / nice) * nice; v <= hi + nice * 0.5; v += nice) out.push(Number(v.toPrecision(12)));
  return out;
}

function Axes({ chart, children }: { chart: ErpChart; children: (scale: { x: (i: number) => number; band: number; y: (v: number) => number }) => ReactNode }) {
  const values = chart.series.flatMap((s) => s.data);
  const yTicks = ticks(Math.min(...values), Math.max(...values));
  const [lo, hi] = [yTicks[0], yTicks.at(-1)!];
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / chart.categories.length;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const x = (i: number) => PAD.left + band * i + band / 2;
  const every = Math.ceil(chart.categories.length / 12);
  return (
    <>
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(t)} y2={y(t)} stroke="rgb(255 255 255 / 0.08)" />
          <text x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted text-[11px]">
            {compact(t)}
          </text>
        </g>
      ))}
      <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(0)} y2={y(0)} stroke="rgb(255 255 255 / 0.3)" />
      {chart.categories.map((c, i) =>
        i % every === 0 ? (
          <text key={i} x={x(i)} y={HEIGHT - PAD.bottom + 18} textAnchor="middle" className="fill-muted text-[11px]">
            <title>{c}</title>
            {shorten(c)}
          </text>
        ) : null,
      )}
      {children({ x, band, y })}
    </>
  );
}

function BarChart({ chart }: { chart: ErpChart }) {
  return (
    <Axes chart={chart}>
      {({ x, band, y }) => {
        const group = band * 0.8;
        const width = group / chart.series.length;
        return chart.series.map((s, si) =>
          s.data.map((v, i) => {
            const left = x(i) - group / 2 + width * si;
            const top = Math.min(y(v), y(0));
            return (
              <rect key={`${si}-${i}`} x={left + 1} y={top} width={Math.max(1, width - 2)} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={2} fill={COLORS[si % COLORS.length]}>
                <title>{`${s.name} · ${chart.categories[i]}: ${format(v)}`}</title>
              </rect>
            );
          }),
        );
      }}
    </Axes>
  );
}

function LineChart({ chart }: { chart: ErpChart }) {
  return (
    <Axes chart={chart}>
      {({ x, y }) =>
        chart.series.map((s, si) => (
          <g key={si}>
            <polyline points={s.data.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth={2} />
            {s.data.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={COLORS[si % COLORS.length]}>
                <title>{`${s.name} · ${chart.categories[i]}: ${format(v)}`}</title>
              </circle>
            ))}
          </g>
        ))
      }
    </Axes>
  );
}

function PieChart({ chart }: { chart: ErpChart }) {
  const data = chart.series[0].data;
  const total = data.reduce((sum, v) => sum + Math.max(0, v), 0);
  const [cx, cy, r] = [WIDTH / 2, HEIGHT / 2, HEIGHT / 2 - 16];
  if (total <= 0) {
    return (
      <text x={cx} y={cy} textAnchor="middle" className="fill-muted text-sm">
        No positive values to show
      </text>
    );
  }
  const shares = data.map((v) => Math.max(0, v) / total);
  // Start angle of each slice, clockwise from 12 o'clock.
  const starts = shares.map((_, i) => -Math.PI / 2 + shares.slice(0, i).reduce((sum, s) => sum + s, 0) * 2 * Math.PI);
  return (
    <>
      {data.map((v, i) => {
        const share = shares[i];
        const start = starts[i];
        const end = start + share * 2 * Math.PI;
        const label = `${chart.categories[i]}: ${format(v)} (${(share * 100).toFixed(1)}%)`;
        if (share >= 0.9999) {
          return (
            <circle key={i} cx={cx} cy={cy} r={r} fill={COLORS[i % COLORS.length]}>
              <title>{label}</title>
            </circle>
          );
        }
        const large = share > 0.5 ? 1 : 0;
        const p = (a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
        return (
          <path key={i} d={`M ${cx} ${cy} L ${p(start)} A ${r} ${r} 0 ${large} 1 ${p(end)} Z`} fill={COLORS[i % COLORS.length]} stroke="var(--color-code)" strokeWidth={1}>
            <title>{label}</title>
          </path>
        );
      })}
    </>
  );
}

export const ErpChartView = memo(function ErpChartView({ chart }: { chart: ErpChart }) {
  const legend = chart.chart_type === "pie" ? chart.categories : chart.series.map((s) => s.name);
  return (
    <figure className="min-w-0 rounded-xl border border-line bg-code p-3">
      <figcaption dir="auto" className="mb-2 font-semibold">
        {chart.title}
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={chart.title}>
        {chart.chart_type === "pie" ? <PieChart chart={chart} /> : chart.chart_type === "line" ? <LineChart chart={chart} /> : <BarChart chart={chart} />}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" dir="auto">
        {legend.map((name, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
            {name}
          </li>
        ))}
      </ul>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted">Values</summary>
        <div className="mt-1 overflow-x-auto">
          <table dir="auto" className="w-full border-collapse text-start">
            <thead>
              <tr className="text-muted">
                <th className="px-2 py-1 text-start font-normal" />
                {chart.series.map((s, i) => (
                  <th key={i} className="px-2 py-1 text-start font-normal">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.categories.map((c, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-2 py-1">{c}</td>
                  {chart.series.map((s, si) => (
                    <td key={si} className="px-2 py-1 tabular-nums">
                      {format(s.data[i])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
});
