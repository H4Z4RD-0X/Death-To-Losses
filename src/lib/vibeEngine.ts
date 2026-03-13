import { clamp, mean, quantile, safeDiff, safeRoc } from "@/lib/math";
import { classifyTrendReading } from "@/lib/legReading";
import type { ChainSnapshotMap } from "@/lib/radarEngine";
import type {
  MarketTone,
  ParticipantsSummary,
  SnapshotRow,
  VibeAlert,
  VibeAlertKind,
  VibeAlertSeverity,
  VibeAnalysis,
  VibeEcgPoint,
  VibeLegView,
  VibeNormalizedPoint,
  VibeSqueezeStatus,
  VibeStrikeView
} from "@/lib/types";

interface ChainLegRaw {
  oi: number | null;
  volume: number | null;
  iv: number | null;
  ltp: number | null;
}

interface ChainFrame {
  timestampIso: string;
  displayTime: string;
  spot: number | null;
  snapshot: ChainSnapshotMap;
}

interface LegScenarioPoint {
  strike: number;
  side: "CE" | "PE";
  leg: VibeLegView;
}

export interface IvSqueezeTracker {
  active: boolean;
  startedAtIso: string | null;
  referenceSpot: number | null;
  bars: number;
}

export interface BuildVibeAnalysisInput {
  current: ChainFrame;
  previous?: ChainFrame;
  older?: ChainFrame;
  rows: SnapshotRow[];
  snapshotCount: number;
  participantsSummary: ParticipantsSummary | null;
  radarRegime: MarketTone;
  intradayTone: "BULLISH" | "BEARISH" | "MIXED";
  squeezeTracker: IvSqueezeTracker;
}

export const INITIAL_IV_SQUEEZE_TRACKER: IvSqueezeTracker = {
  active: false,
  startedAtIso: null,
  referenceSpot: null,
  bars: 0
};

const MAX_TIMELINE_POINTS = 90;
const TREND_MIN_WINDOW_MS = 20 * 60 * 1000;
const TREND_MAX_WINDOW_MS = 30 * 60 * 1000;
const COI_RATIO_LOT_SIZE = Math.max(1, Number(process.env.COI_RATIO_LOT_SIZE ?? 65));

/**
 * Minimum chain snapshots required before the per-session σ is statistically
 * meaningful. Prevents false clustering signals in the first 30-45 min.
 */
const MIN_CLUSTER_SAMPLES = 15;

/**
 * Module-level: tracks how many consecutive vibe builds each (kind:strike:side)
 * key has fired. Resets to 0 when a key misses a build.
 * Key format: `kind:strike:side`  ("NA" when missing).
 */
const alertPersistenceTracker = new Map<string, number>();

function absOrZero(value: number | null): number {
  return value === null || !Number.isFinite(value) ? 0 : Math.abs(value);
}

