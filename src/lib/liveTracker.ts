import { istDisplayTime, istTradeDate, safeDiff, safeRoc, toIstIso } from "@/lib/math";
import { persistLiveBackup, readLiveBackupSession } from "@/lib/backupStore";
import { applyRegimeVerdicts } from "@/lib/regimeEngine";
import { loadChainDayBaseline, loadStrikeHistoryRows, persistChainCapture } from "@/lib/chainCaptureStore";
import { extractRegimeShiftEvents } from "@/lib/events";
import { nextMockStrike } from "@/lib/mock";
import { buildEodTally, buildParticipantEodIntel, loadEodBundle } from "@/lib/participants";
import { learnPatternMemoryFromPayload } from "@/lib/patternMemory";
import { buildSmartMoneyRadar, type ChainSnapshotMap } from "@/lib/radarEngine";
import { buildIntradaySummary, classifySignal } from "@/lib/signalEngine";
import { fetchNiftyWeekMonthChains, type ParsedChainStrike } from "@/lib/brokers/upstox";
import {
  buildVibeAnalysis,
  INITIAL_IV_SQUEEZE_TRACKER,
  type IvSqueezeTracker
} from "@/lib/vibeEngine";
import type { ChainDisplaySnapshot, IndexSymbol, LegMetrics, LiveApiResponse, SnapshotRow } from "@/lib/types";

/** Per-strike OHLC accumulator for computing NT = (O+C)/(H+L) per Nitin Bhatia */
interface OhlcWindow {
  windowStartMs: number;
  ceOpen: number | null;
  ceHigh: number | null;
  ceLow: number | null;
  peOpen: number | null;
  peHigh: number | null;
  peLow: number | null;
  /** NT computed from the last completed window — null until first full window */
  lastNt: { ce: number | null; pe: number | null };
}

interface SeriesState {
  rows: SnapshotRow[];
  chainSnapshot: ChainSnapshotMap;
  radar: LiveApiResponse["radar"];
  pollCount: number;
  refreshCount: number;
  lastUpdatedIso: string;
  strike: number;
  ohlc: OhlcWindow;
}

interface ChainCaptureFrame {
  timestampIso: string;
  displayTime: string;
  spot: number | null;
  snapshot: ChainSnapshotMap;
}

interface VibeSessionState {
  frames: ChainCaptureFrame[];
  squeezeTracker: IvSqueezeTracker;
}

const MAX_HISTORY = 1500;
const MAX_CHAIN_HISTORY = 360;
const stateStore = new Map<string, SeriesState>();
const radarSnapshotStore = new Map<string, ChainSnapshotMap>();
const vibeSessionStore = new Map<string, VibeSessionState>();
const SAMPLE_MIN_GAP_MS = Math.max(400, Number(process.env.SAMPLE_MIN_GAP_MS ?? 2800));
// Set to 185s (slightly under the 188s client poll) so the server ALWAYS captures
// on the client's 188s poll cycle, even with minor network/JS-timer drift.
const SAMPLE_FORCE_INTERVAL_MS = Math.max(60_000, Number(process.env.SAMPLE_FORCE_INTERVAL_MS ?? 185_000));
const COI_RATIO_LOT_SIZE = Math.max(1, Number(process.env.COI_RATIO_LOT_SIZE ?? 65));

function seriesKey(index: IndexSymbol, strike: number, tradeDate: string, expiryDate: string | null): string {
  return `${index}:${strike}:${tradeDate}:${expiryDate ?? "AUTO"}`;
}

function radarKey(index: IndexSymbol, tradeDate: string, expiryDate: string | null): string {
  return `${index}:${tradeDate}:${expiryDate ?? "AUTO"}`;
}

function metricChanged(previous: number | null, current: number | null): boolean {
  if (previous === null && current === null) {
    return false;
  }
  if (previous === null || current === null) {
    return true;
  }
  return Math.abs(previous - current) > 0.0001;
}

function hasLegChanged(previous: LegMetrics, current: LegMetrics): boolean {
  return (
    metricChanged(previous.oi, current.oi) ||
    metricChanged(previous.volume, current.volume) ||
    metricChanged(previous.iv, current.iv) ||
    metricChanged(previous.ltp, current.ltp)
  );
}

