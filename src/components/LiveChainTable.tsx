"use client";

import { useCallback } from "react";
import type React from "react";
import type { SnapshotRow } from "@/lib/types";
import { classifyLegReading } from "@/lib/legReading";

/* ── tiny formatters ─────────────────────────────────────────────────────── */
function n(v: number | null, d = 0): string {
  if (v === null || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function s(v: number | null, d = 1): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
function ar(v: number | null): string {
  if (v === null || Math.abs(v ?? 0) < 0.000001) return "•";
  return v! > 0 ? "▲" : "▼";
}
function arCls(v: number | null): string {
  if (v === null || Math.abs(v ?? 0) < 0.000001) return "arrow-flat";
  return v! > 0 ? "arrow-up" : "arrow-down";
}
function vc(v: number | null): string {
  if (v === null) return "cell-neutral";
  return v > 0 ? "cell-pos" : v < 0 ? "cell-neg" : "cell-neutral";
}
function pc(v: number | null): string {
  if (v === null) return "";
  return Math.abs(v) < 1 ? "efficiency-noise" : Math.abs(v) > 4 ? "efficiency-alert" : "";
}
function posOf(leg: SnapshotRow["ce"]): number | null {
  return leg.positional ?? leg.halchalRatio ?? leg.coiVol ?? null;
}

/* ── Intensity gradient ───────────────────────────────────────────────────── */
function rowIntensity(row: SnapshotRow): number {
  const conf    = (row.signal.confidence ?? 0) / 100;
  const ceI     = Math.min(Math.abs(row.ce.intraday ?? 0), 25) / 25;
  const peI     = Math.min(Math.abs(row.pe.intraday ?? 0), 25) / 25;
  const ceP     = Math.min(Math.abs(posOf(row.ce) ?? 0), 12) / 12;
  const peP     = Math.min(Math.abs(posOf(row.pe) ?? 0), 12) / 12;
  const pressure   = Math.max(ceI, peI);
  const positional = Math.max(ceP, peP);
  return Math.min(1, conf * 0.35 + pressure * 0.40 + positional * 0.25);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function intensityStyle(_score: number): React.CSSProperties { return {}; }

function keyMetricStyle(score: number): React.CSSProperties {
  if (score < 0.30) return {};
  if (score < 0.55) return { fontWeight: 600 };
  if (score < 0.75) return { fontWeight: 700, color: "var(--accent)" };
  return               { fontWeight: 800, color: "var(--accent)", textShadow: "0 0 6px rgba(193,95,60,0.35)" };
}

/* ── Unified read label ──────────────────────────────────────────────────── */
const UNIFIED_MAP: Record<string, string> = {
  "CALL_WRITING_BUILDUP":    "Smart Selling Calls",
  "PUT_WRITING_BUILDUP":     "Smart Selling Puts",
  "PANIC_COVERING":          "Panic Unwind",
  "EXCHANGE_OF_HANDS":       "Ownership Shift",
  "AGGRESSIVE_PUT_HEDGING":  "Put Hedge Rush",
  "AGGRESSIVE_CALL_BUYING":  "Call Buying Spree",
  "BULL_BUILDUP":            "Bull Position Build",
  "BEAR_BUILDUP":            "Bear Position Build",
  "NEUTRAL_DRIFT":           "Sideways Drift",
};

function unifiedLabel(row: SnapshotRow): string {
  const kind = row.signal.kind;
  const verdict = row.market.verdict ?? "";
  const base = UNIFIED_MAP[kind] ?? kind.replaceAll("_", " ");
  if (verdict && verdict.length > 0 && verdict !== "UNDEFINED") {
    return `${base} · ${verdict.replaceAll("_", " ")}`;
  }
  return base;
}

/* ── CSV export ──────────────────────────────────────────────────────────── */
function exportToCsv(rows: SnapshotRow[], strike: number) {
  const H = [
    "Time","Strike","Spot",
    "CE OI","CE OI-ROC","CE Volume","CE Vol-ROC","CE IV","CE IV-ROC","CE LTP","CE Positional","CE Intraday","CE Reading",
    "PE OI","PE OI-ROC","PE Volume","PE Vol-ROC","PE IV","PE IV-ROC","PE LTP","PE Positional","PE Intraday","PE Reading",
    "Signal","Confidence %","Regime","Unified Read",
  ].join(",");

  const csv = [
    H,
    ...rows.map((r) => {
      const ceR = classifyLegReading("CE", r.ce);
      const peR = classifyLegReading("PE", r.pe);
      const esc = (v: string) => v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v;
      return [
        r.displayTime, r.strike, r.spot ?? "",
        r.ce.oi ?? "", r.ce.oiRoc ?? "", r.ce.volume ?? "", r.ce.volumeRoc ?? "",
        r.ce.iv ?? "", r.ce.ivRoc ?? "", r.ce.ltp ?? "", posOf(r.ce) ?? "", r.ce.intraday ?? "", esc(ceR),
        r.pe.oi ?? "", r.pe.oiRoc ?? "", r.pe.volume ?? "", r.pe.volumeRoc ?? "",
        r.pe.iv ?? "", r.pe.ivRoc ?? "", r.pe.ltp ?? "", posOf(r.pe) ?? "", r.pe.intraday ?? "", esc(peR),
        esc(r.signal.kind.replaceAll("_"," ")), r.signal.confidence.toFixed(1), esc(r.market.verdict),
        esc(unifiedLabel(r)),
      ].join(",");
    }),
  ].join("\n");

  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `NIFTY-${strike}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ── Component ────────────────────────────────────────────────────────────── */
export function LiveChainTable({
  rows,
  strike = 0,
  filterConf,
  maxRows,
}: {
  rows: SnapshotRow[];
  strike?: number;
  /** Only show rows where confidence >= this value */
  filterConf?: number;
  /** Only show the last N rows */
  maxRows?: number;
}) {
  // Apply filters — data is NOT changed, only rendered subset
  let displayed = rows;
  if (filterConf !== undefined) {
    displayed = displayed.filter((r) => r.signal.confidence >= filterConf);
  }
  if (maxRows !== undefined) {
    displayed = displayed.slice(-maxRows);
  }

  const doExport = useCallback(() => exportToCsv(rows, strike), [rows, strike]);

  return (
    <div className="lct-wrap">
      {/* toolbar */}
      <div className="lct-toolbar">
        <span className="lct-count">
          {displayed.length} of {rows.length} captures shown
        </span>
        <button
          type="button"
          className="export-btn"
          onClick={doExport}
          disabled={rows.length === 0}
          title="Download all rows as CSV — opens in Excel"
        >
          ⬇ Export CSV
        </button>
      </div>

      <div className="table-shell lct-shell">
        <table className="chain-table timeline-table lct-table">
          <thead>
            <tr>
              {/* CE side */}
              <th title="Time of capture">TIME</th>
              <th title="Call OI: total open contracts. Arrow = direction vs last capture">C-OI ↕</th>
              <th title="Change in Call OI % vs last capture. + = new contracts opened (smart money entering)">ΔC-OI</th>
              <th title="Call Volume traded in this window">C-VOL</th>
              <th title="Call Implied Volatility — higher IV = more uncertainty priced in">C-IV</th>
              <th title="Change in Call IV. Negative = IV falling while OI rising = calm conviction">ΔC-IV</th>
              <th title="Call Last Traded Price">C-LTP</th>
              <th title="CE Positional Ratio — > 1 = smart money building long-term positions">C-POS</th>
              <th title="CE Intraday pressure ratio">C-INT</th>
              <th title="Smart money reading for Call side at this capture">CE SIGNAL</th>
              {/* PE side */}
              <th title="Put OI: total open contracts. Arrow = direction vs last capture">P-OI ↕</th>
              <th title="Change in Put OI % vs last capture. + = new hedges/puts being built">ΔP-OI</th>
              <th title="Put Volume traded in this window">P-VOL</th>
              <th title="Put Implied Volatility">P-IV</th>
              <th title="Change in Put IV">ΔP-IV</th>
              <th title="Put Last Traded Price">P-LTP</th>
              <th title="PE Positional Ratio">P-POS</th>
              <th title="PE Intraday pressure ratio">P-INT</th>
              <th title="Smart money reading for Put side">PE SIGNAL</th>
              {/* Combined — now unified read */}
              <th title="Strike + unified reconciled signal label">STRIKE / UNIFIED READ</th>
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 ? (
              <tr>
                <td colSpan={20} style={{ textAlign: "center", padding: "20px", color: "var(--muted)" }}>
                  {rows.length === 0
                    ? "No captures yet for this session. Data appears every ~3 minutes once market is open."
                    : "No rows match the active filter. Try clearing the filter."}
                </td>
              </tr>
            ) : displayed.map((row) => {
              const ceR    = classifyLegReading("CE", row.ce);
              const peR    = classifyLegReading("PE", row.pe);
              const ceP    = posOf(row.ce);
              const peP    = posOf(row.pe);
              const intensity = rowIntensity(row);
              const km        = keyMetricStyle(intensity);
              const unified   = unifiedLabel(row);
              return (
                <tr key={row.id}>
                  <td className="time-col">{row.displayTime}</td>

                  {/* CE OI */}
                  <td className={`timeline-arrow-cell ${vc(row.ce.oi)}`}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.ce.oiRoc)}`}>{ar(row.ce.oiRoc)}</span>
                      <span>{n(row.ce.oi)}</span>
                    </span>
                  </td>
                  <td className={vc(row.ce.oiRoc)}>{s(row.ce.oiRoc)}</td>
                  <td className={vc(row.ce.volume)}>{n(row.ce.volume)}</td>
                  <td>{n(row.ce.iv, 2)}</td>
                  <td className={vc(row.ce.ivRoc)}>{s(row.ce.ivRoc)}</td>
                  <td className={vc(row.ce.ltp)}>{n(row.ce.ltp, 2)}</td>
                  <td className={`${vc(ceP)} ${pc(ceP)}`} style={km}>{s(ceP, 2)}</td>
                  <td className={`timeline-arrow-cell ${vc(row.ce.intraday)}`} style={km}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.ce.intraday)}`}>{ar(row.ce.intraday)}</span>
                      <span>{s(row.ce.intraday, 3)}</span>
                    </span>
                  </td>
                  <td className="timeline-side-reading ce-reading" style={km}>{ceR}</td>

                  {/* PE OI */}
                  <td className={`timeline-arrow-cell ${vc(row.pe.oi)}`}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.pe.oiRoc)}`}>{ar(row.pe.oiRoc)}</span>
                      <span>{n(row.pe.oi)}</span>
                    </span>
                  </td>
                  <td className={vc(row.pe.oiRoc)}>{s(row.pe.oiRoc)}</td>
                  <td className={vc(row.pe.volume)}>{n(row.pe.volume)}</td>
                  <td>{n(row.pe.iv, 2)}</td>
                  <td className={vc(row.pe.ivRoc)}>{s(row.pe.ivRoc)}</td>
                  <td className={vc(row.pe.ltp)}>{n(row.pe.ltp, 2)}</td>
                  <td className={`${vc(peP)} ${pc(peP)}`} style={km}>{s(peP, 2)}</td>
                  <td className={`timeline-arrow-cell ${vc(row.pe.intraday)}`} style={km}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.pe.intraday)}`}>{ar(row.pe.intraday)}</span>
                      <span>{s(row.pe.intraday, 3)}</span>
                    </span>
                  </td>
                  <td className="timeline-side-reading pe-reading" style={km}>{peR}</td>

                  {/* Unified Signal */}
                  <td className="timeline-reading-cell" style={km}>
                    <span className="lct-strike">{row.strike}</span>
                    <div className="lct-unified">
                      <span className="lct-unified-kind">{row.signal.kind.replaceAll("_", " ")}</span>
                      <span className="lct-unified-label">{unified}</span>
                    </div>
                    <small className="lct-verdict" style={{ display: "none" }}>{row.market.verdict}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
