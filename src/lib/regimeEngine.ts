import { quantile } from "@/lib/math";
import type {
  MarketRegime,
  MarketRowColor,
  MarketTone,
  SignalSide,
  SnapshotRow
} from "@/lib/types";

const EXCHANGE_OF_HANDS_AR = 0.1;
const HIGH_CONVICTION_AR = 0.3;
const PANIC_COVERING_AR = 0.15;

function activityRatio(coi: number | null, volume: number | null): number | null {
  if (coi === null || volume === null || volume <= 0) {
    return null;
  }
  return Math.abs(coi) / volume;
}

function absOrZero(value: number | null): number {
  return value === null || !Number.isFinite(value) ? 0 : Math.abs(value);
}

function sideThreshold(values: Array<number | null>, percentile: number, fallback: number): number {
  const cleaned = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (cleaned.length < 4) {
    return fallback;
  }
  return Math.max(quantile(cleaned, percentile), fallback);
}

function dominantLeg(ceScore: number, peScore: number): SignalSide {
  if (ceScore > peScore) {
    return "CE";
  }
  if (peScore > ceScore) {
    return "PE";
  }
  return "BOTH";
}

function resolveVerdict(input: {
  signalKind: SnapshotRow["signal"]["kind"];
  exchangeOfHands: boolean;
  highConvictionWriting: boolean;
  panicCovering: boolean;
  ceHighConviction: boolean;
  peHighConviction: boolean;
  cePanic: boolean;
  pePanic: boolean;
}): {
  regime: MarketRegime;
  tone: MarketTone;
  rowColor: MarketRowColor;
  verdict: string;
} {
  const {
    signalKind,
    exchangeOfHands,
    highConvictionWriting,
    panicCovering,
    ceHighConviction,
    peHighConviction,
    cePanic,
    pePanic
  } = input;

  if (exchangeOfHands && signalKind === "CALL_SHORT_COVERING") {
    return {
      regime: "EOH",
      tone: "BULLISH",
      rowColor: "PURPLE",
      verdict: "Bullish Rotation: Smart Money flipping to Longs."
    };
  }

  if (highConvictionWriting && signalKind === "PUT_WRITING") {
    return {
      regime: "WRITING",
      tone: "BULLISH",
      rowColor: "GREEN",
      verdict: "Rock Solid Floor: High Conviction Support."
    };
  }

  if (exchangeOfHands && signalKind === "DIRECTIONAL_OPTION_BUYING") {
    return {
      regime: "EOH",
      tone: "BEARISH",
      rowColor: "PURPLE",
      verdict: "Retail Trap: High Volume Churn, No Real Buying."
    };
  }

  if (highConvictionWriting) {
    if (peHighConviction && !ceHighConviction) {
      return {
        regime: "WRITING",
        tone: "BULLISH",
        rowColor: "GREEN",
        verdict: "High Conviction Writing: Put-side buildup is forming support."
      };
    }

    if (ceHighConviction && !peHighConviction) {
      return {
        regime: "WRITING",
        tone: "BEARISH",
        rowColor: "RED",
        verdict: "High Conviction Writing: Call-side buildup is forming resistance."
      };
    }

    return {
      regime: "WRITING",
      tone: "NEUTRAL",
      rowColor: "NONE",
      verdict: "High Conviction Writing on both sides: range-bound structure."
    };
  }

  if (panicCovering) {
    if (pePanic && !cePanic) {
      return {
        regime: "NEUTRAL",
        tone: "BEARISH",
        rowColor: "RED",
        verdict: "Panic Covering: Put writers are unwinding aggressively."
      };
    }

    if (cePanic && !pePanic) {
      return {
        regime: "NEUTRAL",
        tone: "BULLISH",
        rowColor: "NONE",
        verdict: "Panic Covering: Call shorts are exiting fast."
      };
    }

    return {
      regime: "NEUTRAL",
      tone: "NEUTRAL",
      rowColor: "NONE",
      verdict: "Panic Covering detected on both sides: unstable structure."
    };
  }

  if (exchangeOfHands) {
    return {
      regime: "EOH",
      tone: "NEUTRAL",
      rowColor: "PURPLE",
      verdict: "Exchange of Hands: heavy churn without fresh conviction. Sideways bias; avoid breakout trades."
    };
  }

  return {
    regime: "NEUTRAL",
    tone: "NEUTRAL",
    rowColor: "NONE",
    verdict: "Neutral Structure: No high-conviction smart-money footprint."
  };
}

