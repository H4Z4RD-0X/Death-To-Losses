import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ChainDisplayRow,
  IndexSymbol,
  LiveApiResponse,
  ParticipantRecord,
  ParticipantsSummary,
  SignalKind,
  SnapshotRow,
  VibeAnalysis
} from "@/lib/types";

interface BackupSessionLike {
  index: IndexSymbol;
  strike: number;
  tradeDate: string;
  rows: SnapshotRow[];
  radar: LiveApiResponse["radar"];
  vibe: VibeAnalysis;
  intradaySummary: LiveApiResponse["intradaySummary"];
  participantsSummary: ParticipantsSummary | null;
  participantIntel: LiveApiResponse["participantIntel"];
  eodTally: LiveApiResponse["eodTally"];
}

export interface PatternMemoryEntry {
  id: string;
  tradeDate: string;
  index: IndexSymbol;
  strike: number;
  dominantSignal: SignalKind;
  dominantConfidence: number;
  marketTone: LiveApiResponse["intradaySummary"]["marketTone"];
  radarRegime: LiveApiResponse["radar"]["regime"];
  smartMoneyFlow: LiveApiResponse["vibe"]["smartMoneyFlow"]["netIntent"];
  smartMoneyConfidence: number;
  openSpot: number | null;
  closeSpot: number | null;
  highSpot: number | null;
  lowSpot: number | null;
  netMove: number | null;
  sessionRange: number | null;
  sessionOutcome: "TREND_UP" | "TREND_DOWN" | "RANGE" | "VOLATILE_UP" | "VOLATILE_DOWN" | "MIXED";
  callWall: number | null;
  putWall: number | null;
  topActiveStrikes: number[];
  trapTags: string[];
  fiiBias: string;
  marketPlan: string;
  bigPlayerSummary: string;
  participantVerdicts: {
    FII: "BULLISH" | "BEARISH" | "NEUTRAL";
    PRO: "BULLISH" | "BEARISH" | "NEUTRAL";
    CLIENT: "BULLISH" | "BEARISH" | "NEUTRAL";
  };
  participantNets: {
    FII: number;
    PRO: number;
    CLIENT: number;
  };
  summary: string;
}

interface PatternMemoryStore {
  updatedAt: string;
  entries: Record<string, PatternMemoryEntry>;
}

export interface PatternMemoryRecall {
  score: number;
  entry: PatternMemoryEntry;
}

const PATTERN_MEMORY_DIR =
  process.env.PATTERN_MEMORY_DIR ?? path.join(process.cwd(), "data", "pattern-memory");
const PATTERN_MEMORY_FILE = path.join(PATTERN_MEMORY_DIR, "memories.json");
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");
const PATTERN_BACKFILL_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.PATTERN_BACKFILL_INTERVAL_MS ?? 10 * 60_000)
);

let backfillPromise: Promise<void> | null = null;
let lastBackfillAt = 0;

function sessionId(tradeDate: string, index: IndexSymbol, strike: number): string {
  return `${tradeDate}:${index}:${strike}`;
}

function toFinite(value: number | null | undefined): number | null {
  return value === null || value === undefined || Number.isNaN(value) ? null : value;
}

function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "na";
  }
  return value.toFixed(digits);
}