function strikeStep(strikes: number[]): number {
  if (strikes.length < 2) {
    return 50;
  }
  const sorted = [...strikes].sort((a, b) => a - b);
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

function nearestStrike(strikes: number[], spot: number | null): number | null {
  if (strikes.length === 0 || spot === null) {
    return null;
  }
  return [...strikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
}

function toLegView(current: ChainLegRaw, previous?: ChainLegRaw, older?: ChainLegRaw): VibeLegView {
  const coi = safeDiff(current.oi, previous?.oi ?? null);
  const volumeDelta = safeDiff(current.volume, previous?.volume ?? null);
  const ltpDelta = safeDiff(current.ltp, previous?.ltp ?? null);

  const halchalRatio =
    coi !== null && volumeDelta !== null && volumeDelta > 0.0001 ? (coi * COI_RATIO_LOT_SIZE) / volumeDelta : null;

  const prevCoi = safeDiff(previous?.oi ?? null, older?.oi ?? null);
  const prevVolumeDelta = safeDiff(previous?.volume ?? null, older?.volume ?? null);
  const prevRatio =
    prevCoi !== null && prevVolumeDelta !== null && prevVolumeDelta > 0.0001
      ? (prevCoi * COI_RATIO_LOT_SIZE) / prevVolumeDelta
      : null;

  return {
    oi: current.oi,
    volume: current.volume,
    iv: current.iv,
    ltp: current.ltp,
    coi,
    volumeDelta,
    ltpDelta,
    halchalRatio,
    rocPremium: safeDiff(current.ltp, previous?.ltp ?? null),
    rocIv: safeDiff(current.iv, previous?.iv ?? null),
    rocRatio: safeDiff(halchalRatio, prevRatio),
    normalized: {
      rocPremium: null,
      rocIv: null,
      halchalRatio: null
    }
  };
}

function range(values: Array<number | null>): { min: number; max: number } | null {
  const cleaned = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (cleaned.length === 0) {
    return null;
  }

  return {
    min: Math.min(...cleaned),
    max: Math.max(...cleaned)
  };
}

function normalize(value: number | null, metricRange: { min: number; max: number } | null): number | null {
  if (value === null || !metricRange) {
    return null;
  }
  if (metricRange.max === metricRange.min) {
    return 50;
  }
  return clamp(((value - metricRange.min) / (metricRange.max - metricRange.min)) * 100, 0, 100);
}

function directionForLeg(side: "CE" | "PE", coi: number | null, rocPremium: number | null): number {
  if (coi === null || rocPremium === null || coi === 0 || rocPremium === 0) {
    return 0;
  }

  if (side === "CE") {
    if (coi > 0 && rocPremium > 0) {
      return 1;
    }
    if (coi > 0 && rocPremium < 0) {
      return -1;
    }
    if (coi < 0 && rocPremium > 0) {
      return 0.55;
    }
    return -0.35;
  }

  if (coi > 0 && rocPremium > 0) {
    return -1;
  }
  if (coi > 0 && rocPremium < 0) {
    return 1;
  }
  if (coi < 0 && rocPremium > 0) {
    return -0.55;
  }
  return 0.35;
}

function buildAlert(input: {
  timestampIso: string;
  kind: VibeAlertKind;
  severity: VibeAlertSeverity;
  title: string;
  message: string;
  strike?: number;
  side?: "CE" | "PE";
  isPersistent?: boolean;
}): VibeAlert {
  return {
    id: `${input.timestampIso}:${input.kind}:${input.strike ?? "NA"}:${input.side ?? "NA"}`,
    timestampIso: input.timestampIso,
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    message: input.message,
    strike: input.strike,
    side: input.side,
    isPersistent: input.isPersistent ?? false
  };
}

/**
 * Compute per-strike clustering coefficients (0–10) from the current chain
 * snapshot against the running session mean/σ of (volumeDelta, oiDelta).
 *
 * A coefficient ≥ 6 means both volume AND OI burst exceed 1σ of the session
 * mean simultaneously — strong evidence of professional accumulation.
 *
 * Returns null for all strikes when fewer than MIN_CLUSTER_SAMPLES snapshots
 * have been captured (σ is noise with small n).
 */
function computeClusteringCoeffs(
  pulses: Array<{ view: VibeStrikeView; currentTotalVolume: number }>,
  snapshotCount: number
): Map<number, number> {
  const result = new Map<number, number>();

  if (snapshotCount < MIN_CLUSTER_SAMPLES || pulses.length < 2) {
    return result; // empty = null for all strikes
  }

  const volSamples = pulses.map((p) => p.view.totalVolumeDelta);
  const oiSamples  = pulses.map((p) => p.view.totalOiDelta);

  const volMean = mean(volSamples);
  const oiMean  = mean(oiSamples);

  const volVariance = mean(volSamples.map((v) => (v - volMean) ** 2));
  const oiVariance  = mean(oiSamples.map((v) => (v - oiMean) ** 2));

  const volSigma = Math.sqrt(volVariance);
  const oiSigma  = Math.sqrt(oiVariance);

  for (const pulse of pulses) {
    const volZ = volSigma > 0 ? (pulse.view.totalVolumeDelta - volMean) / volSigma : 0;
    const oiZ  = oiSigma  > 0 ? (pulse.view.totalOiDelta  - oiMean)  / oiSigma  : 0;

    // Only fire if BOTH legs are above the mean (anomalous, not just one)
    if (volZ > 0 && oiZ > 0) {
      // Average z-score → scale to 0-10, cap at 10
      const raw = ((volZ + oiZ) / 2) * 3.33; // σ=1 → ~3.3, σ=3 → ~10
      result.set(pulse.view.strike, clamp(raw, 0, 10));
    } else {
      result.set(pulse.view.strike, 0);
    }
  }

  return result;
}

/**
 * Compute a session-relative Positioning Divergence Index.
 *   PDI = CLIENT_net_long_calls − (FII + PRO) net_short_calls
 * Positive → retail bullish, pros bearish (classic LONG_TRAP precondition).
 * Returns null when participant data is unavailable.
 */
function computeRawPdi(participantsSummary: import("@/lib/types").ParticipantsSummary | null): number | null {
  if (!participantsSummary) return null;
  const rows = participantsSummary.rows;
  const client = rows.find((r) => r.participant === "CLIENT");
  const fii    = rows.find((r) => r.participant === "FII");
  const pro    = rows.find((r) => r.participant === "PRO");
  if (!client || !fii || !pro) return null;

  // Net call position: today's indexCall flow (+ = net long, − = net short)
  const clientCallNet = (client.todayTradeFlow?.indexCall ?? client.today.indexCall ?? 0);
  const fiiCallNet    = (fii.todayTradeFlow?.indexCall    ?? fii.today.indexCall    ?? 0);
  const proCallNet    = (pro.todayTradeFlow?.indexCall    ?? pro.today.indexCall    ?? 0);

  // FII/PRO "short calls" = negative net (they've sold more than bought)
  const proSideShort = Math.min(fiiCallNet + proCallNet, 0); // always ≤ 0 when net short
  // PDI: how bullish is client vs how short are pros?
  return clientCallNet - proSideShort; // bigger = more diverged
}

/**
 * Compute session-percentile of a PDI value against the rolling history
 * extracted from SnapshotRow[] (we reuse ce.volume as a proxy availability
 * check — actual PDI time-series is re-derived here from rows).
 * Returns percentile 0-100.
 */
function computePdiPercentile(currentPdi: number, rows: SnapshotRow[]): number {
  if (rows.length < 2) return 50;
  // We cannot recompute PDI per-row without participant data per row.
  // Instead: approximate session range from absolute extremes seen in session.
  // Use the first and last row's ce.coi + pe.coi as a proxy for spread.
  const firstRow = rows[rows.length - 1];
  const latestRow = rows[0];
  const sessionRange = Math.abs((latestRow.ce.oi ?? 0) - (firstRow.ce.oi ?? 0)) +
                       Math.abs((latestRow.pe.oi ?? 0) - (firstRow.pe.oi ?? 0));
  if (sessionRange < 1) return 50;
  // Normalise current PDI against a reasonable session scale
  const scaled = clamp((currentPdi / (sessionRange * 0.5 + 1)) * 50 + 50, 0, 100);
  return scaled;
}

/**
 * Apply the Flow Persistence filter to a list of alerts.
 * Each alert key (kind:strike:side) is tracked in `alertPersistenceTracker`.
 * - On this build it increments the counter.
 * - Keys NOT in this build's alert list are reset to 0.
 * - `isPersistent` = true when counter ≥ 2 (fired at least twice in a row).
 * - Single-fire alerts: severity capped at WATCH, title prefixed with [FLASH].
 */
function applyFlowPersistence(alerts: VibeAlert[], allKnownKeys: Set<string>): VibeAlert[] {
  // Increment present keys, reset absent keys
  const presentKeys = new Set<string>();
  for (const alert of alerts) {
    const key = `${alert.kind}:${alert.strike ?? "NA"}:${alert.side ?? "NA"}`;
    presentKeys.add(key);
    alertPersistenceTracker.set(key, (alertPersistenceTracker.get(key) ?? 0) + 1);
  }
  // Reset keys that didn't fire this build
  for (const key of allKnownKeys) {
    if (!presentKeys.has(key)) {
      alertPersistenceTracker.set(key, 0);
    }
  }
  // Annotate alerts
  return alerts.map((alert) => {
    const key = `${alert.kind}:${alert.strike ?? "NA"}:${alert.side ?? "NA"}`;
    const count = alertPersistenceTracker.get(key) ?? 1;
    const isPersistent = count >= 2;
    if (isPersistent) {
      return { ...alert, isPersistent: true };
    }
    // Flash: downgrade ACTION → WATCH, prefix title
    return {
      ...alert,
      isPersistent: false,
      severity: alert.severity === "ACTION" ? "WATCH" as const : alert.severity,
      title: `[FLASH] ${alert.title}`
    };
  });
}

function averageNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) {
    return null;
  }
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return (a + b) / 2;
}

