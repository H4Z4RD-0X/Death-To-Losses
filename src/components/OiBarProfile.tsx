"use client";

import type { ChainDisplaySnapshot } from "@/lib/types";

const BAR_MAX_PX = 140; // px — max bar width on each side

function fmtOi(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

interface Props {
  snapshot: ChainDisplaySnapshot;
}

export function OiBarProfile({ snapshot }: Props) {
  const rows = snapshot.rows.filter(
    (r) => (r.ce.oi ?? 0) > 0 || (r.pe.oi ?? 0) > 0,
  );

  if (rows.length === 0) {
    return <p className="oibp-empty">No chain data yet — waiting for first snapshot.</p>;
  }

  const maxOi = Math.max(...rows.flatMap((r) => [r.ce.oi ?? 0, r.pe.oi ?? 0]));

  const maxCeRow = rows.reduce(
    (best, r) => ((r.ce.oi ?? 0) > (best.ce.oi ?? 0) ? r : best),
    rows[0],
  );
  const maxPeRow = rows.reduce(
    (best, r) => ((r.pe.oi ?? 0) > (best.pe.oi ?? 0) ? r : best),
    rows[0],
  );

  return (
    <div className="oibp-wrap">
      {/* ── Legend header ──────────────────────────────────────────── */}
      <div className="oibp-legend-row">
        <span className="oibp-pe-legend">▬ Put OI (Support Below)</span>
        <span className="oibp-center-legend">STRIKE</span>
        <span className="oibp-ce-legend">Call OI (Resistance Above) ▬</span>
      </div>

      {/* ── Strike rows ────────────────────────────────────────────── */}
      {rows.map((row) => {
        const ceOi = row.ce.oi ?? 0;
        const peOi = row.pe.oi ?? 0;
        const ceW  = maxOi > 0 ? Math.round((ceOi / maxOi) * BAR_MAX_PX) : 0;
        const peW  = maxOi > 0 ? Math.round((peOi / maxOi) * BAR_MAX_PX) : 0;
        const isSpot   = row.isSpotRow;
        const isCeWall = row.strike === maxCeRow.strike;
        const isPeWall = row.strike === maxPeRow.strike;

        // Banner label above the row for walls — avoids overlap
        const wallBanner = isSpot
          ? <div className="oibp-banner oibp-banner-spot">◄ CURRENT PRICE (SPOT)</div>
          : isCeWall
          ? <div className="oibp-banner oibp-banner-ce">🔴 CALL WALL — Strong Resistance Here</div>
          : isPeWall
          ? <div className="oibp-banner oibp-banner-pe">🟢 PUT WALL — Strong Support Here</div>
          : null;

        return (
          <div key={row.strike} className="oibp-row-group">
            {wallBanner}
            <div
              className={`oibp-row${isSpot ? " oibp-spot-row" : ""}${isCeWall ? " oibp-ce-wall-row" : ""}${isPeWall ? " oibp-pe-wall-row" : ""}`}
            >
              {/* PE side — bar grows right-to-left */}
              <div className="oibp-pe-side">
                {peOi > 0 && <span className="oibp-oi-num">{fmtOi(peOi)}</span>}
                <div className="oibp-bar oibp-bar-pe" style={{ width: peW }} />
              </div>

              {/* Strike center */}
              <div className="oibp-strike-cell">
                {row.strike}
              </div>

              {/* CE side — bar grows left-to-right */}
              <div className="oibp-ce-side">
                <div className="oibp-bar oibp-bar-ce" style={{ width: ceW }} />
                {ceOi > 0 && <span className="oibp-oi-num">{fmtOi(ceOi)}</span>}
              </div>
            </div>
          </div>
        );
      })}

      {/* ── Footer callout ─────────────────────────────────────────── */}
      <div className="oibp-footer">
        {snapshot.spot && (
          <span>Current Price: <strong>{snapshot.spot.toFixed(1)}</strong></span>
        )}
        <span className="oibp-footer-ce">
          🔴 Call Wall (Resistance): <strong>{maxCeRow.strike}</strong>
          {" "}— {fmtOi(maxCeRow.ce.oi ?? 0)} contracts written here. Price likely to stall/reverse below this.
        </span>
        <span className="oibp-footer-pe">
          🟢 Put Wall (Support): <strong>{maxPeRow.strike}</strong>
          {" "}— {fmtOi(maxPeRow.pe.oi ?? 0)} contracts here. Price likely to bounce from above this.
        </span>
      </div>
    </div>
  );
}
