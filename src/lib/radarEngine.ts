import { clamp, quantile, safeDiff, safeRoc } from "@/lib/math";
import type { ParsedChainStrike } from "@/lib/brokers/upstox";
import type { IndexSymbol, MarketTone, RadarSignal, SmartMoneyRadar } from "@/lib/types";

export interface ChainLegSnapshot {
  oi: number | null;
  volume: number | null;
  iv: number | null;
  ltp: number | null;
}

export interface ChainStrikeSnapshot {
  strike: number;
  underlying: number | null;
  ce: ChainLegSnapshot;
  pe: ChainLegSnapshot;
}

export type ChainSnapshotMap = Map<number, ChainStrikeSnapshot>;

interface RadarInput {
  index: IndexSymbol;
  spot: number | null;
  chainRows: ParsedChainStrike[];
  previousSnapshot: ChainSnapshotMap;
}

interface LegSignalInput {
  strike: number;
  side: "CE" | "PE";
  distance: number;
  coi: number | null;
  volume: number | null;
  ivRoc: number | null;
  coiVolPower: number | null;
  volumeTop20Threshold: number;
  nearDistance: number;
  farLower: number;
  farUpper: number;
  smartThreshold: number;
}

const MONITOR_RANGE = Math.max(100, Number(process.env.MONITOR_STRIKE_RANGE ?? 300));
const NEAR_STRIKE_STEPS = Math.max(1, Number(process.env.NEAR_STRIKE_STEPS ?? 2));
const FAR_OTM_LOWER = Math.max(100, Number(process.env.FAR_OTM_LOWER_POINTS ?? 250));
const FAR_OTM_UPPER = Math.max(FAR_OTM_LOWER, Number(process.env.FAR_OTM_UPPER_POINTS ?? 300));
const SMART_MONEY_ACTIVITY_THRESHOLD = Math.max(1, Number(process.env.SMART_MONEY_ACTIVITY_THRESHOLD ?? 4.5));
const ACTIVE_SIGNAL_LIMIT = Math.max(6, Number(process.env.RADAR_SIGNAL_LIMIT ?? 24));

function estimateSpot(index: IndexSymbol, rows: ParsedChainStrike[]): number | null {
  const direct = rows.find((row) => row.underlying !== null)?.underlying;
  if (direct !== null && direct !== undefined) {
    return direct;
  }

  if (rows.length === 0) {
    return null;
  }

  const fallback = index === "BANKNIFTY" ? 51_000 : 24_900;
  const best = [...rows].sort((a, b) => Math.abs(a.strike - fallback) - Math.abs(b.strike - fallback))[0];
  return best.strike;
}

function strikeStep(rows: ParsedChainStrike[]): number {
  if (rows.length < 2) {
    return 50;
  }

  const sorted = [...rows].map((row) => row.strike).sort((a, b) => a - b);
  const diffs: number[] = [];

  for (let index = 1; index < sorted.length; index += 1) {
    const diff = sorted[index] - sorted[index - 1];
    if (diff > 0) {
      diffs.push(diff);
    }
  }

  if (diffs.length === 0) {
    return 50;
  }

  return diffs.sort((a, b) => a - b)[0];
}

function toSnapshotMap(rows: ParsedChainStrike[]): ChainSnapshotMap {
  const map: ChainSnapshotMap = new Map();
  for (const row of rows) {
    map.set(row.strike, {
      strike: row.strike,
      underlying: row.underlying,
      ce: row.ce,
      pe: row.pe
    });
  }
  return map;
}

function confidenceFromMetrics(coiVolPower: number | null, volume: number | null, top20: number, absorption: boolean): number {
  const ratioScore = coiVolPower === null ? 0 : clamp((coiVolPower - SMART_MONEY_ACTIVITY_THRESHOLD) / 5, 0, 1);
  const volumeScore = volume === null || top20 <= 0 ? 0 : clamp((volume - top20) / Math.max(top20, 1), 0, 1);
  const absorptionBoost = absorption ? 0.08 : 0;

  return clamp((0.56 + ratioScore * 0.28 + volumeScore * 0.08 + absorptionBoost) * 100, 0, 99);
}

function isFarOtm(side: "CE" | "PE", distance: number, farLower: number, farUpper: number): boolean {
  if (side === "CE") {
    return distance >= farLower && distance <= farUpper;
  }
  return distance <= -farLower && distance >= -farUpper;
}

function buildLegSignal(input: LegSignalInput): RadarSignal | null {
  const {
    strike,
    side,
    distance,
    coi,
    volume,
    ivRoc,
    coiVolPower,
    volumeTop20Threshold,
    nearDistance,
    farLower,
    farUpper,
    smartThreshold
  } = input;

  if (coiVolPower === null || coiVolPower < smartThreshold) {
    return null;
  }

  const nearZone = Math.abs(distance) <= nearDistance;
  const farZone = isFarOtm(side, distance, farLower, farUpper);

  if (!nearZone && !farZone) {
    return null;
  }

  const absorption = ivRoc !== null && ivRoc < 0;
  const highVolume = volume !== null && volume >= volumeTop20Threshold;

  if (!highVolume && coiVolPower < smartThreshold + 0.8) {
    return null;
  }

  let action: RadarSignal["action"];
  let tone: MarketTone;

  if (nearZone) {
    if (side === "CE") {
      action = "CALL_WRITING";
      tone = "BEARISH";
    } else {
      action = "PUT_WRITING";
      tone = "BULLISH";
    }
  } else {
    if (side === "CE") {
      action = "CALL_BUYING";
      tone = "BULLISH";
    } else {
      action = "PUT_BUYING";
      tone = "BEARISH";
    }
  }

  const confidence = confidenceFromMetrics(coiVolPower, volume, volumeTop20Threshold, absorption);

  const zoneLabel = nearZone ? "ATM/Near OTM" : "Far OTM";
  const sharkLabel = absorption ? " | Shark absorption (IV down)" : "";
  const reason = `${zoneLabel} ${side} ${action.replaceAll("_", " ")} | COI/VOL=${coiVolPower.toFixed(2)}${sharkLabel}`;

  return {
    id: `${strike}-${side}-${nearZone ? "A" : "B"}`,
    strike,
    side,
    zone: nearZone ? "ATM_NEAR_OTM" : "FAR_OTM",
    action,
    tone,
    coi,
    volume,
    ivRoc,
    coiVolPower,
    absorption,
    confidence,
    reason
  };
}