function resolveTrendBaselineRow(rows: SnapshotRow[]): { baseline: SnapshotRow; windowMinutes: number; sampleCount: number } | null {
  if (rows.length < 2) {
    return null;
  }

  const current = rows[0];
  const currentMs = new Date(current.timestampIso).getTime();
  if (!Number.isFinite(currentMs)) {
    return null;
  }

  let baselineIndex = -1;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const rowMs = new Date(row.timestampIso).getTime();
    if (!Number.isFinite(rowMs)) {
      continue;
    }
    const age = currentMs - rowMs;
    if (age >= TREND_MIN_WINDOW_MS && age <= TREND_MAX_WINDOW_MS) {
      baselineIndex = index;
    }
  }

  if (baselineIndex < 0) {
    baselineIndex = rows.findIndex((row, index) => {
      if (index === 0) {
        return false;
      }
      const rowMs = new Date(row.timestampIso).getTime();
      return Number.isFinite(rowMs) && currentMs - rowMs >= TREND_MIN_WINDOW_MS;
    });
  }

  if (baselineIndex < 0) {
    baselineIndex = Math.min(rows.length - 1, 9);
  }

  if (baselineIndex <= 0) {
    return null;
  }

  const baseline = rows[baselineIndex];
  const baselineMs = new Date(baseline.timestampIso).getTime();
  if (!Number.isFinite(baselineMs)) {
    return null;
  }

  return {
    baseline,
    windowMinutes: Math.max(1, Math.round((currentMs - baselineMs) / 60_000)),
    sampleCount: baselineIndex + 1
  };
}

function buildTimeline(rows: SnapshotRow[]): { normalizedTimeline: VibeNormalizedPoint[]; ivEcg: VibeEcgPoint[] } {
  const timelineRows = rows.slice(0, MAX_TIMELINE_POINTS).reverse();
  const premiumSeries = timelineRows.map((row) => averageNullable(row.ce.premiumRoc, row.pe.premiumRoc));
  const ivSeries = timelineRows.map((row) => averageNullable(row.ce.ivRoc, row.pe.ivRoc));
  const halchalSeries = timelineRows.map((row) => averageNullable(row.ce.halchalRatio, row.pe.halchalRatio));

  const premiumRange = range(premiumSeries);
  const ivRange = range(ivSeries);
  const halchalRange = range(halchalSeries);

  const normalizedTimeline: VibeNormalizedPoint[] = timelineRows.map((row, index) => ({
    timestampIso: row.timestampIso,
    displayTime: row.displayTime,
    premiumRoc: premiumSeries[index] ?? null,
    ivRoc: ivSeries[index] ?? null,
    halchalRatio: halchalSeries[index] ?? null,
    premiumNorm: normalize(premiumSeries[index] ?? null, premiumRange),
    ivNorm: normalize(ivSeries[index] ?? null, ivRange),
    halchalNorm: normalize(halchalSeries[index] ?? null, halchalRange)
  }));

  const ivEcg: VibeEcgPoint[] = timelineRows.map((row) => ({
    timestampIso: row.timestampIso,
    displayTime: row.displayTime,
    ceIvRoc: row.ce.ivRoc,
    peIvRoc: row.pe.ivRoc
  }));

  return {
    normalizedTimeline,
    ivEcg
  };
}