function fmtContracts(value: number): string {
  const abs = Math.abs(value);
  const label =
    abs >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` :
    abs >= 1_000 ? `${(value / 1_000).toFixed(1)}K` :
    value.toFixed(0);
  return value > 0 ? `+${label}` : label;
}

function netExposure(row: ParticipantRecord | undefined): number {
  if (!row) {
    return 0;
  }
  return (row.today.indexFuture ?? 0) + (row.today.indexCall ?? 0) - (row.today.indexPut ?? 0);
}

function participantVerdict(row: ParticipantRecord | undefined): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const net = netExposure(row);
  if (net > 10_000) {
    return "BULLISH";
  }
  if (net < -10_000) {
    return "BEARISH";
  }
  return "NEUTRAL";
}

function computeTrapTags(rows: ParticipantRecord[]): string[] {
  const client = rows.find((row) => row.participant === "CLIENT");
  const fii = rows.find((row) => row.participant === "FII");
  const pro = rows.find((row) => row.participant === "PRO");
  if (!client || !fii || !pro) {
    return [];
  }

  const tags = new Set<string>();
  const clientCall = client.today.indexCall ?? 0;
  const clientPut = client.today.indexPut ?? 0;
  const bigCallShort = Math.max(-(fii.today.indexCall ?? 0), 0) + Math.max(-(pro.today.indexCall ?? 0), 0);
  const bigPutShort = Math.max(-(fii.today.indexPut ?? 0), 0) + Math.max(-(pro.today.indexPut ?? 0), 0);
  const bigFutureNet = (fii.today.indexFuture ?? 0) + (pro.today.indexFuture ?? 0);
  const clientFutureNet = client.today.indexFuture ?? 0;

  if (clientCall > 50_000 && bigCallShort > 50_000) {
    tags.add("LONG_TRAP");
  }
  if (clientPut > 50_000 && bigPutShort > 50_000) {
    tags.add("SHORT_TRAP");
  }
  if (clientFutureNet > 15_000 && bigFutureNet < -15_000) {
    tags.add("FUTURES_LONG_TRAP");
  }
  if (clientFutureNet < -15_000 && bigFutureNet > 15_000) {
    tags.add("SHORT_SQUEEZE_SETUP");
  }
  if ((fii.today.indexCall ?? 0) < -20_000 || (pro.today.indexCall ?? 0) < -20_000) {
    tags.add("CALL_WRITER_CONTROL");
  }
  if ((fii.today.indexPut ?? 0) < -20_000 || (pro.today.indexPut ?? 0) < -20_000) {
    tags.add("PUT_WRITER_CONTROL");
  }

  return [...tags];
}

function computeSessionOutcome(rows: SnapshotRow[]): {
  openSpot: number | null;
  closeSpot: number | null;
  highSpot: number | null;
  lowSpot: number | null;
  netMove: number | null;
  sessionRange: number | null;
  sessionOutcome: PatternMemoryEntry["sessionOutcome"];
} {
  const chronological = [...rows].reverse();
  const spots = chronological
    .map((row) => toFinite(row.spot))
    .filter((value): value is number => value !== null);

  if (spots.length === 0) {
    return {
      openSpot: null,
      closeSpot: null,
      highSpot: null,
      lowSpot: null,
      netMove: null,
      sessionRange: null,
      sessionOutcome: "MIXED"
    };
  }

  const openSpot = spots[0];
  const closeSpot = spots[spots.length - 1];
  const highSpot = Math.max(...spots);
  const lowSpot = Math.min(...spots);
  const netMove = closeSpot - openSpot;
  const sessionRange = highSpot - lowSpot;
  const directionBias = Math.abs(netMove) >= Math.max(110, sessionRange * 0.55);

  let sessionOutcome: PatternMemoryEntry["sessionOutcome"] = "MIXED";
  if (sessionRange < 120 && Math.abs(netMove) < 60) {
    sessionOutcome = "RANGE";
  } else if (directionBias && netMove > 0) {
    sessionOutcome = "TREND_UP";
  } else if (directionBias && netMove < 0) {
    sessionOutcome = "TREND_DOWN";
  } else if (sessionRange >= 180 && netMove >= 0) {
    sessionOutcome = "VOLATILE_UP";
  } else if (sessionRange >= 180 && netMove < 0) {
    sessionOutcome = "VOLATILE_DOWN";
  }

  return {
    openSpot,
    closeSpot,
    highSpot,
    lowSpot,
    netMove,
    sessionRange,
    sessionOutcome
  };
}

function topWall(rows: ChainDisplayRow[] | undefined, side: "CE" | "PE"): number | null {
  if (!rows || rows.length === 0) {
    return null;
  }
  const best = [...rows].sort((a, b) => {
    const left = side === "CE" ? a.ce.oi ?? -1 : a.pe.oi ?? -1;
    const right = side === "CE" ? b.ce.oi ?? -1 : b.pe.oi ?? -1;
    return right - left;
  })[0];
  return best?.strike ?? null;
}

function buildSummary(entry: Omit<PatternMemoryEntry, "summary">): string {
  const tags = entry.trapTags.length > 0 ? entry.trapTags.join(", ") : "none";
  return [
    `${entry.tradeDate}`,
    `Strike ${entry.strike}`,
    `Signal ${entry.dominantSignal} ${fmtNumber(entry.dominantConfidence, 0)}%`,
    `Tone ${entry.marketTone}`,
    `Radar ${entry.radarRegime}`,
    `Flow ${entry.smartMoneyFlow} ${fmtNumber(entry.smartMoneyConfidence, 0)}%`,
    `Outcome ${entry.sessionOutcome}`,
    `Move ${fmtNumber(entry.netMove, 1)} pts`,
    `Range ${fmtNumber(entry.sessionRange, 1)} pts`,
    `FII ${entry.participantVerdicts.FII}/${fmtContracts(entry.participantNets.FII)}`,
    `PRO ${entry.participantVerdicts.PRO}/${fmtContracts(entry.participantNets.PRO)}`,
    `CLIENT ${entry.participantVerdicts.CLIENT}/${fmtContracts(entry.participantNets.CLIENT)}`,
    `Tags ${tags}`,
    `Plan ${entry.marketPlan}`
  ].join(" | ");
}

function buildEntryFromData(input: {
  index: IndexSymbol;
  strike: number;
  tradeDate: string;
  rows: SnapshotRow[];
  radar: LiveApiResponse["radar"];
  vibe: VibeAnalysis;
  intradaySummary: LiveApiResponse["intradaySummary"];
  participantsSummary: ParticipantsSummary | null;
  participantIntel: LiveApiResponse["participantIntel"];
  eodTally: LiveApiResponse["eodTally"];
  weeklyChainRows?: ChainDisplayRow[];
}): PatternMemoryEntry {
  const participants = input.participantsSummary?.rows ?? [];
  const fii = participants.find((row) => row.participant === "FII");
  const pro = participants.find((row) => row.participant === "PRO");
  const client = participants.find((row) => row.participant === "CLIENT");
  const outcome = computeSessionOutcome(input.rows);

  const baseEntry: Omit<PatternMemoryEntry, "summary"> = {
    id: sessionId(input.tradeDate, input.index, input.strike),
    tradeDate: input.tradeDate,
    index: input.index,
    strike: input.strike,
    dominantSignal: input.intradaySummary.dominant,
    dominantConfidence: input.intradaySummary.dominantConfidence,
    marketTone: input.intradaySummary.marketTone,
    radarRegime: input.radar.regime,
    smartMoneyFlow: input.vibe.smartMoneyFlow.netIntent,
    smartMoneyConfidence: input.vibe.smartMoneyFlow.confidence,
    openSpot: outcome.openSpot,
    closeSpot: outcome.closeSpot,
    highSpot: outcome.highSpot,
    lowSpot: outcome.lowSpot,
    netMove: outcome.netMove,
    sessionRange: outcome.sessionRange,
    sessionOutcome: outcome.sessionOutcome,
    callWall: topWall(input.weeklyChainRows, "CE"),
    putWall: topWall(input.weeklyChainRows, "PE"),
    topActiveStrikes: input.vibe.topActiveStrikes.slice(0, 6).map((row) => row.strike),
    trapTags: computeTrapTags(participants),
    fiiBias: input.participantsSummary?.fiiBias ?? "FII data unavailable",
    marketPlan: input.participantIntel.marketPlan,
    bigPlayerSummary: input.participantIntel.bigPlayerSummary,
    participantVerdicts: {
      FII: participantVerdict(fii),
      PRO: participantVerdict(pro),
      CLIENT: participantVerdict(client)
    },
    participantNets: {
      FII: netExposure(fii),
      PRO: netExposure(pro),
      CLIENT: netExposure(client)
    }
  };

  return {
    ...baseEntry,
    summary: buildSummary(baseEntry)
  };
}

async function ensureMemoryDir(): Promise<void> {
  await fs.mkdir(PATTERN_MEMORY_DIR, { recursive: true });
}

async function readStore(): Promise<PatternMemoryStore> {
  await ensureMemoryDir();
  try {
    const raw = await fs.readFile(PATTERN_MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw) as PatternMemoryStore;
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
      throw new Error("Invalid pattern store");
    }
    return parsed;
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      entries: {}
    };
  }
}

async function writeStore(store: PatternMemoryStore): Promise<void> {
  await ensureMemoryDir();
  const tempPath = `${PATTERN_MEMORY_FILE}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tempPath, PATTERN_MEMORY_FILE);
}