function elapsedMs(previousIso: string, currentIso: string): number {
  const start = new Date(previousIso).getTime();
  const end = new Date(currentIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, end - start);
}

function shouldAppendSample(previous: SnapshotRow | undefined, current: SnapshotRow): boolean {
  if (!previous) {
    return true;
  }

  const age = elapsedMs(previous.timestampIso, current.timestampIso);
  if (age < SAMPLE_MIN_GAP_MS) {
    return false;
  }

  const changed =
    previous.strike !== current.strike ||
    previous.source !== current.source ||
    hasLegChanged(previous.ce, current.ce) ||
    hasLegChanged(previous.pe, current.pe);

  if (changed) {
    return true;
  }

  return SAMPLE_FORCE_INTERVAL_MS > 0 && age >= SAMPLE_FORCE_INTERVAL_MS;
}

/** NT = (Open + Close) / (High + Low) per Nitin Bhatia */
function computeNt(open: number | null, close: number | null, high: number | null, low: number | null): number | null {
  if (open === null || close === null || high === null || low === null) return null;
  const denom = high + low;
  if (denom < 0.001) return null;
  return (open + close) / denom;
}

function updateOhlcWindow(
  existing: OhlcWindow | undefined,
  ceLtp: number | null,
  peLtp: number | null,
  nowMs: number
): OhlcWindow {
  const windowIntervalMs = SAMPLE_FORCE_INTERVAL_MS;
  const isNewWindow = !existing || nowMs - existing.windowStartMs >= windowIntervalMs;

  if (isNewWindow && existing) {
    // Finalize the completed window to get NT, then start fresh
    const completedNt = {
      ce: computeNt(existing.ceOpen, existing.ceOpen !== null ? ceLtp ?? existing.ceOpen : null, existing.ceHigh, existing.ceLow),
      pe: computeNt(existing.peOpen, existing.peOpen !== null ? peLtp ?? existing.peOpen : null, existing.peHigh, existing.peLow)
    };
    return {
      windowStartMs: nowMs,
      ceOpen: ceLtp,
      ceHigh: ceLtp,
      ceLow: ceLtp,
      peOpen: peLtp,
      peHigh: peLtp,
      peLow: peLtp,
      lastNt: completedNt
    };
  }

  if (!existing) {
    return {
      windowStartMs: nowMs,
      ceOpen: ceLtp,
      ceHigh: ceLtp,
      ceLow: ceLtp,
      peOpen: peLtp,
      peHigh: peLtp,
      peLow: peLtp,
      lastNt: { ce: null, pe: null }
    };
  }

  // Update running OHLC within the current window
  const ceHigh = ceLtp !== null ? Math.max(existing.ceHigh ?? ceLtp, ceLtp) : existing.ceHigh;
  const ceLow = ceLtp !== null ? Math.min(existing.ceLow ?? ceLtp, ceLtp) : existing.ceLow;
  const peHigh = peLtp !== null ? Math.max(existing.peHigh ?? peLtp, peLtp) : existing.peHigh;
  const peLow = peLtp !== null ? Math.min(existing.peLow ?? peLtp, peLtp) : existing.peLow;

  return {
    ...existing,
    ceHigh,
    ceLow,
    peHigh,
    peLow,
    lastNt: existing.lastNt
  };
}

function resolvePreviousDayOiBaseline(rows: SnapshotRow[] | undefined, tradeDate: string): {
  ceOi: number | null;
  peOi: number | null;
} {
  if (!rows || rows.length === 0) {
    return {
      ceOi: null,
      peOi: null
    };
  }

  for (const row of rows) {
    const rowDate = istTradeDate(new Date(row.timestampIso));
    if (rowDate < tradeDate) {
      return {
        ceOi: row.ce.oi ?? null,
        peOi: row.pe.oi ?? null
      };
    }
  }

  return {
    ceOi: null,
    peOi: null
  };
}