function buildDiiOffsetAlert(input: {
  participantsSummary: ParticipantsSummary | null;
  bearishChain: boolean;
  marketFlat: boolean;
  timestampIso: string;
}): VibeAlert | null {
  if (!input.participantsSummary || !input.bearishChain || !input.marketFlat) {
    return null;
  }

  const fii = input.participantsSummary.rows.find((row) => row.participant === "FII");
  const dii = input.participantsSummary.rows.find((row) => row.participant === "DII");

  if (!fii || !dii) {
    return null;
  }

  const fiiFuture = fii.todayTradeFlow?.indexFuture ?? fii.today.indexFuture;
  const diiFuture = dii.todayTradeFlow?.indexFuture ?? dii.today.indexFuture;
  const diiStockFuture = dii.today.stockFuture ?? 0;

  if ((fiiFuture ?? 0) >= 0) {
    return null;
  }

  if ((diiFuture ?? 0) <= 0 && diiStockFuture <= 0) {
    return null;
  }

  return buildAlert({
    timestampIso: input.timestampIso,
    kind: "DII_SUPPORT_HOLDING",
    severity: "WATCH",
    title: "DII Support / Holding Level",
    message:
      "Option chain looks bearish but the index is holding flat while DIIs stay net buyers; downside can stay muted.",
  });
}

