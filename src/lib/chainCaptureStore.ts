import { promises as fs } from "node:fs";
import path from "node:path";
import { istDisplayTime, safeDiff, safeRoc } from "@/lib/math";
import { applyRegimeVerdicts } from "@/lib/regimeEngine";
import { classifySignal } from "@/lib/signalEngine";
import type { ParsedChainStrike } from "@/lib/brokers/upstox";
import type { IndexSymbol, LegMetrics, SnapshotRow } from "@/lib/types";

interface CapturedLeg {
  oi: number | null;
  volume: number | null;
  iv: number | null;
  ltp: number | null;
}

interface CapturedStrike {
  strike: number;
  underlying: number | null;
  ce: CapturedLeg;
  pe: CapturedLeg;
}

interface CapturedFrame {
  timestampIso: string;
  displayTime: string;
  spot: number | null;
  source: "upstox" | "mock";
  strikes: CapturedStrike[];
}

interface CaptureSession {
  key: string;
  index: IndexSymbol;
  expiryDate: string | null;
  updatedAt: string;
  captures: CapturedFrame[];
}

interface CaptureFile {
  schemaVersion: number;
  tradeDate: string;
  updatedAt: string;
  sessions: Record<string, CaptureSession>;
}

const STRIKE_HISTORY_DIR = process.env.STRIKE_HISTORY_DIR ?? path.join(process.cwd(), "data", "strike-history");
const CAPTURE_SCHEMA_VERSION = 3;
const STRIKE_HISTORY_RETENTION_DAYS = Math.max(5, Number(process.env.STRIKE_HISTORY_RETENTION_DAYS ?? 5));
const STRIKE_HISTORY_LOOKBACK_DAYS  = Math.max(5, Number(process.env.STRIKE_HISTORY_LOOKBACK_DAYS  ?? 5));
const STRIKE_HISTORY_MAX_CAPTURES_PER_SESSION = Math.max(
  700,
  Number(process.env.STRIKE_HISTORY_MAX_CAPTURES_PER_SESSION ?? 1500)
);
const STRIKE_CAPTURE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.STRIKE_CAPTURE_INTERVAL_MS ?? process.env.SAMPLE_FORCE_INTERVAL_MS ?? 188_000)
);
const COI_RATIO_LOT_SIZE = Math.max(1, Number(process.env.COI_RATIO_LOT_SIZE ?? 65));
let writeQueue: Promise<void> = Promise.resolve();

function sessionKey(index: IndexSymbol, expiryDate: string | null): string {
  return `${index}:${expiryDate ?? "AUTO"}`;
}

function filePath(tradeDate: string): string {
  return path.join(STRIKE_HISTORY_DIR, `${tradeDate}.json`);
}

function toTradeDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function minusDays(dateIso: string, offset: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return toTradeDate(date);
}

function marketWindowMinutes(timestampIso: string): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestampIso));

  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

  return {
    weekday,
    minutes: hour * 60 + minute
  };
}

function isMarketHours(timestampIso: string): boolean {
  const { weekday, minutes } = marketWindowMinutes(timestampIso);
  if (weekday === "Sat" || weekday === "Sun") {
    return false;
  }

  const openMinutes = 9 * 60 + 15;
  const closeMinutes = 15 * 60 + 30;
  return minutes >= openMinutes && minutes <= closeMinutes;
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

function frameChanged(previous: CapturedFrame | undefined, current: CapturedFrame): boolean {
  if (!previous) {
    return true;
  }

  if (metricChanged(previous.spot, current.spot)) {
    return true;
  }

  if (previous.strikes.length !== current.strikes.length) {
    return true;
  }

  for (let index = 0; index < current.strikes.length; index += 1) {
    const now = current.strikes[index];
    const prev = previous.strikes[index];

    if (!prev || now.strike !== prev.strike) {
      return true;
    }

    if (
      metricChanged(now.ce.oi, prev.ce.oi) ||
      metricChanged(now.ce.volume, prev.ce.volume) ||
      metricChanged(now.ce.iv, prev.ce.iv) ||
      metricChanged(now.ce.ltp, prev.ce.ltp) ||
      metricChanged(now.pe.oi, prev.pe.oi) ||
      metricChanged(now.pe.volume, prev.pe.volume) ||
      metricChanged(now.pe.iv, prev.pe.iv) ||
      metricChanged(now.pe.ltp, prev.pe.ltp)
    ) {
      return true;
    }
  }

  return false;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(STRIKE_HISTORY_DIR, { recursive: true });
}

async function readCaptureFile(tradeDate: string): Promise<CaptureFile> {
  const target = filePath(tradeDate);
  try {
    const content = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(content) as CaptureFile;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== CAPTURE_SCHEMA_VERSION ||
      typeof parsed.sessions !== "object"
    ) {
      throw new Error("Invalid capture file");
    }
    return parsed;
  } catch {
    return {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      tradeDate,
      updatedAt: new Date().toISOString(),
      sessions: {}
    };
  }
}