function toLeg(
  current: { oi: number | null; volume: number | null; iv: number | null; ltp: number | null; numberOfTrades?: number | null },
  previous: LegMetrics | null,
  previousDayOi: number | null,
  nt: number | null,
  spot: number | null
): LegMetrics {
  const oi = current.oi;
  const volume = current.volume;
  const iv = current.iv;
  const ltp = current.ltp;
  const numberOfTrades = current.numberOfTrades ?? null;

  const prevOi = previous?.oi ?? null;
  const prevVolume = previous?.volume ?? null;
  const prevIv = previous?.iv ?? null;
  const prevLtp = previous?.ltp ?? null;

  const coi = safeDiff(oi, prevOi);
  const volumeDiff = safeDiff(volume, prevVolume);
  const dayCoi = oi !== null && previousDayOi !== null ? oi - previousDayOi : null;
  const dayCoiQty = dayCoi !== null ? dayCoi * COI_RATIO_LOT_SIZE : null;
  const coiQty = coi !== null ? coi * COI_RATIO_LOT_SIZE : null;

  // Positional COI/Vol: day-over-day OI change vs total session volume
  // Measures multi-day conviction — is OI being built vs just day-traded?
  const positional =
    dayCoiQty !== null && volume !== null && volume > 0.0001 ? dayCoiQty / volume : null;

  // ─── Nitin Bhatia Intraday COI/Vol ───────────────────────────────────────
  // Correct formula: intraday = (ΔCOI × lot_size) / (TQ / NT)
  //   where TQ = total traded quantity (volume), NT = number of trades
  //   TQ/NT = average trade size — large avg size = institutional, small = retail noise
  //   Simplifies to: (ΔCOI × lot_size × NT) / TQ
  //
  // Priority:
  //   1. Real NT from Upstox/NSE market_data.no_of_trades  ← correct formula
  //   2. OHLC-derived NT = (O+C)/(H+L)                    ← proxy fallback
  //   3. volumeDiff between snapshots                      ← last-resort fallback
  let intraday: number | null = null;

  if (coiQty !== null) {
    if (numberOfTrades !== null && numberOfTrades > 0 && volume !== null && volume > 0.0001) {
      // Correct Nitin Bhatia: ΔCOI_qty × NT / TQ
      intraday = (coiQty * numberOfTrades) / volume;
    } else if (nt !== null && nt > 0.001) {
      // OHLC proxy fallback: ΔCOI_qty / NT_ohlc
      intraday = coiQty / nt;
    } else if (volumeDiff !== null && volumeDiff > 0.0001) {
      // Last-resort: ΔCOI_qty / ΔVolume
      intraday = coiQty / volumeDiff;
    }
  }

  const ratioRoc = safeDiff(intraday, previous?.intraday ?? null);
  const activityRatio = coi !== null && volume !== null && volume > 0 ? Math.abs(coi) / volume : null;

  // Money flow shortcut: spot × Δ OI (Nitin Bhatia futures proxy)
  const oiRocVal = safeDiff(oi, prevOi);
  const moneyFlow = spot !== null && oiRocVal !== null ? spot * oiRocVal : null;

  return {
    oi,
    volume,
    iv,
    ltp,
    coi,
    dayCoi,
    oiRoc: safeRoc(oi, prevOi),
    volumeRoc: safeRoc(volume, prevVolume),
    ltpChg: safeDiff(ltp, prevLtp),
    // Absolute difference (not %) per Nitin Bhatia's ROC definition
    ivRoc: safeDiff(iv, prevIv),
    premiumRoc: safeDiff(ltp, prevLtp),
    ratioRoc,
    positional,
    intraday,
    coiVol: intraday,
    halchalRatio: intraday,
    activityRatio,
    nt,
    numberOfTrades,
    moneyFlow
  };
}

function chooseBestStrike(rows: ParsedChainStrike[], requestedStrike?: number): ParsedChainStrike {
  if (rows.length === 0) {
    throw new Error("Option chain is empty.");
  }

  if (typeof requestedStrike === "number" && Number.isFinite(requestedStrike)) {
    const exact = rows.find((row) => row.strike === requestedStrike);
    if (exact) {
      return exact;
    }

    return [...rows].sort((a, b) => Math.abs(a.strike - requestedStrike) - Math.abs(b.strike - requestedStrike))[0];
  }

  const underlying = rows.find((row) => row.underlying !== null)?.underlying;
  if (underlying !== null && underlying !== undefined) {
    return [...rows].sort((a, b) => Math.abs(a.strike - underlying) - Math.abs(b.strike - underlying))[0];
  }

  return rows[Math.floor(rows.length / 2)];
}