export async function learnPatternMemoryFromPayload(payload: LiveApiResponse): Promise<void> {
  const store = await readStore();
  const entry = buildEntryFromData({
    index: payload.index,
    strike: payload.strike,
    tradeDate: payload.tradeDate,
    rows: payload.rows,
    radar: payload.radar,
    vibe: payload.vibe,
    intradaySummary: payload.intradaySummary,
    participantsSummary: payload.participantsSummary,
    participantIntel: payload.participantIntel,
    eodTally: payload.eodTally,
    weeklyChainRows: payload.weeklyChain.rows
  });
  store.entries[entry.id] = entry;
  store.updatedAt = new Date().toISOString();
  await writeStore(store);
}

async function listBackupFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    return files
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

export async function backfillPatternMemoryFromBackups(): Promise<void> {
  const now = Date.now();
  if (lastBackfillAt !== 0 && now - lastBackfillAt < PATTERN_BACKFILL_INTERVAL_MS) {
    return;
  }
  if (backfillPromise) {
    return backfillPromise;
  }

  backfillPromise = (async () => {
    const store = await readStore();
    const files = await listBackupFiles();

    for (const file of files) {
      try {
        const tradeDate = file.replace(/\.json$/, "");
        const raw = await fs.readFile(path.join(BACKUP_DIR, file), "utf8");
        const parsed = JSON.parse(raw) as { sessions?: Record<string, BackupSessionLike> };
        const sessions = Object.values(parsed.sessions ?? {});

        for (const session of sessions) {
          const entry = buildEntryFromData({
            index: session.index,
            strike: session.strike,
            tradeDate,
            rows: session.rows,
            radar: session.radar,
            vibe: session.vibe,
            intradaySummary: session.intradaySummary,
            participantsSummary: session.participantsSummary,
            participantIntel: session.participantIntel,
            eodTally: session.eodTally
          });
          store.entries[entry.id] = entry;
        }
      } catch {
        // Ignore malformed backup files.
      }
    }

    store.updatedAt = new Date().toISOString();
    await writeStore(store);
    lastBackfillAt = Date.now();
  })();

  try {
    await backfillPromise;
  } finally {
    backfillPromise = null;
  }
}