async function writeCaptureFile(tradeDate: string, payload: CaptureFile): Promise<void> {
  const target = filePath(tradeDate);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(temp, target);
}

async function pruneFiles(): Promise<void> {
  await ensureDir();
  const files = await fs.readdir(STRIKE_HISTORY_DIR);
  const jsonFiles = files
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .sort((a, b) => b.localeCompare(a));
  const stale = jsonFiles.slice(STRIKE_HISTORY_RETENTION_DAYS);
  await Promise.all(
    stale.map(async (file) => {
      try {
        await fs.unlink(path.join(STRIKE_HISTORY_DIR, file));
      } catch {
        // Ignore file deletion issues.
      }
    })
  );
}

function toCapturedStrike(row: ParsedChainStrike): CapturedStrike {
  return {
    strike: row.strike,
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
  };
}

export async function persistChainCapture(input: {
  tradeDate: string;
  index: IndexSymbol;
  expiryDate: string | null;
  spot: number | null;
  timestampIso: string;
  displayTime: string;
  source: "upstox" | "mock";
  chainRows: ParsedChainStrike[];
}): Promise<{ persisted: boolean; reason?: string }> {
  if (!isMarketHours(input.timestampIso)) {
    return { persisted: false, reason: "outside_market_hours" };
  }

  const capture: CapturedFrame = {
    timestampIso: input.timestampIso,
    displayTime: input.displayTime,
    spot: input.spot,
    source: input.source,
    strikes: input.chainRows.map(toCapturedStrike)
  };

  let persisted = false;

  const scheduled = writeQueue.then(async () => {
    await ensureDir();
    const payload = await readCaptureFile(input.tradeDate);
    const key = sessionKey(input.index, input.expiryDate);
    const nowIso = new Date().toISOString();

    const session: CaptureSession = payload.sessions[key] ?? {
      key,
      index: input.index,
      expiryDate: input.expiryDate,
      updatedAt: nowIso,
      captures: []
    };

    const latest = session.captures[0];
    if (latest) {
      const latestMs = new Date(latest.timestampIso).getTime();
      const currentMs = new Date(capture.timestampIso).getTime();
      if (Number.isFinite(latestMs) && Number.isFinite(currentMs) && currentMs - latestMs < STRIKE_CAPTURE_INTERVAL_MS) {
        return;
      }
    }

    // Persist a row on every capture interval even when values are unchanged,
    // so the timeline cadence remains fixed at the configured interval.
    if (latest && !frameChanged(latest, capture)) {
      capture.strikes = latest.strikes;
      capture.spot = latest.spot;
    }

    session.updatedAt = nowIso;
    session.captures = [capture, ...session.captures].slice(0, STRIKE_HISTORY_MAX_CAPTURES_PER_SESSION);

    payload.sessions[key] = session;
    payload.updatedAt = nowIso;
    await writeCaptureFile(input.tradeDate, payload);
    await pruneFiles();
    persisted = true;
  });

  writeQueue = scheduled.catch(() => undefined);
  await scheduled;

  return { persisted };
}

function toLeg(
  current: CapturedLeg,
  previous: LegMetrics | null,
  previousDayOi: number | null
): LegMetrics {
  const oi = current.oi;
  const volume = current.volume;
  const iv = current.iv;
  const ltp = current.ltp;

  const prevOi = previous?.oi ?? null;
  const prevVolume = previous?.volume ?? null;
  const prevIv = previous?.iv ?? null;
  const prevLtp = previous?.ltp ?? null;

  const coi = safeDiff(oi, prevOi);
  const volumeDiff = safeDiff(volume, prevVolume);
  const dayCoi = oi !== null && previousDayOi !== null ? oi - previousDayOi : null;
  const dayCoiQty = dayCoi !== null ? dayCoi * COI_RATIO_LOT_SIZE : null;
  const coiQty = coi !== null ? coi * COI_RATIO_LOT_SIZE : null;
  const positional =
    dayCoiQty !== null && volume !== null && volume > 0.0001 ? dayCoiQty / volume : null;
  const intraday =
    coiQty !== null && volumeDiff !== null && volumeDiff > 0.0001
      ? coiQty / volumeDiff
      : null;
  const ratioRoc = safeDiff(intraday, previous?.intraday ?? null);
  const activityRatio = coi !== null && volume !== null && volume > 0 ? Math.abs(coi) / volume : null;

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
    ivRoc: safeDiff(iv, prevIv),
    premiumRoc: safeDiff(ltp, prevLtp),
    ratioRoc,
    positional,
    intraday,
    coiVol: intraday,
    halchalRatio: intraday,
    activityRatio,
    // NT, numberOfTrades and money flow are not computed in the capture store (no live OHLC context)
    nt: null,
    numberOfTrades: null,
    moneyFlow: null
  };
}