function resolveSpot(rows: ParsedChainStrike[], fallback: number | null = null): number | null {
  const direct = rows.find((row) => row.underlying !== null)?.underlying;
  if (direct !== null && direct !== undefined) {
    return direct;
  }
  return fallback;
}

function buildChainSnapshot(input: {
  rows: ParsedChainStrike[];
  expiryDate: string | null;
  spot: number | null;
  window?: number;
  oiBaseline?: Map<number, { ceOi: number | null; peOi: number | null }>;
}): ChainDisplaySnapshot {
  const window = Math.max(5, input.window ?? 17);
  const sorted = [...input.rows].sort((a, b) => a.strike - b.strike);
  if (sorted.length === 0) {
    return {
      expiryDate: input.expiryDate,
      spot: input.spot,
      rows: []
    };
  }

  const anchorSpot = resolveSpot(sorted, input.spot);
  const centerIndex =
    anchorSpot !== null
      ? sorted.reduce((best, row, index) => {
        const currentDistance = Math.abs(row.strike - anchorSpot);
        if (currentDistance < best.distance) {
          return {
            index,
            distance: currentDistance
          };
        }
        return best;
      }, { index: 0, distance: Number.MAX_SAFE_INTEGER }).index
      : Math.floor(sorted.length / 2);

  const half = Math.floor(window / 2);
  const start = Math.max(0, centerIndex - half);
  const end = Math.min(sorted.length, start + window);
  const slice = sorted.slice(Math.max(0, end - window), end);
  const spotStrike = sorted[centerIndex]?.strike ?? null;

  return {
    expiryDate: input.expiryDate,
    spot: anchorSpot,
    rows: slice.map((row) => {
      const base = input.oiBaseline?.get(row.strike);
      const ceCoi = row.ce.oi !== null && base?.ceOi !== null && base?.ceOi !== undefined
        ? row.ce.oi - base.ceOi : null;
      const peCoi = row.pe.oi !== null && base?.peOi !== null && base?.peOi !== undefined
        ? row.pe.oi - base.peOi : null;
      return {
        strike: row.strike,
        spot: anchorSpot,
        isSpotRow: spotStrike !== null && row.strike === spotStrike,
        ce: {
          oi: row.ce.oi,
          volume: row.ce.volume,
          iv: row.ce.iv,
          ltp: row.ce.ltp,
          coi: ceCoi
        },
        pe: {
          oi: row.pe.oi,
          volume: row.pe.volume,
          iv: row.pe.iv,
          ltp: row.pe.ltp,
          coi: peCoi
        }
      };
    })
  };
}

function nextRowFromParsed(
  parsed: ParsedChainStrike,
  previous: SnapshotRow | undefined,
  previousDayBaseline: { ceOi: number | null; peOi: number | null },
  source: "upstox" | "mock",
  timestampIso: string,
  ohlcNt: { ce: number | null; pe: number | null }
): SnapshotRow {
  const spot = parsed.underlying;
  const ce = toLeg(parsed.ce, previous?.ce ?? null, previousDayBaseline.ceOi, ohlcNt.ce, spot);
  const pe = toLeg(parsed.pe, previous?.pe ?? null, previousDayBaseline.peOi, ohlcNt.pe, spot);

  const base: SnapshotRow = {
    id: `${timestampIso}-${parsed.strike}`,
    timestampIso,
    displayTime: istDisplayTime(timestampIso),
    spot: parsed.underlying,
    strike: parsed.strike,
    ce,
    pe,
    signal: {
      kind: "NEUTRAL",
      side: "BOTH",
      confidence: 0,
      score: 0,
      reasons: ["Bootstrapping"]
    },
      market: {
        regime: "NEUTRAL",
        tone: "NEUTRAL",
        rowColor: "NONE",
        verdict: "Neutral Structure: No high-conviction smart-money footprint.",
        flags: {
          exchangeOfHands: false,
          highConvictionWriting: false,
          panicCovering: false
        },
        ceAr: ce.activityRatio,
        peAr: pe.activityRatio,
        dominantLeg: "BOTH"
      },
    source
  };

  base.signal = classifySignal(base, previous ? [previous] : []);
  return base;
}

