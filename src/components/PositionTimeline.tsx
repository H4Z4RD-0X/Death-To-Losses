"use client";

import { useMemo, useState } from "react";
import { type SmartMoneyPosition, SIGNAL_LABELS, SIGNAL_BIAS } from "@/lib/positionTracker";
import type { SignalKind } from "@/lib/types";

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function fmtDuration(minutes: number | null): string {
  if (minutes === null) return "ongoing";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fmtOiDelta(lots: number | null): string {
  if (lots === null || !Number.isFinite(lots)) return "—";
  const sign = lots > 0 ? "+" : "";
  const abs = Math.abs(lots);
  if (abs >= 1000) return `${sign}${(lots / 1000).toFixed(1)}K`;
  return `${sign}${lots.toFixed(0)}`;
}

function fmtSpot(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(2);
}

function fmtMove(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)} pts`;
}

function signalBias(kind: SignalKind): "BULLISH" | "BEARISH" {
  return SIGNAL_BIAS[kind] === "BEARISH" ? "BEARISH" : "BULLISH";
}

/* How many candles → accumulation label */
function accumLabel(n: number): { text: string; tier: "fire" | "strong" | "mid" | "weak" } {
  if (n >= 10) return { text: `🔥 ${n} candles`, tier: "fire" };
  if (n >= 5)  return { text: `${n} candles`,    tier: "strong" };
  if (n >= 3)  return { text: `${n} candles`,    tier: "mid" };
  return        { text: `${n} candle`,            tier: "weak" };
}

/* ─── filter bar config ───────────────────────────────────────────────────── */

const FILTERS = [
  { label: "All",          value: "ALL" },
  { label: "🔴 Live",      value: "LIVE" },
  { label: "3c+ Builds",   value: "SUSTAINED" },
  { label: "Bullish",      value: "BULLISH" },
  { label: "Bearish",      value: "BEARISH" },
  { label: "Put Writing",  value: "PUT_WRITING" },
  { label: "Call Cover",   value: "CALL_SHORT_COVERING" },
  { label: "Dir. Buying",  value: "DIRECTIONAL_OPTION_BUYING" },
  { label: "Put Unwind",   value: "PUT_WRITING_UNWIND" },
] as const;

function applyFilter(positions: SmartMoneyPosition[], filter: string): SmartMoneyPosition[] {
  switch (filter) {
    case "LIVE":      return positions.filter((p) => p.isActive);
    case "SUSTAINED": return positions.filter((p) => p.sampleCount >= 3);
    case "BULLISH":   return positions.filter((p) => signalBias(p.signalKind) === "BULLISH");
    case "BEARISH":   return positions.filter((p) => signalBias(p.signalKind) === "BEARISH");
    case "PUT_WRITING":
    case "CALL_SHORT_COVERING":
    case "DIRECTIONAL_OPTION_BUYING":
    case "PUT_WRITING_UNWIND":
      return positions.filter((p) => p.signalKind === filter);
    default: return positions;
  }
}

/* ─── single position card ────────────────────────────────────────────────── */

function PositionCard({ pos }: { pos: SmartMoneyPosition }): React.ReactNode {
  const bias = signalBias(pos.signalKind);
  const isBull = bias === "BULLISH";
  const accum = accumLabel(pos.sampleCount);

  return (
    <div className={`ptl-card ${isBull ? "ptl-bull" : "ptl-bear"}${pos.isActive ? " ptl-live" : ""}`}>

      {/* Left accent stripe */}
      <div className="ptl-stripe" />

      {/* Timestamp block */}
      <div className="ptl-ts-block">
        <div className="ptl-date">{pos.tradeDate}</div>
        <div className="ptl-time">{pos.entryDisplayTime}</div>
        {pos.isActive ? (
          <div className="ptl-live-dot">● LIVE</div>
        ) : (
          <div className="ptl-exit-time">→ {pos.exitDisplayTime ?? "—"}</div>
        )}
      </div>

      {/* Signal block */}
      <div className="ptl-signal-block">
        <div className={`ptl-bias-badge ${isBull ? "ptl-bias-bull" : "ptl-bias-bear"}`}>
          {bias}
        </div>
        <div className="ptl-signal-name">
          {SIGNAL_LABELS[pos.signalKind] ?? pos.signalKind.replaceAll("_", " ")}
        </div>
        <div className="ptl-side">{pos.side} leg</div>
      </div>

      {/* Duration + accumulation */}
      <div className="ptl-accum-block">
        <div className={`ptl-accum-badge ptl-accum-${accum.tier}`}>{accum.text}</div>
        <div className="ptl-duration">{fmtDuration(pos.durationMinutes)}</div>
        <div className="ptl-conf">
          Conf: <strong>{pos.avgConfidence}%</strong> avg / <strong>{pos.peakConfidence.toFixed(0)}%</strong> peak
        </div>
      </div>

      {/* OI delta block */}
      <div className="ptl-oi-block">
        <div className="ptl-oi-row">
          <span className="ptl-oi-label">CE OI Δ</span>
          <span className={`ptl-oi-val ${pos.ceOiDelta === null ? "" : pos.ceOiDelta > 0 ? "ptl-pos" : "ptl-neg"}`}>
            {fmtOiDelta(pos.ceOiDelta)}
          </span>
        </div>
        <div className="ptl-oi-row">
          <span className="ptl-oi-label">PE OI Δ</span>
          <span className={`ptl-oi-val ${pos.peOiDelta === null ? "" : pos.peOiDelta > 0 ? "ptl-pos" : "ptl-neg"}`}>
            {fmtOiDelta(pos.peOiDelta)}
          </span>
        </div>
        <div className="ptl-oi-row">
          <span className="ptl-oi-label">Spot Δ</span>
          <span className={`ptl-oi-val ${pos.spotMove === null ? "" : pos.spotMove > 0 ? "ptl-pos" : pos.spotMove < 0 ? "ptl-neg" : ""}`}>
            {fmtMove(pos.spotMove)}
          </span>
        </div>
      </div>

      {/* Entry spot */}
      <div className="ptl-spot-block">
        <div className="ptl-spot-label">Entry Spot</div>
        <div className="ptl-spot-val">{fmtSpot(pos.entrySpot)}</div>
        {!pos.isActive && pos.lastSpot !== null && (
          <>
            <div className="ptl-spot-label" style={{ marginTop: 4 }}>Last Spot</div>
            <div className="ptl-spot-val">{fmtSpot(pos.lastSpot)}</div>
          </>
        )}
      </div>

    </div>
  );
}

/* ─── main component ──────────────────────────────────────────────────────── */

interface Props {
  positions: SmartMoneyPosition[];
  strike: number;
  loading?: boolean;
}

export function PositionTimeline({ positions, strike, loading = false }: Props): React.ReactNode {
  const [filter, setFilter] = useState<string>("ALL");
  const [showAll, setShowAll]   = useState<boolean>(false);

  const filtered  = useMemo(() => applyFilter(positions, filter), [positions, filter]);
  const displayed = showAll ? filtered : filtered.slice(0, 20);
  const hasMore   = filtered.length > 20;

  const activeCount  = positions.filter((p) => p.isActive).length;
  const bullCount    = positions.filter((p) => signalBias(p.signalKind) === "BULLISH").length;
  const bearCount    = positions.filter((p) => signalBias(p.signalKind) === "BEARISH").length;

  return (
    <section className="ptl-section">

      {/* Header */}
      <div className="ptl-header">
        <div>
          <h2>Smart Money Position Log</h2>
          <p className="ptl-subtitle">
            Strike <strong>{strike}</strong> — exact timestamps when big-player signals were active.
            Each block = one continuous signal run across 3-min captures.
            Entry time is when the signal first fired; exit is when it changed or went neutral.
          </p>
        </div>

        {/* Quick stats */}
        <div className="ptl-quick-stats">
          <div className="ptl-qs">
            <div className="ptl-qs-num">{positions.length}</div>
            <div className="ptl-qs-label">Total</div>
          </div>
          <div className="ptl-qs ptl-qs-bull">
            <div className="ptl-qs-num">{bullCount}</div>
            <div className="ptl-qs-label">Bullish</div>
          </div>
          <div className="ptl-qs ptl-qs-bear">
            <div className="ptl-qs-num">{bearCount}</div>
            <div className="ptl-qs-label">Bearish</div>
          </div>
          {activeCount > 0 && (
            <div className="ptl-qs ptl-qs-live">
              <div className="ptl-qs-num ptl-blink">{activeCount}</div>
              <div className="ptl-qs-label">Live</div>
            </div>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="ptl-filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={`ptl-filter-btn${filter === f.value ? " ptl-filter-active" : ""}`}
            onClick={() => { setFilter(f.value); setShowAll(false); }}
          >
            {f.label}
          </button>
        ))}
        {loading && <span className="ptl-loading-tag">Refreshing…</span>}
      </div>

      {/* Cards feed */}
      {displayed.length === 0 ? (
        <div className="ptl-empty">
          {positions.length === 0
            ? "No positions yet — they appear once 3-min candle history accumulates (usually after the first few polls)."
            : "No positions match the current filter."}
        </div>
      ) : (
        <div className="ptl-feed">
          {displayed.map((pos) => <PositionCard key={pos.id} pos={pos} />)}
        </div>
      )}

      {hasMore && !showAll && (
        <button
          className="ptl-show-more"
          onClick={() => setShowAll(true)}
        >
          Show all {filtered.length} positions ↓
        </button>
      )}

    </section>
  );
}