export function applyRegimeVerdicts(rows: SnapshotRow[]): void {
  const ceVolumeThreshold = sideThreshold(
    rows.map((row) => row.ce.volume),
    0.8,
    0
  );
  const peVolumeThreshold = sideThreshold(
    rows.map((row) => row.pe.volume),
    0.8,
    0
  );

  const ceStrongNegativeThreshold = sideThreshold(
    rows.map((row) => (row.ce.coi !== null && row.ce.coi < 0 ? Math.abs(row.ce.coi) : null)),
    0.7,
    1
  );
  const peStrongNegativeThreshold = sideThreshold(
    rows.map((row) => (row.pe.coi !== null && row.pe.coi < 0 ? Math.abs(row.pe.coi) : null)),
    0.7,
    1
  );

  const ceVolumeRocThreshold = sideThreshold(
    rows.map((row) => row.ce.volumeRoc),
    0.7,
    0.4
  );
  const peVolumeRocThreshold = sideThreshold(
    rows.map((row) => row.pe.volumeRoc),
    0.7,
    0.4
  );

  const ceRatioDropThreshold = sideThreshold(
    rows.map((row) => (row.ce.ratioRoc !== null && row.ce.ratioRoc < 0 ? Math.abs(row.ce.ratioRoc) : null)),
    0.6,
    0.02
  );
  const peRatioDropThreshold = sideThreshold(
    rows.map((row) => (row.pe.ratioRoc !== null && row.pe.ratioRoc < 0 ? Math.abs(row.pe.ratioRoc) : null)),
    0.6,
    0.02
  );

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index + 1];
    const ceAr = row.ce.activityRatio ?? activityRatio(row.ce.coi, row.ce.volume);
    const peAr = row.pe.activityRatio ?? activityRatio(row.pe.coi, row.pe.volume);

    row.ce.activityRatio = ceAr;
    row.pe.activityRatio = peAr;

    const ceHighVolume = row.ce.volume !== null && row.ce.volume >= ceVolumeThreshold;
    const peHighVolume = row.pe.volume !== null && row.pe.volume >= peVolumeThreshold;

    const ceVolumeSpike = (row.ce.volumeRoc ?? 0) >= ceVolumeRocThreshold;
    const peVolumeSpike = (row.pe.volumeRoc ?? 0) >= peVolumeRocThreshold;
    const ceRatioFalling = row.ce.ratioRoc !== null && row.ce.ratioRoc <= -ceRatioDropThreshold;
    const peRatioFalling = row.pe.ratioRoc !== null && row.pe.ratioRoc <= -peRatioDropThreshold;

    const cePriceFlat = absOrZero(row.ce.premiumRoc) <= 1.2 && absOrZero(row.ce.ltpChg) <= 2.5;
    const pePriceFlat = absOrZero(row.pe.premiumRoc) <= 1.2 && absOrZero(row.pe.ltpChg) <= 2.5;
    const spotFlat =
      previous?.spot !== null &&
      previous?.spot !== undefined &&
      row.spot !== null &&
      row.spot !== undefined
        ? Math.abs(row.spot - previous.spot) <= 18
        : true;
    const neutralMoneyFlow = row.signal.kind === "NEUTRAL" || row.signal.confidence < 60;

    const ceExchange =
      ceAr !== null &&
      ceAr < EXCHANGE_OF_HANDS_AR &&
      (ceHighVolume || ceVolumeSpike) &&
      ceRatioFalling &&
      neutralMoneyFlow &&
      cePriceFlat &&
      spotFlat;
    const peExchange =
      peAr !== null &&
      peAr < EXCHANGE_OF_HANDS_AR &&
      (peHighVolume || peVolumeSpike) &&
      peRatioFalling &&
      neutralMoneyFlow &&
      pePriceFlat &&
      spotFlat;

    const ceHighConviction = ceAr !== null && ceAr > HIGH_CONVICTION_AR;
    const peHighConviction = peAr !== null && peAr > HIGH_CONVICTION_AR;

    const cePanic =
      ceAr !== null &&
      ceAr < PANIC_COVERING_AR &&
      row.ce.coi !== null &&
      row.ce.coi < -ceStrongNegativeThreshold;
    const pePanic =
      peAr !== null &&
      peAr < PANIC_COVERING_AR &&
      row.pe.coi !== null &&
      row.pe.coi < -peStrongNegativeThreshold;

    const exchangeOfHands = ceExchange || peExchange;
    const highConvictionWriting = ceHighConviction || peHighConviction;
    const panicCovering = cePanic || pePanic;

    const resolution = resolveVerdict({
      signalKind: row.signal.kind,
      exchangeOfHands,
      highConvictionWriting,
      panicCovering,
      ceHighConviction,
      peHighConviction,
      cePanic,
      pePanic
    });

    const ceScore = ceAr ?? 0;
    const peScore = peAr ?? 0;

    row.market = {
      regime: resolution.regime,
      tone: resolution.tone,
      rowColor: resolution.rowColor,
      verdict: resolution.verdict,
      flags: {
        exchangeOfHands,
        highConvictionWriting,
        panicCovering
      },
      ceAr,
      peAr,
      dominantLeg: dominantLeg(ceScore, peScore)
    };
  }
}

export function currentRegimeLabel(rows: SnapshotRow[]): string {
  const latest = rows[0]?.market?.regime;
  if (latest === "EOH") {
    return "EoH";
  }
  if (latest === "WRITING") {
    return "Writing";
  }
  return "Neutral";
}