function cloneSnapshot(snapshot: ChainSnapshotMap): ChainSnapshotMap {
  const cloned: ChainSnapshotMap = new Map();
  for (const [strike, row] of snapshot.entries()) {
    cloned.set(strike, {
      strike,
      underlying: row.underlying,
      ce: {
        oi: row.ce.oi,
        volume: row.ce.volume,
        iv: row.ce.iv,
        ltp: row.ce.ltp
      },
      pe: {
        oi: row.pe.oi,
        volume: row.pe.volume,
        iv: row.pe.iv,
        ltp: row.pe.ltp
      }
    });
  }
  return cloned;
}

function applySignalHistory(state: SeriesState): void {
  const history = [...state.rows];
  for (let index = 0; index < state.rows.length; index += 1) {
    const current = state.rows[index];
    const prior = history.slice(index + 1, index + 70);
    current.signal = classifySignal(current, prior);
  }
}

function fallbackMock(index: IndexSymbol, strike: number): ParsedChainStrike {
  const mock = nextMockStrike(index, strike);
  return {
    strike,
    underlying: mock.spot,
    ce: {
      oi: mock.ceOi,
      volume: mock.ceVolume,
      iv: mock.ceIv,
      ltp: mock.ceLtp,
      numberOfTrades: null
    },
    pe: {
      oi: mock.peOi,
      volume: mock.peVolume,
      iv: mock.peIv,
      ltp: mock.peLtp,
      numberOfTrades: null
    }
  };
}

