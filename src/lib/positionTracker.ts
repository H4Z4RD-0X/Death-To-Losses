import type { SignalKind, SignalSide, SnapshotRow } from "@/lib/types";

/**
 * A smart money position: one or more consecutive 3-min candles where the
 * same non-NEUTRAL signal fires at confidence ≥ 56%.
 *
 * Entry = first candle of the run.
 * Exit  = first candle where signal changes or drops below threshold.
 * isActive = true when the position has no exit yet (still open).
 */
export interface SmartMoneyPosition {
  id: string;
  tradeDate: string;
  strike: number;
  signalKind: SignalKind;
  side: SignalSide;
  /** IST ISO timestamp of the first matching candle */
  entryTimestampIso: string;
  entryDisplayTime: string;
  /** IST ISO timestamp of the last candle still in this position (not the exit candle) */
  lastTimestampIso: string;
  lastDisplayTime: string;
  /** Null when position is still active */
  exitTimestampIso: string | null;
  exitDisplayTime: string | null;
  /** Minutes from entry to exit (null if active) */
  durationMinutes: number | null;
  /** How many 3-min candles this position spans */
  sampleCount: number;
  peakConfidence: number;
  avgConfidence: number;
  entrySpot: number | null;
  lastSpot: number | null;
  /** lastSpot − entrySpot (null if only one candle or spot unknown) */
  spotMove: number | null;
  /** OI in lots at entry */
  entryCeOi: number | null;
  entryPeOi: number | null;
  /** OI in lots at last captured candle */
  lastCeOi: number | null;
  lastPeOi: number | null;
  /** Change in OI from entry to last captured candle */
  ceOiDelta: number | null;
  peOiDelta: number | null;
  isActive: boolean;
}

function closePositionWith(
  pos: SmartMoneyPosition,
  exitRow: SnapshotRow,
  confidenceSum: number
): void {
  pos.lastTimestampIso = exitRow.timestampIso;
  pos.lastDisplayTime = exitRow.displayTime;
  pos.lastSpot = exitRow.spot;
  pos.lastCeOi = exitRow.ce.oi;
  pos.lastPeOi = exitRow.pe.oi;
  pos.ceOiDelta =
    pos.lastCeOi !== null && pos.entryCeOi !== null ? pos.lastCeOi - pos.entryCeOi : null;
  pos.peOiDelta =
    pos.lastPeOi !== null && pos.entryPeOi !== null ? pos.lastPeOi - pos.entryPeOi : null;
  pos.spotMove =
    pos.lastSpot !== null && pos.entrySpot !== null
      ? Math.round((pos.lastSpot - pos.entrySpot) * 100) / 100
      : null;
  pos.avgConfidence =
    pos.sampleCount > 0 ? Math.round(confidenceSum / pos.sampleCount) : pos.peakConfidence;
}

/**
 * Groups rows (newest-first from the API) into smart money positions.
 * Returns positions sorted newest-first.
 *
 * A position starts when:
 *   - signal.kind !== "NEUTRAL"
 *   - signal.confidence >= 56
 *
 * A position ends when:
 *   - signal changes to a different kind
 *   - signal drops to NEUTRAL or confidence < 56
 */
