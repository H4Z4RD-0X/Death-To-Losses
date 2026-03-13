import {
  directionScore,
  formatSigned,
  mean,
  stdDev,
  weightedAverage
} from "@/lib/math";
import type { IntradaySummary, LegMetrics, SignalKind, SignalResult, SnapshotRow } from "@/lib/types";

function adaptiveThreshold(values: Array<number | null>, floor = 0.08): number {
  const cleaned = values.filter((value): value is number => value !== null);
  if (cleaned.length < 6) {
    return floor;
  }
  return Math.max(stdDev(cleaned), floor);
}

function legScore(
  leg: LegMetrics,
  history: SnapshotRow[],
  expected: {
    coiVol: "increase" | "decrease";
    ivRoc: "increase" | "decrease";
    premiumRoc: "increase" | "decrease";
  }
): { score: number; reasons: string[] } {
  const coiVolThreshold = adaptiveThreshold(history.map((row) => row.ce.coiVol).concat(history.map((row) => row.pe.coiVol)));
  // ivRoc is now absolute Δ IV points (Nitin Bhatia); floor = 0.3 IV pts
  const ivThreshold = adaptiveThreshold(history.map((row) => row.ce.ivRoc).concat(history.map((row) => row.pe.ivRoc)), 0.3);
  // premiumRoc is now absolute Δ ₹ (Nitin Bhatia); floor = ₹2
  const premiumThreshold = adaptiveThreshold(
    history.map((row) => row.ce.premiumRoc).concat(history.map((row) => row.pe.premiumRoc)),
    2.0
  );

  const coiVolScore = directionScore(leg.coiVol, expected.coiVol, coiVolThreshold);
  const ivScore = directionScore(leg.ivRoc, expected.ivRoc, ivThreshold);
  const premiumScore = directionScore(leg.premiumRoc, expected.premiumRoc, premiumThreshold);

  const score = weightedAverage([
    { value: coiVolScore, weight: 0.38 },
    { value: ivScore, weight: 0.31 },
    { value: premiumScore, weight: 0.31 }
  ]);

  const reasons = [
    `COI/VOL ${formatSigned(leg.coiVol, 3)}`,
    `IV ROC ${formatSigned(leg.ivRoc, 2)}%`,
    `Premium ROC ${formatSigned(leg.premiumRoc, 2)}%`
  ];

  return { score, reasons };
}

function toConfidence(score: number, missingCount: number): number {
  const base = score * 100;
  const penalty = missingCount * 5;
  return Math.max(0, Math.min(100, base - penalty));
}

function countMissing(leg: LegMetrics): number {
  const checks = [leg.coiVol, leg.ivRoc, leg.premiumRoc];
  return checks.filter((value) => value === null).length;
}

export function classifySignal(current: SnapshotRow, history: SnapshotRow[]): SignalResult {
  const ceCallShortCover = legScore(current.ce, history, {
    coiVol: "increase",
    ivRoc: "increase",
    premiumRoc: "increase"
  });

  const pePutWriting = legScore(current.pe, history, {
    coiVol: "decrease",
    ivRoc: "decrease",
    premiumRoc: "decrease"
  });

  const ceOptionBuying = legScore(current.ce, history, {
    coiVol: "decrease",
    ivRoc: "increase",
    premiumRoc: "increase"
  });

  const peOptionBuying = legScore(current.pe, history, {
    coiVol: "decrease",
    ivRoc: "increase",
    premiumRoc: "increase"
  });

  const pePutUnwind = legScore(current.pe, history, {
    coiVol: "increase",
    ivRoc: "decrease",
    premiumRoc: "decrease"
  });

  const candidates: Array<{
    kind: SignalKind;
    side: "CE" | "PE" | "BOTH";
    score: number;
    reasons: string[];
    missing: number;
  }> = [
    {
      kind: "CALL_SHORT_COVERING",
      side: "CE",
      score: ceCallShortCover.score,
      reasons: ceCallShortCover.reasons,
      missing: countMissing(current.ce)
    },
    {
      kind: "PUT_WRITING",
      side: "PE",
      score: pePutWriting.score,
      reasons: pePutWriting.reasons,
      missing: countMissing(current.pe)
    },
    {
      kind: "DIRECTIONAL_OPTION_BUYING",
      side: ceOptionBuying.score >= peOptionBuying.score ? "CE" : "PE",
      score: Math.max(ceOptionBuying.score, peOptionBuying.score),
      reasons: ceOptionBuying.score >= peOptionBuying.score ? ceOptionBuying.reasons : peOptionBuying.reasons,
      missing: Math.min(countMissing(current.ce), countMissing(current.pe))
    },
    {
      kind: "PUT_WRITING_UNWIND",
      side: "PE",
      score: pePutUnwind.score,
      reasons: pePutUnwind.reasons,
      missing: countMissing(current.pe)
    }
  ];

  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  const confidence = toConfidence(winner.score, winner.missing);

  if (confidence < 56) {
    return {
      kind: "NEUTRAL",
      side: "BOTH",
      confidence,
      score: winner.score,
      reasons: ["Signal cluster is mixed; no strong regime domination."]
    };
  }

  return {
    kind: winner.kind,
    side: winner.side,
    confidence,
    score: winner.score,
    reasons: winner.reasons
  };
}

export function buildIntradaySummary(rows: SnapshotRow[]): IntradaySummary {
  const distribution: Record<SignalKind, number> = {
    CALL_SHORT_COVERING: 0,
    PUT_WRITING: 0,
    DIRECTIONAL_OPTION_BUYING: 0,
    PUT_WRITING_UNWIND: 0,
    NEUTRAL: 0
  };

  const sample = rows.slice(0, 90);
  for (const row of sample) {
    distribution[row.signal.kind] += 1;
  }

  const dominant = (Object.entries(distribution).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "NEUTRAL") as SignalKind;
  const dominantRows = sample.filter((row) => row.signal.kind === dominant);
  const dominantConfidence = mean(dominantRows.map((row) => row.signal.confidence));

  const recent = rows[0];
  const latestNarrative = recent
    ? `${recent.signal.kind.replaceAll("_", " ")} ${recent.signal.side} (${recent.signal.confidence.toFixed(1)}%)`
    : "Waiting for first live print";

  const bullishSignals = distribution.PUT_WRITING + distribution.CALL_SHORT_COVERING;
  const bearishSignals = distribution.DIRECTIONAL_OPTION_BUYING + distribution.PUT_WRITING_UNWIND;

  let marketTone: "BULLISH" | "BEARISH" | "MIXED" = "MIXED";
  if (bullishSignals - bearishSignals > 8) {
    marketTone = "BULLISH";
  } else if (bearishSignals - bullishSignals > 8) {
    marketTone = "BEARISH";
  }

  return {
    dominant,
    dominantConfidence: Number.isFinite(dominantConfidence) ? dominantConfidence : 0,
    distribution,
    latestNarrative,
    marketTone
  };
}