function dedupeAlerts(alerts: VibeAlert[]): VibeAlert[] {
  const seen = new Set<string>();
  const unique: VibeAlert[] = [];

  for (const alert of alerts) {
    const key = `${alert.kind}:${alert.strike ?? "NA"}:${alert.side ?? "NA"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(alert);
  }

  const rank: Record<VibeAlertSeverity, number> = {
    ACTION: 0,
    WATCH: 1,
    INFO: 2
  };

  unique.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return unique;
}

export function buildVibeAnalysis(input: BuildVibeAnalysisInput): {
  analysis: VibeAnalysis;
  squeezeTracker: IvSqueezeTracker;
} {
  const strikes = [...input.current.snapshot.values()];
  const pulsesWithVolume = strikes.map((strikeRow) => {
    const previousStrike = input.previous?.snapshot.get(strikeRow.strike);
    const olderStrike = input.older?.snapshot.get(strikeRow.strike);

    const ce = toLegView(strikeRow.ce, previousStrike?.ce, olderStrike?.ce);
    const pe = toLegView(strikeRow.pe, previousStrike?.pe, olderStrike?.pe);

    const currentTotalVolume = absOrZero(strikeRow.ce.volume) + absOrZero(strikeRow.pe.volume);

    const totalOiDelta = absOrZero(ce.coi) + absOrZero(pe.coi);
    const smartActivityScore = clamp(
      (absOrZero(ce.halchalRatio) + absOrZero(pe.halchalRatio)) * 130 + (absOrZero(ce.rocIv) + absOrZero(pe.rocIv)) * 0.7,
      0,
      100
    );

    return {
      currentTotalVolume,
      view: {
        strike: strikeRow.strike,
        totalVolumeDelta: currentTotalVolume,
        totalOiDelta,
        smartActivityScore,
        clusteringCoeff: null, // populated after σ computation below
        ce,
        pe
      } satisfies VibeStrikeView
    };
  });

  // ── Clustering coefficients (computed across full session pulse list) ────
  // Must run BEFORE slicing into topActiveStrikes so σ is over the full chain.
  const clusterMap = computeClusteringCoeffs(pulsesWithVolume, input.snapshotCount);
  for (const pulse of pulsesWithVolume) {
    const coeff = clusterMap.get(pulse.view.strike);
    // Use Object.assign to bypass the literal-null narrowing from `satisfies`.
    Object.assign(pulse.view, { clusteringCoeff: (coeff !== undefined && coeff > 0) ? coeff : null });
  }

  const sortedByCurrentVolume = [...pulsesWithVolume].sort((a, b) => b.currentTotalVolume - a.currentTotalVolume);
  const allStrikeValues = pulsesWithVolume.map((item) => item.view.strike);
  const step = strikeStep(allStrikeValues);
  const atmStrike = nearestStrike(allStrikeValues, input.current.spot);

  const atmScoped =
    atmStrike === null
      ? []
      : pulsesWithVolume
          .filter((item) => Math.abs(item.view.strike - atmStrike) <= step * 5)
          .sort((a, b) => b.currentTotalVolume - a.currentTotalVolume);
  const topVolumeWindow = sortedByCurrentVolume.slice(0, Math.min(5, sortedByCurrentVolume.length));

  const selectedMap = new Map<number, (typeof sortedByCurrentVolume)[number]>();
  for (const item of [...atmScoped, ...topVolumeWindow]) {
    selectedMap.set(item.view.strike, item);
  }

  const selectedUniverse = [...selectedMap.values()].sort((a, b) => b.currentTotalVolume - a.currentTotalVolume);
  const focusCount = Math.min(5, selectedUniverse.length === 0 ? 0 : Math.max(3, selectedUniverse.length));
  const focusPool = focusCount > 0 ? selectedUniverse : sortedByCurrentVolume.slice(0, Math.min(5, sortedByCurrentVolume.length));
  const topActiveStrikes = focusPool.slice(0, Math.max(1, focusCount || focusPool.length)).map((item) => item.view);

  const topLegs = topActiveStrikes.flatMap((strike) => [strike.ce, strike.pe]);
  const premiumRange = range(topLegs.map((leg) => leg.rocPremium));
  const ivRange = range(topLegs.map((leg) => leg.rocIv));
  const halchalRange = range(topLegs.map((leg) => leg.halchalRatio));

  for (const strike of topActiveStrikes) {
    strike.ce.normalized = {
      rocPremium: normalize(strike.ce.rocPremium, premiumRange),
      rocIv: normalize(strike.ce.rocIv, ivRange),
      halchalRatio: normalize(strike.ce.halchalRatio, halchalRange)
    };
    strike.pe.normalized = {
      rocPremium: normalize(strike.pe.rocPremium, premiumRange),
      rocIv: normalize(strike.pe.rocIv, ivRange),
      halchalRatio: normalize(strike.pe.halchalRatio, halchalRange)
    };
  }

  let buyPressure = 0;
  let sellPressure = 0;
  let directionalScore = 0;

  for (const strike of topActiveStrikes) {
    for (const [side, leg] of [
      ["CE", strike.ce],
      ["PE", strike.pe]
    ] as const) {
      const activityWeight =
        Math.max(absOrZero(leg.volumeDelta), absOrZero(leg.coi), 1) * (1 + absOrZero(leg.rocIv) / 120);

      if ((leg.rocPremium ?? 0) > 0) {
        buyPressure += activityWeight;
      } else if ((leg.rocPremium ?? 0) < 0) {
        sellPressure += activityWeight;
      }

      directionalScore += directionForLeg(side, leg.coi, leg.rocPremium) * activityWeight;
    }
  }

  const totalPressure = buyPressure + sellPressure;
  const directionalRatio = totalPressure > 0 ? Math.abs(directionalScore) / totalPressure : 0;
  const flowImbalance = totalPressure > 0 ? Math.abs(buyPressure - sellPressure) / totalPressure : 0;

  let netIntent: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  if (directionalRatio >= 0.1) {
    netIntent = directionalScore > 0 ? "LONG" : "SHORT";
  }
  const moneyFlowNeutral = netIntent === "NEUTRAL" || flowImbalance <= 0.14;

  const confidence = clamp(
    netIntent === "NEUTRAL" ? 35 + directionalRatio * 25 : 50 + directionalRatio * 49,
    0,
    99
  );

  const topStrikes = topActiveStrikes.map((item) => item.strike);
  const focusScope =
    atmStrike !== null
      ? `ATM ${atmStrike} +/- 5 strikes + top-volume sort`
      : "top-volume strike sort";
  const rationale =
    topStrikes.length === 0
      ? "Waiting for enough chain snapshots to infer intent."
      : `${netIntent} intent from ${focusScope} (${topStrikes.join(", ")}), using targeted buy/sell pressure only.`;

  const baselineWindow = resolveTrendBaselineRow(input.rows);
  const latestTrendRow = input.rows[0];

  const ceTrendOiDelta =
    baselineWindow && latestTrendRow ? safeDiff(latestTrendRow.ce.oi, baselineWindow.baseline.ce.oi) : null;
  const peTrendOiDelta =
    baselineWindow && latestTrendRow ? safeDiff(latestTrendRow.pe.oi, baselineWindow.baseline.pe.oi) : null;
  const ceTrendVolumeDelta =
    baselineWindow && latestTrendRow ? safeDiff(latestTrendRow.ce.volume, baselineWindow.baseline.ce.volume) : null;
  const peTrendVolumeDelta =
    baselineWindow && latestTrendRow ? safeDiff(latestTrendRow.pe.volume, baselineWindow.baseline.pe.volume) : null;
  const ceTrendPremium =
    baselineWindow && latestTrendRow ? safeRoc(latestTrendRow.ce.ltp, baselineWindow.baseline.ce.ltp) : null;
  const peTrendPremium =
    baselineWindow && latestTrendRow ? safeRoc(latestTrendRow.pe.ltp, baselineWindow.baseline.pe.ltp) : null;
  const ceTrendIv =
    baselineWindow && latestTrendRow ? safeRoc(latestTrendRow.ce.iv, baselineWindow.baseline.ce.iv) : null;
  const peTrendIv =
    baselineWindow && latestTrendRow ? safeRoc(latestTrendRow.pe.iv, baselineWindow.baseline.pe.iv) : null;
  const ceTrendCoiVol =
    ceTrendOiDelta !== null && ceTrendVolumeDelta !== null && ceTrendVolumeDelta > 0.0001
      ? (ceTrendOiDelta * COI_RATIO_LOT_SIZE) / ceTrendVolumeDelta
      : null;
  const peTrendCoiVol =
    peTrendOiDelta !== null && peTrendVolumeDelta !== null && peTrendVolumeDelta > 0.0001
      ? (peTrendOiDelta * COI_RATIO_LOT_SIZE) / peTrendVolumeDelta
      : null;

  const trendSampleCount = baselineWindow?.sampleCount ?? 0;
  const trendWindowMinutes = baselineWindow?.windowMinutes ?? null;

  const ceTrendClassified = classifyTrendReading("CE", {
    sampleCount: trendSampleCount,
    oiDelta: ceTrendOiDelta ?? 0,
    volumeDelta: ceTrendVolumeDelta ?? 0,
    premiumRoc: ceTrendPremium,
    ivRoc: ceTrendIv,
    coiVol: ceTrendCoiVol
  });
  const peTrendClassified = classifyTrendReading("PE", {
    sampleCount: trendSampleCount,
    oiDelta: peTrendOiDelta ?? 0,
    volumeDelta: peTrendVolumeDelta ?? 0,
    premiumRoc: peTrendPremium,
    ivRoc: peTrendIv,
    coiVol: peTrendCoiVol
  });
  const trendSummary =
    trendSampleCount < 2
      ? "Building trend context. Need more continuous samples."
      : `${trendWindowMinutes ?? "--"}m selected-strike trend | CE: ${ceTrendClassified.reading} | PE: ${peTrendClassified.reading}.`;

  const spotDelta = safeDiff(input.current.spot, input.previous?.spot ?? null);
  const marketFlat = spotDelta !== null && Math.abs(spotDelta) <= 18;

  const scenarioPoints: LegScenarioPoint[] = topActiveStrikes.flatMap((strike) => [
    { strike: strike.strike, side: "CE", leg: strike.ce },
    { strike: strike.strike, side: "PE", leg: strike.pe }
  ]);

  const volumeMoves = scenarioPoints.map((point) => absOrZero(point.leg.volumeDelta)).filter((value) => value > 0);
  const currentVolumes = scenarioPoints.map((point) => absOrZero(point.leg.volume)).filter((value) => value > 0);
  const halchalMoves = scenarioPoints.map((point) => absOrZero(point.leg.halchalRatio)).filter((value) => value > 0);
  const ratioDrops = scenarioPoints
    .map((point) => point.leg.rocRatio)
    .filter((value): value is number => value !== null && value < 0)
    .map((value) => Math.abs(value));

  const volumeSpikeThreshold = volumeMoves.length > 0 ? Math.max(1, quantile(volumeMoves, 0.7)) : Number.MAX_SAFE_INTEGER;
  const highVolumeThreshold = currentVolumes.length > 0 ? Math.max(1, quantile(currentVolumes, 0.65)) : Number.MAX_SAFE_INTEGER;
  const halchalThreshold = halchalMoves.length > 0 ? Math.max(0.12, quantile(halchalMoves, 0.65)) : 0.12;
  const ratioDropThreshold = ratioDrops.length > 0 ? Math.max(0.02, quantile(ratioDrops, 0.6)) : 0.02;

  const alerts: VibeAlert[] = [];

  const putBuy = scenarioPoints
    .filter((point) => point.side === "PE")
    .filter(
      (point) =>
        (point.leg.coi ?? 0) > 0 &&
        (point.leg.halchalRatio ?? 0) >= halchalThreshold &&
        (point.leg.rocPremium ?? 0) > 2 &&
        (point.leg.rocIv ?? 0) > 2 &&
        (point.leg.rocRatio ?? 0) > 0
    )
    .sort((a, b) => absOrZero(b.leg.halchalRatio) - absOrZero(a.leg.halchalRatio));

  if (putBuy[0]) {
    alerts.push(
      buildAlert({
        timestampIso: input.current.timestampIso,
        kind: "PUT_BUY_DIRECTIONAL",
        severity: "ACTION",
        title: "Put Buy Directional Setup",
        strike: putBuy[0].strike,
        side: "PE",
        message:
          "PE premium, IV, and Halchal ratio are rising together on high activity. Big players are entering directional bearish exposure.",
      })
    );
  }

  const absorption = scenarioPoints
    .filter((point) => absOrZero(point.leg.volumeDelta) >= volumeSpikeThreshold)
    .filter(
      (point) =>
        absOrZero(point.leg.halchalRatio) >= halchalThreshold &&
        Math.abs(point.leg.rocPremium ?? 0) <= 0.8 &&
        Math.abs(point.leg.ltpDelta ?? 0) <= 2.5
    )
    .sort((a, b) => absOrZero(b.leg.volumeDelta) - absOrZero(a.leg.volumeDelta));

  if (absorption[0]) {
    alerts.push(
      buildAlert({
        timestampIso: input.current.timestampIso,
        kind: "LIQUIDITY_ABSORPTION",
        severity: "WATCH",
        strike: absorption[0].strike,
        side: absorption[0].side,
        title: "Liquidity Absorption",
        message:
          "High volume is getting absorbed without price expansion. Expect chop/range behavior until this absorption phase finishes.",
      })
    );
  }

  const exchange =
    moneyFlowNeutral && marketFlat
      ? scenarioPoints
          .filter(
            (point) =>
              absOrZero(point.leg.volume) >= highVolumeThreshold ||
              absOrZero(point.leg.volumeDelta) >= volumeSpikeThreshold
          )
          .filter((point) => (point.leg.rocRatio ?? 0) <= -ratioDropThreshold)
          .filter(
            (point) =>
              Math.abs(point.leg.rocPremium ?? 0) <= 1.2 &&
              Math.abs(point.leg.ltpDelta ?? 0) <= 2.5
          )
          .sort((a, b) => (a.leg.rocRatio ?? 0) - (b.leg.rocRatio ?? 0))
      : [];

  if (exchange[0]) {
    alerts.push(
      buildAlert({
        timestampIso: input.current.timestampIso,
        kind: "EXCHANGE_OF_HANDS",
        severity: "WATCH",
        strike: exchange[0].strike,
        side: exchange[0].side,
        title: "Exchange of Hands",
        message:
          "Volume is spiking, COI/Volume ROC is falling, money flow is neutral, and price is flat. Sideways/range-bound likely; avoid breakout trades.",
      })
    );
  }

  const aggressiveWriting = scenarioPoints
    .filter((point) => (point.leg.coi ?? 0) > 0)
    .filter(
      (point) =>
        (point.leg.rocPremium ?? 0) <= -6 &&
        ((point.leg.ltpDelta ?? 0) <= -10 || (point.leg.rocPremium ?? 0) <= -10) &&
        absOrZero(point.leg.halchalRatio) >= halchalThreshold
    )
    .sort((a, b) => (a.leg.rocPremium ?? 0) - (b.leg.rocPremium ?? 0));

  const aggressiveCall = aggressiveWriting.find((point) => point.side === "CE");
  if (aggressiveCall) {
    alerts.push(
      buildAlert({
        timestampIso: input.current.timestampIso,
        kind: "AGGRESSIVE_CALL_WRITING",
        severity: "ACTION",
        strike: aggressiveCall.strike,
        side: "CE",
        title: "Aggressive Call Writing",
        message:
          "CE OI is building while premium is dropping fast. This often marks a ceiling zone or near-term downside pressure.",
      })
    );
  }

  const aggressivePut = aggressiveWriting.find((point) => point.side === "PE");
  if (aggressivePut) {
    alerts.push(
      buildAlert({
        timestampIso: input.current.timestampIso,
        kind: "AGGRESSIVE_PUT_WRITING",
        severity: "ACTION",
        strike: aggressivePut.strike,
        side: "PE",
        title: "Aggressive Put Writing",
        message: "PE OI is building while premium is dropping quickly. This behavior usually reinforces support at lower levels.",
      })
    );
  }

  let squeezeTracker: IvSqueezeTracker = { ...input.squeezeTracker };
  let squeezeStatus: VibeSqueezeStatus = {
    active: false,
    status: "IDLE",
    referenceSpot: squeezeTracker.referenceSpot,
    spotMove: null,
    message: "No active IV squeeze condition."
  };

  const ivAbsValues = scenarioPoints
    .map((point) => (point.leg.rocIv === null ? null : Math.abs(point.leg.rocIv)))
    .filter((value): value is number => value !== null);
  const avgIvVolatility = ivAbsValues.length > 0 ? mean(ivAbsValues) : null;
  const squeezeDetected = avgIvVolatility !== null && avgIvVolatility <= 0.65;

  if (squeezeDetected && !squeezeTracker.active) {
    squeezeTracker = {
      active: true,
      startedAtIso: input.current.timestampIso,
      referenceSpot: input.current.spot,
      bars: 0
    };
  }

  if (squeezeTracker.active) {
    squeezeTracker.bars += 1;

    const spotMoveRaw = safeDiff(input.current.spot, squeezeTracker.referenceSpot);
    const spotMove = spotMoveRaw === null ? null : Math.abs(spotMoveRaw);

    if (spotMove !== null && spotMove > 30) {
      alerts.push(
        buildAlert({
          timestampIso: input.current.timestampIso,
          kind: "IV_SQUEEZE_VALIDATED",
          severity: "ACTION",
          title: "IV Squeeze Breakout Validated",
          message: `Momentum validated with ${spotMove.toFixed(1)} point move after squeeze.`
        })
      );

      squeezeStatus = {
        active: false,
        status: "VALIDATED",
        referenceSpot: squeezeTracker.referenceSpot,
        spotMove,
        message: "IV squeeze resolved with valid momentum expansion."
      };

      squeezeTracker = {
        active: false,
        startedAtIso: null,
        referenceSpot: null,
        bars: 0
      };
    } else {
      alerts.push(
        buildAlert({
          timestampIso: input.current.timestampIso,
          kind: "IV_SQUEEZE_WAIT",
          severity: "WATCH",
          title: "IV Squeeze Detected",
          message: "IV Squeeze Detected - WAIT for Momentum Validation (need >30 point move)."
        })
      );

      squeezeStatus = {
        active: true,
        status: "WAITING_VALIDATION",
        referenceSpot: squeezeTracker.referenceSpot,
        spotMove,
        message: "Compression detected. Wait for >30 point move before acting."
      };

      if (squeezeTracker.bars > 36) {
        squeezeTracker = {
          active: false,
          startedAtIso: null,
          referenceSpot: null,
          bars: 0
        };
      }
    }
  }

  const bearishChain = netIntent === "SHORT" || input.radarRegime === "BEARISH" || input.intradayTone === "BEARISH";
  const diiAlert = buildDiiOffsetAlert({
    participantsSummary: input.participantsSummary,
    bearishChain,
    marketFlat,
    timestampIso: input.current.timestampIso
  });
  if (diiAlert) {
    alerts.push(diiAlert);
  }

  // ── Clustering Signal (coefficients already populated above) ────────────
  // Check if any top strike has a strong clustering signal (≥6/10)
  const clusteringStrike = topActiveStrikes.find((s) => (s.clusteringCoeff ?? 0) >= 6);
  if (clusteringStrike) {
    alerts.push(
      buildAlert({
        timestampIso: input.current.timestampIso,
        kind: "FLOW_CLUSTERING",
        severity: "WATCH",
        strike: clusteringStrike.strike,
        title: `Clustering at ${clusteringStrike.strike}`,
        message:
          `Both volume and OI delta at ${clusteringStrike.strike} are >1σ above session mean ` +
          `(Cluster Score ${(clusteringStrike.clusteringCoeff ?? 0).toFixed(1)}/10). ` +
          `Professional accumulation phase may be starting.`
      })
    );
  }

  // ── Positioning Divergence Index ──────────────────────────────────────────
  const rawPdi = computeRawPdi(input.participantsSummary);
  const pdiPercentile = rawPdi !== null ? computePdiPercentile(rawPdi, input.rows) : null;
  const isTrapSpring =
    pdiPercentile !== null &&
    pdiPercentile >= 90 &&
    clusteringStrike !== undefined;

  if (isTrapSpring) {
    alerts.push(
      buildAlert({
        timestampIso: input.current.timestampIso,
        kind: "TRAP_SPRING",
        severity: "ACTION",
        strike: clusteringStrike?.strike,
        title: "⚠ TRAP SPRING — High-Probability Trap Setup",
        message:
          `Positioning Divergence Index at ${pdiPercentile?.toFixed(0)}th percentile (retail vs FII/PRO) ` +
          `AND clustering detected at ${clusteringStrike?.strike ?? "—"}. ` +
          `Classic precondition for a professionally engineered trap. Avoid chasing breakouts.`
      })
    );
  }

  const timeline = buildTimeline(input.rows);

  // ── Flow Persistence Deduplication ───────────────────────────────────────
  // Build a combined registry of all alert keys we've ever seen so absent
  // ones can be reset in the persistence tracker.
  const deduped = dedupeAlerts(alerts);
  const allKnownKeys = new Set<string>(
    [...alertPersistenceTracker.keys()]
  );
  const uniqueAlerts = applyFlowPersistence(deduped, allKnownKeys);

  return {
    analysis: {
      capture: {
        activeStrikes: input.current.snapshot.size,
        snapshotsCaptured: input.snapshotCount,
        captureIntervalMs:
          input.previous !== undefined
            ? Math.max(0, new Date(input.current.timestampIso).getTime() - new Date(input.previous.timestampIso).getTime())
            : null,
        latestTimestampIso: input.current.timestampIso
      },
      topActiveStrikes,
      smartMoneyFlow: {
        topStrikes,
        buyPressure,
        sellPressure,
        netIntent,
        confidence,
        rationale
      },
      trend: {
        windowMinutes: trendWindowMinutes,
        sampleCount: trendSampleCount,
        ce: {
          reading: ceTrendClassified.reading,
          confidence: ceTrendClassified.confidence,
          oiDelta: ceTrendOiDelta,
          volumeDelta: ceTrendVolumeDelta,
          premiumRoc: ceTrendPremium,
          ivRoc: ceTrendIv,
          coiVol: ceTrendCoiVol
        },
        pe: {
          reading: peTrendClassified.reading,
          confidence: peTrendClassified.confidence,
          oiDelta: peTrendOiDelta,
          volumeDelta: peTrendVolumeDelta,
          premiumRoc: peTrendPremium,
          ivRoc: peTrendIv,
          coiVol: peTrendCoiVol
        },
        summary: trendSummary
      },
      alerts: uniqueAlerts,
      ivSqueeze: squeezeStatus,
      normalizedTimeline: timeline.normalizedTimeline,
      ivEcg: timeline.ivEcg
    },
    squeezeTracker
  };
}

export function emptyVibeAnalysis(timestampIso?: string): VibeAnalysis {
  return {
    capture: {
      activeStrikes: 0,
      snapshotsCaptured: 0,
      captureIntervalMs: null,
      latestTimestampIso: timestampIso ?? null
    },
    topActiveStrikes: [],
    smartMoneyFlow: {
      topStrikes: [],
      buyPressure: 0,
      sellPressure: 0,
      netIntent: "NEUTRAL",
      confidence: 0,
      rationale: "Waiting for first complete chain snapshot."
    },
    trend: {
      windowMinutes: null,
      sampleCount: 0,
      ce: {
        reading: "Insufficient Trend Data",
        confidence: 0,
        oiDelta: null,
        volumeDelta: null,
        premiumRoc: null,
        ivRoc: null,
        coiVol: null
      },
      pe: {
        reading: "Insufficient Trend Data",
        confidence: 0,
        oiDelta: null,
        volumeDelta: null,
        premiumRoc: null,
        ivRoc: null,
        coiVol: null
      },
      summary: "Building trend context. Need more continuous samples."
    },
    alerts: [],
    ivSqueeze: {
      active: false,
      status: "IDLE",
      referenceSpot: null,
      spotMove: null,
      message: "No active IV squeeze condition."
    },
    normalizedTimeline: [],
    ivEcg: []
  };
}