function similarityScore(
  current: PatternMemoryEntry,
  candidate: PatternMemoryEntry,
  requestedStrike: number,
  question: string
): number {
  let score = 0;
  const q = question.toLowerCase();

  if (current.index === candidate.index) {
    score += 2.5;
  }
  if (current.dominantSignal === candidate.dominantSignal) {
    score += 2.2;
  }
  if (current.marketTone === candidate.marketTone) {
    score += 1.8;
  }
  if (current.radarRegime === candidate.radarRegime) {
    score += 1.4;
  }
  if (current.smartMoneyFlow === candidate.smartMoneyFlow) {
    score += 1.2;
  }

  const strikeDistance = Math.abs(candidate.strike - requestedStrike);
  if (strikeDistance <= 50) {
    score += 1.8;
  } else if (strikeDistance <= 100) {
    score += 1.2;
  } else if (strikeDistance <= 200) {
    score += 0.6;
  }

  if (current.participantVerdicts.FII === candidate.participantVerdicts.FII) {
    score += 1.1;
  }
  if (current.participantVerdicts.PRO === candidate.participantVerdicts.PRO) {
    score += 0.9;
  }
  if (current.participantVerdicts.CLIENT === candidate.participantVerdicts.CLIENT) {
    score += 0.5;
  }

  for (const tag of candidate.trapTags) {
    if (current.trapTags.includes(tag)) {
      score += 0.65;
    }
  }

  if (q.includes("trap") && candidate.trapTags.length > 0) {
    score += 0.8;
  }
  if ((q.includes("fii") || q.includes("foreign")) && current.participantVerdicts.FII === candidate.participantVerdicts.FII) {
    score += 0.9;
  }
  if ((q.includes("pattern") || q.includes("big move") || q.includes("setup")) &&
      (candidate.sessionOutcome === "TREND_UP" || candidate.sessionOutcome === "TREND_DOWN" ||
        candidate.sessionOutcome === "VOLATILE_UP" || candidate.sessionOutcome === "VOLATILE_DOWN")) {
    score += 1.1;
  }

  const overlap = candidate.topActiveStrikes.filter((strike) =>
    current.topActiveStrikes.some((currentStrike) => Math.abs(currentStrike - strike) <= 100)
  ).length;
  score += overlap * 0.2;

  return score;
}

export async function retrievePatternMemories(input: {
  payload: LiveApiResponse;
  requestedStrike: number;
  question: string;
  limit?: number;
}): Promise<PatternMemoryRecall[]> {
  await backfillPatternMemoryFromBackups();
  const store = await readStore();
  const current = buildEntryFromData({
    index: input.payload.index,
    strike: input.payload.strike,
    tradeDate: input.payload.tradeDate,
    rows: input.payload.rows,
    radar: input.payload.radar,
    vibe: input.payload.vibe,
    intradaySummary: input.payload.intradaySummary,
    participantsSummary: input.payload.participantsSummary,
    participantIntel: input.payload.participantIntel,
    eodTally: input.payload.eodTally,
    weeklyChainRows: input.payload.weeklyChain.rows
  });

  return Object.values(store.entries)
    .filter((entry) => entry.id !== current.id && entry.index === current.index)
    .map((entry) => ({
      entry,
      score: similarityScore(current, entry, input.requestedStrike, input.question)
    }))
    .filter((item) => item.score >= 4.2)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.entry.tradeDate.localeCompare(a.entry.tradeDate);
    })
    .slice(0, input.limit ?? 5);
}