export async function getLivePayload(input: {
  index: IndexSymbol;
  strike?: number;
  tradeDate?: string;
  expiryDate?: string;
}): Promise<LiveApiResponse> {
  const index: IndexSymbol = input.index ?? "NIFTY";
  const today = istTradeDate();
  const tradeDate = input.tradeDate ?? today;
  const isPastDate = tradeDate < today;
  const requestedStrike = input.strike ?? 24_900;

  const warnings: string[] = [];
  if (input.index && input.index !== "NIFTY") {
    warnings.push("Tracking is locked to NIFTY only (current week + month-end expiry).");
  }

  // ── Past-date guard ──────────────────────────────────────────────────────────
  // For any date before today we must NEVER attempt a live Upstox fetch because
  // the API returns current market data regardless of the date parameter.  That
  // would silently overwrite the historical backup file with today's data.
  // Instead: serve from the backup archive only; throw if no backup exists.
  if (isPastDate) {
    const historicalBackup = await readLiveBackupSession(tradeDate, index, requestedStrike, null);
    if (historicalBackup) {
      warnings.push(`Served from backup archive for ${tradeDate}`);
      return {
        index: historicalBackup.index,
        strike: historicalBackup.strike,
        expiryDate: historicalBackup.expiryDate,
        monthExpiryDate: historicalBackup.expiryDate,
        underlyingSpot: historicalBackup.underlyingSpot,
        tradeDate: historicalBackup.tradeDate,
        pollCount: historicalBackup.pollCount,
        refreshCount: historicalBackup.refreshCount,
        lastUpdatedIso: historicalBackup.lastUpdatedIso,
        weeklyChain: { expiryDate: historicalBackup.expiryDate, spot: historicalBackup.underlyingSpot, rows: [] },
        monthlyChain: { expiryDate: historicalBackup.expiryDate, spot: historicalBackup.underlyingSpot, rows: [] },
        rows: historicalBackup.rows,
        events: historicalBackup.events,
        radar: historicalBackup.radar,
        vibe: historicalBackup.vibe,
        intradaySummary: historicalBackup.intradaySummary,
        participantsSummary: historicalBackup.participantsSummary,
        participantIntel: historicalBackup.participantIntel,
        eodCorrelation: historicalBackup.eodCorrelation,
        eodTally: historicalBackup.eodTally,
        backupInfo: null,
        warnings
      };
    }
    throw new Error(
      `No backup data available for ${tradeDate}. Historical data was not captured for this date.`
    );
  }
  // ────────────────────────────────────────────────────────────────────────────

  let selected: ParsedChainStrike;
  let weeklyChainRows: ParsedChainStrike[] = [];
  let monthlyChainRows: ParsedChainStrike[] = [];
  let expiryResolved: string | null = null;
  let monthExpiryResolved: string | null = null;
  let underlyingSpot: number | null = null;
  let source: "upstox" | "mock" = "upstox";

  try {
    const chains = await fetchNiftyWeekMonthChains(tradeDate);
    weeklyChainRows = chains.weekly.rows;
    monthlyChainRows = chains.monthly.rows;
    selected = chooseBestStrike(weeklyChainRows, requestedStrike);
    expiryResolved = chains.weekly.expiryDate;
    monthExpiryResolved = chains.monthly.expiryDate;
    underlyingSpot = resolveSpot(weeklyChainRows, selected.underlying);
  } catch (error) {
    const historicalBackup = await readLiveBackupSession(tradeDate, index, requestedStrike, null);
    if (historicalBackup) {
      warnings.push(`Served from backup archive for ${tradeDate}`);
      return {
        index: historicalBackup.index,
        strike: historicalBackup.strike,
        expiryDate: historicalBackup.expiryDate,
        monthExpiryDate: historicalBackup.expiryDate,
        underlyingSpot: historicalBackup.underlyingSpot,
        tradeDate: historicalBackup.tradeDate,
        pollCount: historicalBackup.pollCount,
        refreshCount: historicalBackup.refreshCount,
        lastUpdatedIso: historicalBackup.lastUpdatedIso,
        weeklyChain: { expiryDate: historicalBackup.expiryDate, spot: historicalBackup.underlyingSpot, rows: [] },
        monthlyChain: { expiryDate: historicalBackup.expiryDate, spot: historicalBackup.underlyingSpot, rows: [] },
        rows: historicalBackup.rows,
        events: historicalBackup.events,
        radar: historicalBackup.radar,
        vibe: historicalBackup.vibe,
        intradaySummary: historicalBackup.intradaySummary,
        participantsSummary: historicalBackup.participantsSummary,
        participantIntel: historicalBackup.participantIntel,
        eodCorrelation: historicalBackup.eodCorrelation,
        eodTally: historicalBackup.eodTally,
        backupInfo: null,
        warnings
      };
    }

    const allowMock = (process.env.ALLOW_MOCK_DATA ?? "true").toLowerCase() === "true";
    if (!allowMock) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Upstox fetch failed";
    warnings.push(`Using mock stream because live fetch failed: ${message}`);
    selected = fallbackMock(index, requestedStrike);
    weeklyChainRows = [selected];
    monthlyChainRows = [selected];
    expiryResolved = null;
    monthExpiryResolved = null;
    underlyingSpot = selected.underlying;
    source = "mock";
  }

  const key = seriesKey(index, selected.strike, tradeDate, expiryResolved);
  const radarSessionKey = radarKey(index, tradeDate, expiryResolved);

  // ── Cold-start hydration ─────────────────────────────────────────────────
  // When the dev/prod server restarts the in-memory stateStore is wiped.
  // For today's date we never read the backup in the normal flow (only past
  // dates do).  So on the FIRST poll after a restart (existing === undefined)
  // we load today's backup session and seed stateStore with the persisted rows.
  // This means the very first response already contains hours of history.
  let existing = stateStore.get(key);
  if (!existing && tradeDate === today) {
    try {
      const coldBackup = await readLiveBackupSession(tradeDate, index, selected.strike, expiryResolved);
      if (coldBackup && coldBackup.rows.length > 0) {
        const seedState: SeriesState = {
          rows: coldBackup.rows,
          chainSnapshot: new Map(),
          radar: coldBackup.radar,
          pollCount: coldBackup.pollCount,
          refreshCount: coldBackup.refreshCount,
          lastUpdatedIso: coldBackup.lastUpdatedIso,
          strike: coldBackup.strike,
          ohlc: {
            windowStartMs: Date.now(),
            ceOpen: null, ceHigh: null, ceLow: null,
            peOpen: null, peHigh: null, peLow: null,
            lastNt: { ce: null, pe: null }
          }
        };
        // Re-apply signals so they match the persisted analysis
        applySignalHistory(seedState);
        applyRegimeVerdicts(seedState.rows);
        stateStore.set(key, seedState);
        existing = seedState;
        warnings.push(`Cold-start: hydrated ${seedState.rows.length} rows from today's backup.`);
      }
    } catch {
      // Non-fatal — proceed with empty state; rows will accumulate normally.
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  const previous = existing?.rows[0];
  const previousDayBaseline = resolvePreviousDayOiBaseline(existing?.rows, tradeDate);
  const sampleTimestampIso = toIstIso();
  const previousRadarSnapshot = radarSnapshotStore.get(radarSessionKey) ?? existing?.chainSnapshot ?? new Map();
  const radarResult = buildSmartMoneyRadar({
    index,
    spot: underlyingSpot,
    chainRows: weeklyChainRows,
    previousSnapshot: previousRadarSnapshot
  });

  const radar = radarResult.radar;

  // Update the per-strike OHLC accumulator and compute NT = (O+C)/(H+L)
  const nowMs = Date.now();
  const updatedOhlc = updateOhlcWindow(existing?.ohlc, selected.ce.ltp, selected.pe.ltp, nowMs);
  const ohlcNt = updatedOhlc.lastNt;

  const row = nextRowFromParsed(selected, previous, previousDayBaseline, source, sampleTimestampIso, ohlcNt);
  const vibeSession = vibeSessionStore.get(radarSessionKey) ?? {
    frames: [],
    squeezeTracker: INITIAL_IV_SQUEEZE_TRACKER
  };
  const previousFrame = vibeSession.frames[0];
  const olderFrame = vibeSession.frames[1];

  const currentFrame: ChainCaptureFrame = {
    timestampIso: row.timestampIso,
    displayTime: row.displayTime,
    spot: underlyingSpot,
    snapshot: cloneSnapshot(radarResult.nextSnapshot)
  };
  const nextFrames = [currentFrame, ...vibeSession.frames].slice(0, MAX_CHAIN_HISTORY);

  let historicalRows: SnapshotRow[] = [];
  try {
    // Only persist to disk for today's date — never write live data to past-date files.
    if (tradeDate === today) {
      await persistChainCapture({
        tradeDate,
        index,
        expiryDate: expiryResolved,
        spot: underlyingSpot,
        timestampIso: sampleTimestampIso,
        displayTime: row.displayTime,
        source,
        chainRows: weeklyChainRows
      });

      if (monthExpiryResolved !== expiryResolved) {
        await persistChainCapture({
          tradeDate,
          index,
          expiryDate: monthExpiryResolved,
          spot: resolveSpot(monthlyChainRows, underlyingSpot),
          timestampIso: sampleTimestampIso,
          displayTime: row.displayTime,
          source,
          chainRows: monthlyChainRows
        });
      }
    }

    historicalRows = await loadStrikeHistoryRows({
      tradeDate,
      index,
      expiryDate: expiryResolved,
      strike: selected.strike,
      maxRows: MAX_HISTORY
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "strike history capture failed";
    warnings.push(`Strike history warning: ${message}`);
  }

  const shouldAppend = shouldAppendSample(previous, row);
  const fallbackRows = shouldAppend ? [row, ...(existing?.rows ?? [])].slice(0, MAX_HISTORY) : existing?.rows ?? [row];
  const rows = historicalRows.length > 0 ? historicalRows : fallbackRows;
  const latestRowIso = rows[0]?.timestampIso ?? row.timestampIso;
  const hasLatestChanged = existing ? existing.lastUpdatedIso !== latestRowIso : true;
  const refreshCount = hasLatestChanged ? (existing?.refreshCount ?? 0) + 1 : existing?.refreshCount ?? 1;
  const lastUpdatedIso = latestRowIso;

  const nextState: SeriesState = {
    rows,
    chainSnapshot: radarResult.nextSnapshot,
    radar,
    pollCount: (existing?.pollCount ?? 0) + 1,
    refreshCount,
    lastUpdatedIso,
    strike: selected.strike,
    ohlc: updatedOhlc
  };

  if (historicalRows.length === 0 && shouldAppend) {
    applySignalHistory(nextState);
    applyRegimeVerdicts(nextState.rows);
  }
  stateStore.set(key, nextState);
  radarSnapshotStore.set(radarSessionKey, radarResult.nextSnapshot);

  const intradaySummary = buildIntradaySummary(nextState.rows);
  const eodBundle = await loadEodBundle(tradeDate, intradaySummary);
  const events = extractRegimeShiftEvents(nextState.rows);
  const eodTally = buildEodTally(nextState.rows, events, eodBundle.participantsSummary, radar);
  const vibeResult = buildVibeAnalysis({
    current: currentFrame,
    previous: previousFrame,
    older: olderFrame,
    rows: nextState.rows,
    snapshotCount: nextFrames.length,
    participantsSummary: eodBundle.participantsSummary,
    radarRegime: radar.regime,
    intradayTone: intradaySummary.marketTone,
    squeezeTracker: vibeSession.squeezeTracker
  });
  const participantIntel = buildParticipantEodIntel({
    participantsSummary: eodBundle.participantsSummary,
    topActiveStrikes: vibeResult.analysis.topActiveStrikes,
    spot: underlyingSpot
  });

  vibeSessionStore.set(radarSessionKey, {
    frames: nextFrames,
    squeezeTracker: vibeResult.squeezeTracker
  });

  warnings.push(...eodBundle.warnings);

  let backupInfo = null;
  // Only persist backup for today's date — never overwrite past-date archive files.
  if (tradeDate === today) {
    try {
      backupInfo = await persistLiveBackup({
        index,
        strike: selected.strike,
        expiryDate: expiryResolved,
        underlyingSpot,
        tradeDate,
        pollCount: nextState.pollCount,
        refreshCount: nextState.refreshCount,
        lastUpdatedIso: nextState.lastUpdatedIso,
        rows: nextState.rows,
        events,
        radar,
        vibe: vibeResult.analysis,
        intradaySummary,
        participantsSummary: eodBundle.participantsSummary,
        participantIntel,
        eodCorrelation: eodBundle.eodCorrelation,
        eodTally
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backup persistence failed.";
      warnings.push(`Backup warning: ${message}`);
    }
  }

  // Load day-open OI baseline for COI computation (non-blocking — failures return empty map)
  const [weeklyBaseline, monthlyBaseline] = await Promise.all([
    loadChainDayBaseline(tradeDate, index, expiryResolved),
    loadChainDayBaseline(tradeDate, index, monthExpiryResolved)
  ]);

  const weeklyChain = buildChainSnapshot({
    rows: weeklyChainRows,
    expiryDate: expiryResolved,
    spot: underlyingSpot,
    oiBaseline: weeklyBaseline
  });
  const monthlyChain = buildChainSnapshot({
    rows: monthlyChainRows,
    expiryDate: monthExpiryResolved,
    spot: resolveSpot(monthlyChainRows, underlyingSpot),
    oiBaseline: monthlyBaseline
  });

  const payload: LiveApiResponse = {
    index,
    strike: selected.strike,
    expiryDate: expiryResolved,
    monthExpiryDate: monthExpiryResolved,
    underlyingSpot,
    tradeDate,
    pollCount: nextState.pollCount,
    refreshCount: nextState.refreshCount,
    lastUpdatedIso: nextState.lastUpdatedIso,
    weeklyChain,
    monthlyChain,
    rows: nextState.rows,
    events,
    radar,
    vibe: vibeResult.analysis,
    intradaySummary,
    participantsSummary: eodBundle.participantsSummary,
    participantIntel,
    eodCorrelation: eodBundle.eodCorrelation,
    eodTally,
    backupInfo,
    warnings
  };

  try {
    await learnPatternMemoryFromPayload(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pattern memory update failed.";
    payload.warnings.push(`Pattern memory warning: ${message}`);
  }

  return payload;
}
