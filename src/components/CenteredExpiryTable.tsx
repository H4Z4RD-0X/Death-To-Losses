"use client";
import { useState } from "react";
import type { ChainDisplaySnapshot, ChainDisplayRow } from "@/lib/types";

function numberCell(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function integerCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function signedIntCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const s = Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return value > 0 ? `+${s}` : value < 0 ? `-${s}` : s;
}

/** COI/Volume ratio — how much OI is changing per unit of volume traded.
 *  > 1.0  : Heavy position building (smart money accumulating)
 *  0–1.0  : Normal intraday activity
 *  Negative: Unwinding positions
 */
function coiVolCell(coi: number | null, volume: number | null): string {
  if (coi === null || volume === null || volume <= 0) return "--";
  const ratio = coi / volume;
  return ratio.toFixed(2);
}

function coiClass(coi: number | null): string {
  if (coi === null || !Number.isFinite(coi)) return "";
  if (coi > 0) return "chain-coi-bull";
  if (coi < 0) return "chain-coi-bear";
  return "";
}

function coiVolClass(coi: number | null, volume: number | null): string {
  if (coi === null || volume === null || volume <= 0) return "";
  const ratio = coi / volume;
  if (ratio > 0.5) return "chain-coi-bull";
  if (ratio < -0.5) return "chain-coi-bear";
  return "";
}

type SortMode = "strike" | "ce_oi" | "pe_oi" | "ce_coi" | "pe_coi";

function sortRows(rows: ChainDisplayRow[], mode: SortMode): ChainDisplayRow[] {
  if (mode === "strike") return [...rows].sort((a, b) => a.strike - b.strike);
  if (mode === "ce_oi")  return [...rows].sort((a, b) => (b.ce.oi ?? 0) - (a.ce.oi ?? 0));
  if (mode === "pe_oi")  return [...rows].sort((a, b) => (b.pe.oi ?? 0) - (a.pe.oi ?? 0));
  if (mode === "ce_coi") return [...rows].sort((a, b) => Math.abs(b.ce.coi ?? 0) - Math.abs(a.ce.coi ?? 0));
  if (mode === "pe_coi") return [...rows].sort((a, b) => Math.abs(b.pe.coi ?? 0) - Math.abs(a.pe.coi ?? 0));
  return rows;
}

export function CenteredExpiryTable({ title, snapshot }: { title: string; snapshot: ChainDisplaySnapshot }) {
  const [sortMode, setSortMode] = useState<SortMode>("strike");
  const displayRows = sortRows(snapshot.rows, sortMode);

  return (
    <section className="centered-chain-section">
      <h2>{title}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
        <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>Sort by:</span>
        {(["strike", "ce_oi", "pe_oi", "ce_coi", "pe_coi"] as SortMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setSortMode(m)}
            style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
              border: `1px solid ${sortMode === m ? "var(--accent)" : "var(--line-strong)"}`,
              background: sortMode === m ? "rgba(193,95,60,0.12)" : "transparent",
              color: sortMode === m ? "var(--accent)" : "var(--muted)",
              cursor: "pointer",
            }}
          >
            {m === "strike" ? "Strike (default)" : m === "ce_oi" ? "↓ Call OI" : m === "pe_oi" ? "↓ Put OI" : m === "ce_coi" ? "↓ Call COI" : "↓ Put COI"}
          </button>
        ))}
        <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 4 }}>
          Expiry: <strong style={{ color: "var(--text)" }}>{snapshot.expiryDate ?? "--"}</strong>
          {" "}· Spot: <strong style={{ color: "var(--accent)" }}>{numberCell(snapshot.spot, 2)}</strong>
          {" "}· <em>COI/Vol &gt; 0.5 = Smart Money Building</em>
        </span>
      </div>

      <div className="centered-chain-shell">
        <table className="centered-chain-table">
          <thead>
            <tr>
              <th title="COI ÷ Volume. >0.5 = smart money building. Green = bullish activity. Red = bearish.">CE COI/Vol</th>
              <th title="Change in Call OI since today's open. Positive = new call positions added.">CE COI</th>
              <th title="Total Call open interest — how many call contracts exist at this strike.">CE OI</th>
              <th title="Calls traded today. High volume = active interest.">CE Vol</th>
              <th title="Implied Volatility for call. High IV = expensive option.">CE IV</th>
              <th title="Last traded price of the call option.">CE LTP</th>
              <th className="strike-col" title="The strike price.">Strike</th>
              <th title="Last traded price of the put option.">PE LTP</th>
              <th title="Implied Volatility for put. High IV = expensive option.">PE IV</th>
              <th title="Puts traded today. High volume = active interest.">PE Vol</th>
              <th title="Total Put open interest — how many put contracts exist at this strike.">PE OI</th>
              <th title="Change in Put OI since today's open. Positive = new put positions added.">PE COI</th>
              <th title="COI ÷ Volume. >0.5 = smart money building. Green = bullish activity. Red = bearish.">PE COI/Vol</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.rows.length === 0 ? (
              <tr>
                <td colSpan={13} className="chain-empty-row">
                  Chain data unavailable — waiting for first live snapshot.
                </td>
              </tr>
            ) : null}
            {displayRows.map((row) => (
              <tr key={row.strike} className={row.isSpotRow ? "spot-anchor-row" : ""}>
                <td className={coiVolClass(row.ce.coi ?? null, row.ce.volume)}>{coiVolCell(row.ce.coi ?? null, row.ce.volume)}</td>
                <td className={coiClass(row.ce.coi ?? null)}>{signedIntCell(row.ce.coi ?? null)}</td>
                <td>{integerCell(row.ce.oi)}</td>
                <td>{integerCell(row.ce.volume)}</td>
                <td>{numberCell(row.ce.iv, 2)}</td>
                <td>{numberCell(row.ce.ltp, 2)}</td>
                <td className="strike-col">{row.strike}</td>
                <td>{numberCell(row.pe.ltp, 2)}</td>
                <td>{numberCell(row.pe.iv, 2)}</td>
                <td>{integerCell(row.pe.volume)}</td>
                <td>{integerCell(row.pe.oi)}</td>
                <td className={coiClass(row.pe.coi ?? null)}>{signedIntCell(row.pe.coi ?? null)}</td>
                <td className={coiVolClass(row.pe.coi ?? null, row.pe.volume)}>{coiVolCell(row.pe.coi ?? null, row.pe.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