function createBaseRow(input: {
  timestampIso: string;
  displayTime: string;
  spot: number | null;
  strike: number;
  ce: LegMetrics;
  pe: LegMetrics;
  source: "upstox" | "mock";
}): SnapshotRow {
  return {
    id: `${input.timestampIso}-${input.strike}`,
    timestampIso: input.timestampIso,
    displayTime: input.displayTime || istDisplayTime(input.timestampIso),
    spot: input.spot,
    strike: input.strike,
    ce: input.ce,
    pe: input.pe,
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
      ceAr: input.ce.activityRatio,
      peAr: input.pe.activityRatio,
      dominantLeg: "BOTH"
    },
    source: input.source
  };
}

function sessionForDate(
  filePayload: CaptureFile,
  index: IndexSymbol,
  expiryDate: string | null
): CaptureSession | null {
  const sessions = Object.values(filePayload.sessions).filter((session) => session.index === index);
  if (sessions.length === 0) {
    return null;
  }

  const exact = sessions.find((session) => session.expiryDate === expiryDate);
  if (exact) {
    return exact;
  }

  if (expiryDate !== null) {
    return null;
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

async function readCaptureFileIfExists(tradeDate: string): Promise<CaptureFile | null> {
  const target = filePath(tradeDate);
  try {
    const content = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(content) as CaptureFile;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== CAPTURE_SCHEMA_VERSION ||
      typeof parsed.sessions !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function loadStrikeHistoryRows(input: {
  tradeDate: string;
  index: IndexSymbol;
  expiryDate: string | null;
  strike: number;
  maxRows?: number;
  lookbackDays?: number;
}): Promise<SnapshotRow[]> {
  const maxRows = Math.max(60, input.maxRows ?? 420);
  const lookbackDays = Math.max(7, input.lookbackDays ?? STRIKE_HISTORY_LOOKBACK_DAYS);

  const captures: CapturedFrame[] = [];
  for (let offset = 0; offset < lookbackDays; offset += 1) {
    const date = minusDays(input.tradeDate, offset);
    const filePayload = await readCaptureFileIfExists(date);
    if (!filePayload) {
      continue;
    }

    const session = sessionForDate(filePayload, input.index, input.expiryDate);
    if (!session) {
      continue;
    }

    captures.push(...session.captures);
  }

  if (captures.length === 0) {
    return [];
  }

  captures.sort((a, b) => new Date(a.timestampIso).getTime() - new Date(b.timestampIso).getTime());

  const chronologicalRows: SnapshotRow[] = [];
  let previousRow: SnapshotRow | null = null;
  let previousDate: string | null = null;
  let previousDayCeOi: number | null = null;
  let previousDayPeOi: number | null = null;
  let currentDayLastCeOi: number | null = null;
  let currentDayLastPeOi: number | null = null;

  for (const capture of captures) {
    const currentDate = capture.timestampIso.slice(0, 10);
    if (previousDate !== null && currentDate !== previousDate) {
      previousDayCeOi = currentDayLastCeOi;
      previousDayPeOi = currentDayLastPeOi;
      currentDayLastCeOi = null;
      currentDayLastPeOi = null;
      previousRow = null;
    }

    const strikeData = capture.strikes.find((row) => row.strike === input.strike);
    if (!strikeData) {
      previousDate = currentDate;
      continue;
    }

    const ce = toLeg(strikeData.ce, previousRow?.ce ?? null, previousDayCeOi);
    const pe = toLeg(strikeData.pe, previousRow?.pe ?? null, previousDayPeOi);

    const row = createBaseRow({
      timestampIso: capture.timestampIso,
      displayTime: capture.displayTime,
      spot: capture.spot,
      strike: input.strike,
      ce,
      pe,
      source: capture.source
    });

    chronologicalRows.push(row);
    previousRow = row;
    currentDayLastCeOi = ce.oi;
    currentDayLastPeOi = pe.oi;
    previousDate = currentDate;
  }

  if (chronologicalRows.length === 0) {
    return [];
  }

  const rows = chronologicalRows.reverse().slice(0, maxRows);

  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const prior = rows.slice(index + 1, index + 70);
    current.signal = classifySignal(current, prior);
  }
  applyRegimeVerdicts(rows);

  return rows;
}

/* ── Day-open OI baseline for full chain COI computation ─────────────────── */
export async function loadChainDayBaseline(
  tradeDate: string,
  index: IndexSymbol,
  expiryDate: string | null
): Promise<Map<number, { ceOi: number | null; peOi: number | null }>> {
  const baseline = new Map<number, { ceOi: number | null; peOi: number | null }>();
  try {
    const filePayload = await readCaptureFileIfExists(tradeDate);
    if (!filePayload) return baseline;
    const session = sessionForDate(filePayload, index, expiryDate);
    if (!session || session.captures.length === 0) return baseline;
    // captures array is stored newest-first; oldest = last element = day-open baseline
    const firstCapture = session.captures[session.captures.length - 1];
    for (const s of firstCapture.strikes) {
      baseline.set(s.strike, { ceOi: s.ce.oi, peOi: s.pe.oi });
    }
  } catch {
    /* file read failure — return empty baseline, chain will show coi=null */
  }
  return baseline;
}
