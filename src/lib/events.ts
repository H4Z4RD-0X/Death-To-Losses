import type { SmartMoneyEvent, SnapshotRow } from "@/lib/types";

export function extractRegimeShiftEvents(rows: SnapshotRow[], limit = 48): SmartMoneyEvent[] {
  if (rows.length < 2) {
    return [];
  }

  const events: SmartMoneyEvent[] = [];

  for (let index = 0; index < rows.length - 1; index += 1) {
    const newer = rows[index];
    const older = rows[index + 1];

    if (newer.market.regime === older.market.regime) {
      continue;
    }

    events.push({
      id: `${newer.id}:${older.market.regime}->${newer.market.regime}`,
      timestampIso: newer.timestampIso,
      displayTime: newer.displayTime,
      fromRegime: older.market.regime,
      toRegime: newer.market.regime,
      signalKind: newer.signal.kind,
      tone: newer.market.tone,
      confidence: newer.signal.confidence,
      verdict: newer.market.verdict
    });

    if (events.length >= limit) {
      break;
    }
  }

  return events;
}
