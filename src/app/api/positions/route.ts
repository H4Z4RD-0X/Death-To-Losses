import { NextResponse } from "next/server";
import { istTradeDate } from "@/lib/math";
import { readLiveBackupSession } from "@/lib/backupStore";
import { groupPositions, type SmartMoneyPosition } from "@/lib/positionTracker";
import type { IndexSymbol } from "@/lib/types";

function minusDays(dateIso: string, offset: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

/**
 * GET /api/positions
 *
 * Query params:
 *   index   – NIFTY | BANKNIFTY  (default: NIFTY)
 *   strike  – strike price       (default: 24900)
 *   days    – look-back days     (default: 5, max: 10)
 *   minCandles – min candles for a position to be included (default: 1)
 *
 * Returns an array of SmartMoneyPosition objects sorted newest-first,
 * aggregated across the requested date range using the backup archive.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const index = (searchParams.get("index") ?? "NIFTY") as IndexSymbol;
  const strike = Number(searchParams.get("strike") ?? 24_900);
  const days = Math.min(10, Math.max(1, Number(searchParams.get("days") ?? 5)));
  const minCandles = Math.max(1, Number(searchParams.get("minCandles") ?? 1));

  if (!Number.isFinite(strike) || strike <= 0) {
    return NextResponse.json({ error: "Invalid strike parameter." }, { status: 400 });
  }

  const today = istTradeDate();
  const allPositions: SmartMoneyPosition[] = [];
  const datesCovered: string[] = [];
  const warnings: string[] = [];

  for (let offset = 0; offset < days; offset += 1) {
    const tradeDate = minusDays(today, offset);
    try {
      const session = await readLiveBackupSession(tradeDate, index, strike, null);
      if (session && session.rows.length > 0) {
        const positions = groupPositions(session.rows);
        const filtered = minCandles > 1 ? positions.filter((p) => p.sampleCount >= minCandles) : positions;
        allPositions.push(...filtered);
        datesCovered.push(tradeDate);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      warnings.push(`Skipped ${tradeDate}: ${message}`);
    }
  }

  // Sort all positions newest-first across dates.
  allPositions.sort(
    (a, b) => new Date(b.entryTimestampIso).getTime() - new Date(a.entryTimestampIso).getTime()
  );

  const activePositions = allPositions.filter((p) => p.isActive);
  const bullishPositions = allPositions.filter(
    (p) => p.signalKind === "PUT_WRITING" || p.signalKind === "CALL_SHORT_COVERING"
  );
  const bearishPositions = allPositions.filter(
    (p) => p.signalKind === "DIRECTIONAL_OPTION_BUYING" || p.signalKind === "PUT_WRITING_UNWIND"
  );

  return NextResponse.json({
    index,
    strike,
    days,
    datesCovered,
    totalPositions: allPositions.length,
    activePositions: activePositions.length,
    bullishPositions: bullishPositions.length,
    bearishPositions: bearishPositions.length,
    positions: allPositions,
    warnings
  });
}
