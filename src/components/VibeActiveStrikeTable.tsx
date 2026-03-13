import type { VibeStrikeView } from "@/lib/types";

function signed(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function intentLabel(row: VibeStrikeView): { label: string; cls: string } {
  const ce = row.ce.halchalRatio ?? 0;
  const pe = row.pe.halchalRatio ?? 0;
  if (ce > 0 && pe < 0) return { label: "CE PRESSURE ↓", cls: "ce-pressure" };
  if (pe > 0 && ce < 0) return { label: "PE PRESSURE ↑", cls: "pe-pressure" };
  if (ce > 0 && pe > 0) return { label: "BOTH ACTIVE",   cls: "neutral" };
  return { label: "NEUTRAL", cls: "neutral" };
}

export function VibeActiveStrikeTable({
  rows,
  hideInactive = true,
}: {
  rows: VibeStrikeView[];
  hideInactive?: boolean;
}) {
  const displayed = hideInactive
    ? rows.filter((r) => (r.smartActivityScore ?? 0) >= 0.05)
    : rows;

  return (
    <section className="hero-strikes-section">
      <h2>⚡ Big-Money Footprint — Active Strikes Right Now</h2>
      <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--muted)" }}>
        Only strikes with smart-money activity shown. CE/PE Halchal = rate-of-change ratio — positive means fresh contracts opening; negative means positions closing.
        Intent = who is under pressure. Activity Score = combined signal strength.
      </p>
      {displayed.length === 0 ? (
        <p className="hast-empty">
          {rows.length === 0
            ? "Waiting for first vibe snapshot…"
            : "No active strikes above threshold. All position changes are minimal."}
        </p>
      ) : (
        <div className="hast-table-shell">
          <table className="hast-table">
            <thead>
              <tr>
                <th>Strike</th>
                <th title="CE Halchal Ratio — Rate of change in call OI vs volume">CE Halchal</th>
                <th title="PE Halchal Ratio — Rate of change in put OI vs volume">PE Halchal</th>
                <th title="Who is being pressured — CE/PE PRESSURE shows which side is seeing aggressive positioning">Intent</th>
                <th title="Activity intensity map (0-10). High clustering means aggressive concentrated action.">Clustering</th>
                <th title="Overall smart-money activity score 0–10">Activity Score</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((row) => {
                const intent = intentLabel(row);
                const score = row.smartActivityScore ?? 0;
                const scoreBarPct = Math.min((score / 10) * 100, 100);
                const inactive = score < 0.05;
                const ceVal = row.ce.halchalRatio;
                const peVal = row.pe.halchalRatio;
                return (
                  <tr key={row.strike} className={inactive ? "row-inactive" : undefined}>
                    <td className="hast-strike">{row.strike}</td>
                    <td className={
                      ceVal === null ? "hast-neutral"
                      : ceVal > 0 ? "hast-ce-pos" : "hast-ce-neg"
                    }>
                      {signed(ceVal)}
                    </td>
                    <td className={
                      peVal === null ? "hast-neutral"
                      : peVal > 0 ? "hast-pe-pos" : "hast-pe-neg"
                    }>
                      {signed(peVal)}
                    </td>
                    <td>
                      <span className={`hast-intent ${intent.cls}`}>{intent.label}</span>
                    </td>
                    <td>
                      <div className="hast-score-wrap cluster-wrap">
                        <div className="hast-score-track">
                          <div
                            className="hast-score-fill cluster-fill"
                            style={{ width: `${Math.min(((row.clusteringCoeff ?? 0) / 10) * 100, 100)}%` }}
                          />
                        </div>
                        <span className="hast-score-num">{(row.clusteringCoeff ?? 0).toFixed(1)}</span>
                      </div>
                    </td>
                    <td>
                      <div className="hast-score-wrap">
                        <div className="hast-score-track">
                          <div
                            className="hast-score-fill"
                            style={{ width: `${scoreBarPct}%` }}
                          />
                        </div>
                        <span className="hast-score-num">{score.toFixed(1)}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
