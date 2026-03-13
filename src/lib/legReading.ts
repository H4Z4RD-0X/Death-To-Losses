import { clamp } from "@/lib/math";
import type { LegMetrics } from "@/lib/types";

interface TrendMetrics {
  sampleCount: number;
  oiDelta: number;
  volumeDelta: number;
  premiumRoc: number | null;
  ivRoc: number | null;
  coiVol: number | null;
}

function absOrZero(value: number | null): number {
  return value === null || !Number.isFinite(value) ? 0 : Math.abs(value);
}

function sideName(side: "CE" | "PE"): string {
  return side === "CE" ? "Call" : "Put";
}

export function classifyLegReading(side: "CE" | "PE", leg: LegMetrics): string {
  const oiRoc = leg.oiRoc ?? 0;
  const volumeRoc = leg.volumeRoc ?? 0;
  const premiumRoc = leg.premiumRoc ?? 0;
  const ivRoc = leg.ivRoc ?? 0;
  const ratioRoc = leg.ratioRoc ?? 0;
  const ltpChg = leg.ltpChg ?? 0;
  const positional = leg.positional ?? leg.halchalRatio ?? leg.coiVol;

  if (positional !== null) {
    const commitment = Math.abs(positional);
    if (commitment < 1) {
      return "Retail Noise (Ignore)";
    }
    if (commitment > 4) {
      if (oiRoc >= 0.6 && premiumRoc <= -1.2) {
        return `${sideName(side)} Writing (Big Player)`;
      }
      if (oiRoc >= 0.6 && premiumRoc >= 1.2 && ivRoc >= 0.8) {
        return `${sideName(side)} Buying (Big Player)`;
      }
      if (oiRoc <= -0.6) {
        return `${sideName(side)} Unwinding (Big Player)`;
      }
      return `${sideName(side)} Big Player Activity`;
    }
  }

  if (volumeRoc >= 0.7 && ratioRoc <= -0.02 && Math.abs(premiumRoc) <= 1.2 && Math.abs(ltpChg) <= 2.5) {
    return "Exchange of Hands";
  }

  if (oiRoc >= 0.6 && premiumRoc <= -1.2) {
    return `${sideName(side)} Writing Build-up`;
  }

  if (oiRoc >= 0.6 && premiumRoc >= 1.2 && ivRoc >= 0.8) {
    return `${sideName(side)} Buying Build-up`;
  }

  if (oiRoc <= -0.6 && premiumRoc >= 1) {
    return `${sideName(side)} Short Covering`;
  }

  if (oiRoc <= -0.6 && premiumRoc <= -1) {
    return `${sideName(side)} Long Unwinding`;
  }

  return "Neutral Flow";
}

export function classifyTrendReading(side: "CE" | "PE", metrics: TrendMetrics): {
  reading: string;
  confidence: number;
} {
  if (metrics.sampleCount < 2) {
    return {
      reading: "Insufficient Trend Data",
      confidence: 0
    };
  }

  const premiumRoc = metrics.premiumRoc ?? 0;
  const ivRoc = metrics.ivRoc ?? 0;
  const volumePerSample = absOrZero(metrics.volumeDelta) / Math.max(metrics.sampleCount, 1);
  const coiVol = metrics.coiVol;
  const sideLabel = sideName(side);

  let reading = "Neutral Drift";

  if (volumePerSample >= 500 && Math.abs(premiumRoc) <= 1.2 && (coiVol === null || Math.abs(coiVol) <= 0.08)) {
    reading = "Exchange of Hands (Range Build-up)";
  } else if (metrics.oiDelta > 0 && premiumRoc <= -1.2) {
    reading = `${sideLabel} Writing Build-up`;
  } else if (metrics.oiDelta > 0 && premiumRoc >= 1.2 && ivRoc >= 0.8) {
    reading = `${sideLabel} Buying Build-up`;
  } else if (metrics.oiDelta < 0 && premiumRoc >= 1) {
    reading = `${sideLabel} Short Covering`;
  } else if (metrics.oiDelta < 0 && premiumRoc <= -1) {
    reading = `${sideLabel} Long Unwinding`;
  }

  const intensity =
    (absOrZero(metrics.oiDelta) / Math.max(absOrZero(metrics.volumeDelta), 1)) * 3.8 +
    absOrZero(metrics.premiumRoc) / 4 +
    absOrZero(metrics.ivRoc) / 7;

  const confidence = Math.round(clamp(40 + intensity * 45, 0, 99));
  return {
    reading,
    confidence
  };
}