function regimeFromSignals(activeSignals: RadarSignal[]): {
  bullishSignals: number;
  bearishSignals: number;
  regime: MarketTone;
  summary: string;
} {
  const bullishSignals = activeSignals.filter((signal) => signal.tone === "BULLISH").length;
  const bearishSignals = activeSignals.filter((signal) => signal.tone === "BEARISH").length;

  let regime: MarketTone = "NEUTRAL";
  if (bullishSignals - bearishSignals >= 2) {
    regime = "BULLISH";
  } else if (bearishSignals - bullishSignals >= 2) {
    regime = "BEARISH";
  }

  if (activeSignals.length === 0) {
    return {
      bullishSignals,
      bearishSignals,
      regime,
      summary: "No high-conviction smart-money activity in ATM +-300 range."
    };
  }

  const top = activeSignals[0];
  const summary = `${activeSignals.length} active strikes | ${regime} tone | Top: ${top.strike} ${top.action.replaceAll("_", " ")}`;

  return {
    bullishSignals,
    bearishSignals,
    regime,
    summary
  };
}

export function buildSmartMoneyRadar(input: RadarInput): {
  radar: SmartMoneyRadar;
  nextSnapshot: ChainSnapshotMap;
} {
  const { index, chainRows, previousSnapshot } = input;
  const spot = input.spot ?? estimateSpot(index, chainRows);
  const step = strikeStep(chainRows);
  const nearDistance = step * NEAR_STRIKE_STEPS;

  const nextSnapshot = toSnapshotMap(chainRows);

  if (spot === null) {
    return {
      radar: {
        spot: null,
        strikeStep: step,
        monitorRange: MONITOR_RANGE,
        consideredStrikes: 0,
        activeSignals: [],
        bullishSignals: 0,
        bearishSignals: 0,
        regime: "NEUTRAL",
        summary: "Spot unavailable; radar waiting for underlying value."
      },
      nextSnapshot
    };
  }

  const monitored = chainRows.filter((row) => Math.abs(row.strike - spot) <= MONITOR_RANGE);

  const ceVolumes = monitored.map((row) => row.ce.volume).filter((value): value is number => value !== null);
  const peVolumes = monitored.map((row) => row.pe.volume).filter((value): value is number => value !== null);
  const ceTop20 = ceVolumes.length > 0 ? quantile(ceVolumes, 0.8) : 0;
  const peTop20 = peVolumes.length > 0 ? quantile(peVolumes, 0.8) : 0;

  const activeSignals: RadarSignal[] = [];

  for (const row of monitored) {
    const prev = previousSnapshot.get(row.strike);

    const ceCoi = safeDiff(row.ce.oi, prev?.ce.oi ?? null);
    const peCoi = safeDiff(row.pe.oi, prev?.pe.oi ?? null);

    const ceIvr = safeRoc(row.ce.iv, prev?.ce.iv ?? null);
    const peIvr = safeRoc(row.pe.iv, prev?.pe.iv ?? null);

    const cePower = ceCoi !== null && row.ce.volume !== null && row.ce.volume > 0 ? (Math.abs(ceCoi) / row.ce.volume) * 100 : null;
    const pePower = peCoi !== null && row.pe.volume !== null && row.pe.volume > 0 ? (Math.abs(peCoi) / row.pe.volume) * 100 : null;

    const distance = row.strike - spot;

    const ceSignal = buildLegSignal({
      strike: row.strike,
      side: "CE",
      distance,
      coi: ceCoi,
      volume: row.ce.volume,
      ivRoc: ceIvr,
      coiVolPower: cePower,
      volumeTop20Threshold: ceTop20,
      nearDistance,
      farLower: FAR_OTM_LOWER,
      farUpper: FAR_OTM_UPPER,
      smartThreshold: SMART_MONEY_ACTIVITY_THRESHOLD
    });

    if (ceSignal) {
      activeSignals.push(ceSignal);
    }

    const peSignal = buildLegSignal({
      strike: row.strike,
      side: "PE",
      distance,
      coi: peCoi,
      volume: row.pe.volume,
      ivRoc: peIvr,
      coiVolPower: pePower,
      volumeTop20Threshold: peTop20,
      nearDistance,
      farLower: FAR_OTM_LOWER,
      farUpper: FAR_OTM_UPPER,
      smartThreshold: SMART_MONEY_ACTIVITY_THRESHOLD
    });

    if (peSignal) {
      activeSignals.push(peSignal);
    }
  }

  activeSignals.sort((a, b) => b.confidence - a.confidence);
  const limited = activeSignals.slice(0, ACTIVE_SIGNAL_LIMIT);

  const regime = regimeFromSignals(limited);

  return {
    radar: {
      spot,
      strikeStep: step,
      monitorRange: MONITOR_RANGE,
      consideredStrikes: monitored.length,
      activeSignals: limited,
      bullishSignals: regime.bullishSignals,
      bearishSignals: regime.bearishSignals,
      regime: regime.regime,
      summary: regime.summary
    },
    nextSnapshot
  };
}