export function groupPositions(rows: SnapshotRow[]): SmartMoneyPosition[] {
  if (rows.length === 0) {
    return [];
  }

  // Sort chronologically (oldest first) — rows from the API are newest-first.
  const chronological = [...rows].sort(
    (a, b) => new Date(a.timestampIso).getTime() - new Date(b.timestampIso).getTime()
  );

  const positions: SmartMoneyPosition[] = [];
  let current: SmartMoneyPosition | null = null;
  let confidenceSum = 0;

  for (const row of chronological) {
    const { kind, side, confidence } = row.signal;
    const signalActive = kind !== "NEUTRAL" && confidence >= 56;

    if (!signalActive) {
      // Signal is off — close the open position and mark it as closed.
      if (current) {
        closePositionWith(current, row, confidenceSum);
        current.exitTimestampIso = row.timestampIso;
        current.exitDisplayTime = row.displayTime;
        const entryMs = new Date(current.entryTimestampIso).getTime();
        const exitMs = new Date(row.timestampIso).getTime();
        current.durationMinutes = Math.round((exitMs - entryMs) / 60_000);
        current.isActive = false;
        positions.push(current);
        current = null;
        confidenceSum = 0;
      }
      continue;
    }

    if (!current || current.signalKind !== kind) {
      // Signal changed — close old position then open a new one.
      if (current) {
        closePositionWith(current, row, confidenceSum);
        current.exitTimestampIso = row.timestampIso;
        current.exitDisplayTime = row.displayTime;
        const entryMs2 = new Date(current.entryTimestampIso).getTime();
        const exitMs2 = new Date(row.timestampIso).getTime();
        current.durationMinutes = Math.round((exitMs2 - entryMs2) / 60_000);
        current.isActive = false;
        positions.push(current);
        confidenceSum = 0;
      }

      const tradeDate = row.timestampIso.slice(0, 10);
      current = {
        id: `${row.timestampIso}-${row.strike}-${kind}`,
        tradeDate,
        strike: row.strike,
        signalKind: kind,
        side,
        entryTimestampIso: row.timestampIso,
        entryDisplayTime: row.displayTime,
        lastTimestampIso: row.timestampIso,
        lastDisplayTime: row.displayTime,
        exitTimestampIso: null,
        exitDisplayTime: null,
        durationMinutes: null,
        sampleCount: 1,
        peakConfidence: confidence,
        avgConfidence: confidence,
        entrySpot: row.spot,
        lastSpot: row.spot,
        spotMove: null,
        entryCeOi: row.ce.oi,
        entryPeOi: row.pe.oi,
        lastCeOi: row.ce.oi,
        lastPeOi: row.pe.oi,
        ceOiDelta: null,
        peOiDelta: null,
        isActive: true
      };
      confidenceSum = confidence;
    } else {
      // Same signal — extend the current position.
      current.sampleCount += 1;
      current.peakConfidence = Math.max(current.peakConfidence, confidence);
      current.lastTimestampIso = row.timestampIso;
      current.lastDisplayTime = row.displayTime;
      current.lastSpot = row.spot;
      current.lastCeOi = row.ce.oi;
      current.lastPeOi = row.pe.oi;
      confidenceSum += confidence;
    }
  }

  // The last position in the loop is still active.
  if (current) {
    current.ceOiDelta =
      current.lastCeOi !== null && current.entryCeOi !== null
        ? current.lastCeOi - current.entryCeOi
        : null;
    current.peOiDelta =
      current.lastPeOi !== null && current.entryPeOi !== null
        ? current.lastPeOi - current.entryPeOi
        : null;
    current.spotMove =
      current.lastSpot !== null && current.entrySpot !== null
        ? Math.round((current.lastSpot - current.entrySpot) * 100) / 100
        : null;
    current.avgConfidence =
      current.sampleCount > 0
        ? Math.round(confidenceSum / current.sampleCount)
        : current.peakConfidence;
    current.isActive = true;
    positions.push(current);
  }

  // Return newest-first.
  return positions.reverse();
}

/**
 * Returns only positions from a specific trade date.
 */
export function filterByDate(
  positions: SmartMoneyPosition[],
  tradeDate: string
): SmartMoneyPosition[] {
  return positions.filter((p) => p.tradeDate === tradeDate);
}

/**
 * Returns only positions where sampleCount >= minCandles (accumulation filter).
 * A position that spans >= 3 candles (9+ minutes) is considered a sustained position.
 */
export function filterSustained(
  positions: SmartMoneyPosition[],
  minCandles = 3
): SmartMoneyPosition[] {
  return positions.filter((p) => p.sampleCount >= minCandles);
}

/** Signal labels for display */
export const SIGNAL_LABELS: Record<string, string> = {
  PUT_WRITING: "Put Writing",
  CALL_SHORT_COVERING: "Call Short Covering",
  DIRECTIONAL_OPTION_BUYING: "Directional Buying",
  PUT_WRITING_UNWIND: "Put Unwind",
  NEUTRAL: "Neutral"
};

/** Bias implied by each signal */
export const SIGNAL_BIAS: Record<string, "BULLISH" | "BEARISH" | "NEUTRAL"> = {
  PUT_WRITING: "BULLISH",
  CALL_SHORT_COVERING: "BULLISH",
  DIRECTIONAL_OPTION_BUYING: "BEARISH",
  PUT_WRITING_UNWIND: "BEARISH",
  NEUTRAL: "NEUTRAL"
};
