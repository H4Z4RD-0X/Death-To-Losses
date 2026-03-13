import { istTradeDate, safeDiff, toNumber } from "@/lib/math";
import { parseCsv, normalizeHeader } from "@/lib/csv";
import type {
  MarketTone,
  EodParticipantIntel,
  EodCorrelation,
  EodTally,
  IntradaySummary,
  ParticipantPlanSummary,
  ParticipantRecord,
  ParticipantTrendSummary,
  ParticipantsSummary,
  SegmentNetSnapshot,
  SignalKind,
  StrikeParticipantInference,
  SmartMoneyEvent,
  SmartMoneyRadar,
  SnapshotRow,
  VibeStrikeView
} from "@/lib/types";

const PARTICIPANTS = ["CLIENT", "DII", "FII", "PRO"] as const;
type ParticipantName = (typeof PARTICIPANTS)[number];
const FIVE_DAY_TREND_PARTICIPANTS = ["FII", "PRO", "CLIENT"] as const;
type FiveDayTrendParticipant = (typeof FIVE_DAY_TREND_PARTICIPANTS)[number];
const PARTICIPANT_LOOKBACK_DAYS = 5;
const PARTICIPANT_SCAN_DAYS = 20;

type FetchKind = "oi" | "vol";

interface CsvDownloadResult {
  url: string;
  csv: string;
}

interface DailyParticipantData {
  date: string;
  sourceUrl: string;
  byParticipant: Record<ParticipantName, SegmentNetSnapshot>;
}

interface CacheEntry {
  summary: ParticipantsSummary | null;
  error: string | null;
  nextRetryAt: number;
}

const cache = new Map<string, CacheEntry>();

function normalizeParticipant(value: string): ParticipantName | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("client")) {
    return "CLIENT";
  }
  if (normalized.includes("dii")) {
    return "DII";
  }
  if (normalized.includes("fii") || normalized.includes("foreign")) {
    return "FII";
  }
  if (normalized.includes("pro")) {
    return "PRO";
  }
  return null;
}

function pickColumn(headerMap: Record<string, number>, aliases: string[]): number | null {
  for (const alias of aliases) {
    const index = headerMap[alias];
    if (typeof index === "number") {
      return index;
    }
  }
  return null;
}

function netFromPair(longValue: string | undefined, shortValue: string | undefined): number | null {
  const long = toNumber(longValue);
  const short = toNumber(shortValue);
  if (long === null || short === null) {
    return null;
  }
  return long - short;
}

function parseParticipantFile(csv: string, asOfDate: string, sourceUrl: string): DailyParticipantData | null {
  const matrix = parseCsv(csv);
  if (matrix.length < 2) {
    return null;
  }

  const headerIndex = matrix.findIndex((row) =>
    row.some((cell) => {
      const normalized = normalizeHeader(cell);
      return normalized.includes("client") && normalized.includes("type");
    })
  );

  if (headerIndex < 0) {
    return null;
  }

  const headerRow = matrix[headerIndex].map(normalizeHeader);
  const headerMap = headerRow.reduce<Record<string, number>>((acc, key, index) => {
    acc[key] = index;
    return acc;
  }, {});

  const participantColumn =
    pickColumn(headerMap, ["clienttype", "participant", "participanttype", "participantcategory"]) ?? 0;

  const indexFutureLongCol = pickColumn(headerMap, ["futureindexlong", "indexfuturelong", "futureidxlong"]);
  const indexFutureShortCol = pickColumn(headerMap, ["futureindexshort", "indexfutureshort", "futureidxshort"]);
  const indexCallLongCol = pickColumn(headerMap, ["optionindexcalllong", "indexcalllong", "optindexcalllong"]);
  const indexCallShortCol = pickColumn(headerMap, ["optionindexcallshort", "indexcallshort", "optindexcallshort"]);
  const indexPutLongCol = pickColumn(headerMap, ["optionindexputlong", "indexputlong", "optindexputlong"]);
  const indexPutShortCol = pickColumn(headerMap, ["optionindexputshort", "indexputshort", "optindexputshort"]);
  const stockFutureLongCol = pickColumn(headerMap, ["futurestocklong", "stockfuturelong", "futurestklong"]);
  const stockFutureShortCol = pickColumn(headerMap, ["futurestockshort", "stockfutureshort", "futurestkshort"]);
  const stockCallLongCol = pickColumn(headerMap, ["optionstockcalllong", "stockcalllong", "optstockcalllong"]);
  const stockCallShortCol = pickColumn(headerMap, ["optionstockcallshort", "stockcallshort", "optstockcallshort"]);
  const stockPutLongCol = pickColumn(headerMap, ["optionstockputlong", "stockputlong", "optstockputlong"]);
  const stockPutShortCol = pickColumn(headerMap, ["optionstockputshort", "stockputshort", "optstockputshort"]);

  const emptySnapshot = (): SegmentNetSnapshot => ({
    indexFuture: null,
    indexCall: null,
    indexPut: null,
    stockFuture: null,
    stockCall: null,
    stockPut: null
  });

  const byParticipant: Record<ParticipantName, SegmentNetSnapshot> = {
    CLIENT: emptySnapshot(),
    DII: emptySnapshot(),
    FII: emptySnapshot(),
    PRO: emptySnapshot()
  };

  const rows = matrix.slice(headerIndex + 1);
  for (const row of rows) {
    const firstCell = row[participantColumn] ?? "";
    if (!firstCell || firstCell.trim().toLowerCase().startsWith("total")) {
      continue;
    }

    const participant = normalizeParticipant(firstCell);
    if (!participant) {
      continue;
    }

    byParticipant[participant] = {
      indexFuture: netFromPair(
        indexFutureLongCol === null ? undefined : row[indexFutureLongCol],
        indexFutureShortCol === null ? undefined : row[indexFutureShortCol]
      ),
      indexCall: netFromPair(
        indexCallLongCol === null ? undefined : row[indexCallLongCol],
        indexCallShortCol === null ? undefined : row[indexCallShortCol]
      ),
      indexPut: netFromPair(
        indexPutLongCol === null ? undefined : row[indexPutLongCol],
        indexPutShortCol === null ? undefined : row[indexPutShortCol]
      ),
      stockFuture: netFromPair(
        stockFutureLongCol === null ? undefined : row[stockFutureLongCol],
        stockFutureShortCol === null ? undefined : row[stockFutureShortCol]
      ),
      stockCall: netFromPair(
        stockCallLongCol === null ? undefined : row[stockCallLongCol],
        stockCallShortCol === null ? undefined : row[stockCallShortCol]
      ),
      stockPut: netFromPair(
        stockPutLongCol === null ? undefined : row[stockPutLongCol],
        stockPutShortCol === null ? undefined : row[stockPutShortCol]
      )
    };
  }

  return {
    date: asOfDate,
    sourceUrl,
    byParticipant
  };
}

async function fetchParticipantCsv(targetDate: string, kind: FetchKind): Promise<CsvDownloadResult | null> {
  const [year, month, day] = targetDate.split("-");
  const compact = `${day}${month}${year}`;
  const fileName = kind === "oi" ? `fao_participant_oi_${compact}.csv` : `fao_participant_vol_${compact}.csv`;

  const baseUrls = [
    "https://nsearchives.nseindia.com/content/nsccl",
    "https://archives.nseindia.com/content/nsccl"
  ];

  for (const baseUrl of baseUrls) {
    const url = `${baseUrl}/${fileName}`;

    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
          Accept: "text/csv,*/*",
          Referer: "https://www.nseindia.com/"
        }
      });

      if (!response.ok) {
        continue;
      }

      const csv = await response.text();
      if (!csv || csv.length < 50) {
        continue;
      }

      return { url, csv };
    } catch {
      continue;
    }
  }

  return null;
}

function minusBusinessDays(date: Date, offsetDays: number): Date {
  const cloned = new Date(date);
  cloned.setUTCDate(cloned.getUTCDate() - offsetDays);
  return cloned;
}

async function loadRecentDailyData(tradeDate: string): Promise<DailyParticipantData[]> {
  const found: DailyParticipantData[] = [];

  for (let offset = 0; offset < PARTICIPANT_SCAN_DAYS && found.length < PARTICIPANT_LOOKBACK_DAYS; offset += 1) {
    const candidateDate = minusBusinessDays(new Date(`${tradeDate}T00:00:00Z`), offset)
      .toISOString()
      .slice(0, 10);

    const result = await fetchParticipantCsv(candidateDate, "oi");
    if (!result) {
      continue;
    }

    const parsed = parseParticipantFile(result.csv, candidateDate, result.url);
    if (parsed) {
      found.push(parsed);
    }
  }

  return found;
}

function safeSnapshot(value: SegmentNetSnapshot | undefined): SegmentNetSnapshot {
  return (
    value ?? {
      indexFuture: null,
      indexCall: null,
      indexPut: null,
      stockFuture: null,
      stockCall: null,
      stockPut: null
    }
  );
}

function participantRows(
  today: DailyParticipantData,
  oneDayAgo: DailyParticipantData | undefined,
  twoDayAgo: DailyParticipantData | undefined,
  tradeFlow: DailyParticipantData | null
): ParticipantRecord[] {
  return PARTICIPANTS.map((participant) => ({
    participant,
    today: safeSnapshot(today.byParticipant[participant]),
    oneDayAgo: safeSnapshot(oneDayAgo?.byParticipant[participant]),
    twoDayAgo: safeSnapshot(twoDayAgo?.byParticipant[participant]),
    todayTradeFlow: tradeFlow ? safeSnapshot(tradeFlow.byParticipant[participant]) : undefined
  }));
}

function fiiNarrative(rows: ParticipantRecord[]): string[] {
  const fii = rows.find((row) => row.participant === "FII");
  if (!fii) {
    return ["FII row was not available in participant data."];
  }

  const notes: string[] = [];

  const indexFutureNow = fii.today.indexFuture;
  const indexFuturePrev = fii.oneDayAgo.indexFuture;
  const indexFutureChg = safeDiff(indexFutureNow, indexFuturePrev);
  if (indexFutureChg !== null) {
    notes.push(`FII Index Futures net change vs 1D ago: ${indexFutureChg >= 0 ? "+" : ""}${indexFutureChg.toFixed(0)}.`);
  }

  const callNow = fii.today.indexCall;
  const callPrev = fii.oneDayAgo.indexCall;
  const callChg = safeDiff(callNow, callPrev);
  if (callChg !== null) {
    notes.push(`FII Index Calls net change vs 1D ago: ${callChg >= 0 ? "+" : ""}${callChg.toFixed(0)}.`);
  }

  const putNow = fii.today.indexPut;
  const putPrev = fii.oneDayAgo.indexPut;
  const putChg = safeDiff(putNow, putPrev);
  if (putChg !== null) {
    notes.push(`FII Index Puts net change vs 1D ago: ${putChg >= 0 ? "+" : ""}${putChg.toFixed(0)}.`);
  }

  const flow = fii.todayTradeFlow;
  if (flow) {
    const flowNotes = [
      flow.indexFuture !== null ? `FII flow Index Futures ${flow.indexFuture >= 0 ? "Bought Net" : "Sold Net"}` : null,
      flow.indexCall !== null ? `FII flow Index Calls ${flow.indexCall >= 0 ? "Bought Net" : "Sold Net"}` : null,
      flow.indexPut !== null ? `FII flow Index Puts ${flow.indexPut >= 0 ? "Bought Net" : "Sold Net"}` : null
    ].filter((item): item is string => item !== null);

    if (flowNotes.length > 0) {
      notes.push(flowNotes.join(" | "));
    }
  }

  return notes;
}

function deriveFiiBias(rows: ParticipantRecord[]): string {
  const fii = rows.find((row) => row.participant === "FII");
  if (!fii) {
    return "FII data unavailable";
  }

  const future = fii.today.indexFuture ?? 0;
  const calls = fii.today.indexCall ?? 0;
  const puts = fii.today.indexPut ?? 0;

  if (future > 0 && puts < 0) {
    return "Bullish hedge: long futures + put writing bias";
  }

  if (future < 0 && calls < 0) {
    return "Bearish pressure: short futures + call writing bias";
  }

  if (calls > 0 || puts > 0) {
    return "Directional long optionality building";
  }

  return "Mixed / neutral FII stance";
}

function signedInt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "na";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}`;
}

function sign(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0;
  }
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function deriveIntent(latest: number | null, change: number | null): "BUYING" | "SELLING" | "MIXED" {
  const signal = sign(latest) + sign(change);
  if (signal >= 1) {
    return "BUYING";
  }
  if (signal <= -1) {
    return "SELLING";
  }
  return "MIXED";
}

function toneFromScore(score: number): MarketTone {
  if (score > 0.65) {
    return "BULLISH";
  }
  if (score < -0.65) {
    return "BEARISH";
  }
  return "NEUTRAL";
}

function buildFiveDayTrend(
  daily: DailyParticipantData[],
  participant: FiveDayTrendParticipant
): ParticipantTrendSummary {
  const points = daily.map((entry) => safeSnapshot(entry.byParticipant[participant]));
  const latest = points[0] ?? safeSnapshot(undefined);
  const oldest = points[points.length - 1] ?? latest;
  const lookbackDays = Math.max(1, points.length);

  const futuresChange = safeDiff(latest.indexFuture, oldest.indexFuture);
  const callChange = safeDiff(latest.indexCall, oldest.indexCall);
  const putChange = safeDiff(latest.indexPut, oldest.indexPut);

  const callIntent = deriveIntent(latest.indexCall, callChange);
  const putIntent = deriveIntent(latest.indexPut, putChange);

  let score = 0;
  score += sign(futuresChange) * 1.4;
  score += callIntent === "BUYING" ? 0.9 : callIntent === "SELLING" ? -0.9 : 0;
  score += putIntent === "SELLING" ? 0.9 : putIntent === "BUYING" ? -0.9 : 0;

  const tone = toneFromScore(score);
  const directionalVotes = Math.abs(sign(futuresChange)) + Math.abs(sign(callChange)) + Math.abs(sign(putChange));
  const confidence = Math.round(
    clamp(
      38 +
        directionalVotes * 11 +
        (callIntent !== "MIXED" ? 10 : 0) +
        (putIntent !== "MIXED" ? 10 : 0) +
        Math.abs(score) * 7,
      30,
      94
    )
  );

  const summary = `${participant} ${lookbackDays}D: IF ${signedInt(futuresChange)}, IC ${signedInt(callChange)}, IP ${signedInt(putChange)} | CE intent ${callIntent}, PE intent ${putIntent} | ${tone}.`;

  return {
    participant,
    lookbackDays,
    tone,
    confidence,
    futuresChange,
    callChange,
    putChange,
    callIntent,
    putIntent,
    summary
  };
}

function buildFiveDayTrends(daily: DailyParticipantData[]): ParticipantTrendSummary[] {
  return FIVE_DAY_TREND_PARTICIPANTS.map((participant) => buildFiveDayTrend(daily, participant));
}

function trendByParticipant(
  trends: ParticipantTrendSummary[],
  participant: FiveDayTrendParticipant
): ParticipantTrendSummary | null {
  return trends.find((item) => item.participant === participant) ?? null;
}

function trendNarrative(trends: ParticipantTrendSummary[]): string[] {
  const notes: string[] = [];
  const fii = trendByParticipant(trends, "FII");
  const pro = trendByParticipant(trends, "PRO");
  const retail = trendByParticipant(trends, "CLIENT");

  if (fii) {
    notes.push(`5D FII trend: ${fii.summary}`);
  }
  if (pro) {
    notes.push(`5D PROP trend: ${pro.summary}`);
  }
  if (retail) {
    notes.push(`5D RETAIL trend: ${retail.summary}`);
  }

  return notes;
}

async function buildParticipantsSummary(tradeDate: string): Promise<ParticipantsSummary | null> {
  const daily = await loadRecentDailyData(tradeDate);
  if (daily.length === 0) {
    return null;
  }

  const [today, oneDayAgo, twoDayAgo] = daily;

  let tradeFlowData: DailyParticipantData | null = null;
  const volFile = await fetchParticipantCsv(today.date, "vol");
  if (volFile) {
    tradeFlowData = parseParticipantFile(volFile.csv, today.date, volFile.url);
  }

  const rows = participantRows(today, oneDayAgo, twoDayAgo, tradeFlowData);
  const fiveDayTrends = buildFiveDayTrends(daily);
  const historyDates = daily.map((item) => item.date);
  const trendNotes = trendNarrative(fiveDayTrends);

  return {
    asOfDate: today.date,
    sourceUrl: today.sourceUrl,
    rows,
    fiiBias: deriveFiiBias(rows),
    narrative: [...fiiNarrative(rows), ...trendNotes],
    historyDates,
    fiveDayTrends
  };
}

function scoreSignalMatch(
  dominant: SignalKind,
  participantsSummary: ParticipantsSummary | null
): { status: EodCorrelation["status"]; score: number; notes: string[] } {
  if (!participantsSummary) {
    return {
      status: "UNAVAILABLE",
      score: 0,
      notes: ["EOD participant files are not available yet. Auto-retry is active."]
    };
  }

  const fii = participantsSummary.rows.find((row) => row.participant === "FII");
  if (!fii) {
    return {
      status: "UNAVAILABLE",
      score: 0,
      notes: ["FII row missing in participant data."]
    };
  }

  let score = 0;
  const notes: string[] = [];

  if (dominant === "PUT_WRITING") {
    if ((fii.today.indexPut ?? 0) < 0) {
      score += 35;
      notes.push("FII net index puts are short, aligning with put writing.");
    } else {
      score -= 20;
      notes.push("FII net index puts are not short enough for put-writing confirmation.");
    }

    if ((fii.todayTradeFlow?.indexPut ?? 0) < 0) {
      score += 30;
      notes.push("Today's FII flow in index puts is sold net.");
    }
  }

  if (dominant === "CALL_SHORT_COVERING") {
    if ((fii.todayTradeFlow?.indexCall ?? 0) > 0) {
      score += 35;
      notes.push("FII bought net index calls today, consistent with call short covering.");
    }
    const callDelta = safeDiff(fii.today.indexCall, fii.oneDayAgo.indexCall);
    if (callDelta !== null && callDelta > 0) {
      score += 20;
      notes.push("FII index-call net moved up vs 1D ago (shorts likely reduced).");
    }
  }

  if (dominant === "DIRECTIONAL_OPTION_BUYING") {
    const callFlow = fii.todayTradeFlow?.indexCall ?? 0;
    const putFlow = fii.todayTradeFlow?.indexPut ?? 0;
    if (callFlow > 0 || putFlow > 0) {
      score += 35;
      notes.push("FII option flow is bought net, supporting directional option buying.");
    }

    if ((fii.today.indexCall ?? 0) > 0 || (fii.today.indexPut ?? 0) > 0) {
      score += 20;
      notes.push("FII net options inventory has long optionality component.");
    }
  }

  if (dominant === "PUT_WRITING_UNWIND") {
    if ((fii.todayTradeFlow?.indexPut ?? 0) > 0) {
      score += 35;
      notes.push("FII bought net index puts today, often seen in put-writing unwind.");
    }
    const putDelta = safeDiff(fii.today.indexPut, fii.oneDayAgo.indexPut);
    if (putDelta !== null && putDelta > 0) {
      score += 20;
      notes.push("FII put net moved up vs 1D ago, suggesting reduced short-put exposure.");
    }
  }

  if (dominant === "NEUTRAL") {
    notes.push("Intraday dominant signal is neutral; no strict EOD confirmation required.");
  }

  if (notes.length === 0) {
    notes.push("No strong EOD evidence for or against the intraday dominant signal.");
  }

  let status: EodCorrelation["status"] = "NEUTRAL";
  if (score >= 35) {
    status = "MATCHED";
  } else if (score <= -20) {
    status = "CONTRADICTED";
  }

  return {
    status,
    score,
    notes
  };
}

export async function getParticipantsSummary(tradeDate?: string): Promise<{ summary: ParticipantsSummary | null; warning?: string }> {
  const effectiveDate = tradeDate ?? istTradeDate();
  const now = Date.now();

  const current = cache.get(effectiveDate);
  if (current && now < current.nextRetryAt) {
    return {
      summary: current.summary,
      warning: current.error ?? undefined
    };
  }

  try {
    const summary = await buildParticipantsSummary(effectiveDate);
    cache.set(effectiveDate, {
      summary,
      error: summary ? null : "NSE participant data not available yet. Retrying automatically.",
      nextRetryAt: now + (summary ? 30 * 60_000 : 12 * 60_000)
    });

    return {
      summary,
      warning: summary ? undefined : "NSE participant data not available yet. Retrying automatically."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch participant data.";
    cache.set(effectiveDate, {
      summary: null,
      error: message,
      nextRetryAt: now + 10 * 60_000
    });

    return {
      summary: null,
      warning: message
    };
  }
}

export function correlateWithEod(dominant: SignalKind, participantsSummary: ParticipantsSummary | null): EodCorrelation {
  const result = scoreSignalMatch(dominant, participantsSummary);
  return {
    status: result.status,
    score: result.score,
    notes: result.notes
  };
}

function deriveIntradayTone(rows: SnapshotRow[], radar?: SmartMoneyRadar): {
  tone: MarketTone;
  bullish: number;
  bearish: number;
  neutral: number;
  writing: number;
  eoh: number;
  radarBullish: number;
  radarBearish: number;
} {
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  let writing = 0;
  let eoh = 0;

  for (const row of rows) {
    if (row.market.tone === "BULLISH") {
      bullish += 1;
    } else if (row.market.tone === "BEARISH") {
      bearish += 1;
    } else {
      neutral += 1;
    }

    if (row.market.regime === "WRITING") {
      writing += 1;
    }
    if (row.market.regime === "EOH") {
      eoh += 1;
    }
  }

  const radarBullish = radar?.bullishSignals ?? 0;
  const radarBearish = radar?.bearishSignals ?? 0;

  // Radar signals get higher weight because they scan ATM +-300 strikes.
  const delta = bullish + radarBullish * 2 - (bearish + radarBearish * 2);
  const threshold = Math.max(2, Math.round(rows.length * 0.06));

  if (delta > threshold) {
    return { tone: "BULLISH", bullish, bearish, neutral, writing, eoh, radarBullish, radarBearish };
  }
  if (delta < -threshold) {
    return { tone: "BEARISH", bullish, bearish, neutral, writing, eoh, radarBullish, radarBearish };
  }
  return { tone: "NEUTRAL", bullish, bearish, neutral, writing, eoh, radarBullish, radarBearish };
}

function deriveEodFiiTone(summary: ParticipantsSummary | null): {
  tone: MarketTone;
  signals: string[];
} {
  if (!summary) {
    return {
      tone: "NEUTRAL",
      signals: ["Participant data unavailable yet."]
    };
  }

  const fii = summary.rows.find((row) => row.participant === "FII");
  if (!fii) {
    return {
      tone: "NEUTRAL",
      signals: ["FII row missing in participant data."]
    };
  }

  const signals: string[] = [];
  let score = 0;

  const flowFuture = fii.todayTradeFlow?.indexFuture;
  const flowCall = fii.todayTradeFlow?.indexCall;
  const flowPut = fii.todayTradeFlow?.indexPut;

  if (flowFuture !== null && flowFuture !== undefined) {
    score += flowFuture > 0 ? 2 : flowFuture < 0 ? -2 : 0;
    signals.push(`Flow Futures: ${flowFuture > 0 ? "Bought Net" : flowFuture < 0 ? "Sold Net" : "Flat"}`);
  }
  if (flowPut !== null && flowPut !== undefined) {
    score += flowPut < 0 ? 2 : flowPut > 0 ? -2 : 0;
    signals.push(`Flow Index Puts: ${flowPut < 0 ? "Sold Net" : flowPut > 0 ? "Bought Net" : "Flat"}`);
  }
  if (flowCall !== null && flowCall !== undefined) {
    score += flowCall < 0 ? -2 : flowCall > 0 ? 2 : 0;
    signals.push(`Flow Index Calls: ${flowCall < 0 ? "Sold Net" : flowCall > 0 ? "Bought Net" : "Flat"}`);
  }

  const netFuture = fii.today.indexFuture;
  const netPut = fii.today.indexPut;
  const netCall = fii.today.indexCall;

  if (netFuture !== null) {
    score += netFuture > 0 ? 1 : netFuture < 0 ? -1 : 0;
    signals.push(`Net Futures: ${netFuture >= 0 ? "+" : ""}${netFuture.toFixed(0)}`);
  }
  if (netPut !== null) {
    score += netPut < 0 ? 1 : netPut > 0 ? -1 : 0;
    signals.push(`Net Index Puts: ${netPut >= 0 ? "+" : ""}${netPut.toFixed(0)}`);
  }
  if (netCall !== null) {
    score += netCall < 0 ? -1 : netCall > 0 ? 1 : 0;
    signals.push(`Net Index Calls: ${netCall >= 0 ? "+" : ""}${netCall.toFixed(0)}`);
  }

  if (score > 1) {
    return { tone: "BULLISH", signals };
  }
  if (score < -1) {
    return { tone: "BEARISH", signals };
  }
  return { tone: "NEUTRAL", signals };
}

export function buildEodTally(
  rows: SnapshotRow[],
  events: SmartMoneyEvent[],
  participantsSummary: ParticipantsSummary | null,
  radar?: SmartMoneyRadar
): EodTally {
  const intraday = deriveIntradayTone(rows, radar);
  const radarNote = radar
    ? `Radar Bias ${radar.regime} (${radar.bullishSignals} bullish / ${radar.bearishSignals} bearish signals).`
    : null;

  if (!participantsSummary) {
    return {
      status: "UNAVAILABLE",
      intradayTone: intraday.tone,
      eodFiiTone: "NEUTRAL",
      intradayStats: {
        sampleCount: rows.length,
        eventCount: events.length,
        bullish: intraday.bullish,
        bearish: intraday.bearish,
        neutral: intraday.neutral,
        writing: intraday.writing,
        eoh: intraday.eoh,
        radarBullish: intraday.radarBullish,
        radarBearish: intraday.radarBearish
      },
      eodSignals: ["EOD participant file not available yet."],
      summary: "EOD tally pending until participant data is published."
    };
  }

  const eod = deriveEodFiiTone(participantsSummary);

  let status: EodTally["status"] = "PARTIAL";
  if (intraday.tone === eod.tone) {
    status = "MATCHED";
  } else if (intraday.tone !== "NEUTRAL" && eod.tone !== "NEUTRAL") {
    status = "CONTRADICTED";
  }

  let summary = "Intraday and EOD signals are partially aligned.";
  if (status === "MATCHED") {
    summary = `Tally Matched: Intraday ${intraday.tone} flow is confirmed by FII EOD tone ${eod.tone}.`;
  } else if (status === "CONTRADICTED") {
    summary = `Tally Divergence: Intraday ${intraday.tone} flow conflicts with FII EOD tone ${eod.tone}.`;
  }

  const eodSignals = [...eod.signals];
  if (radarNote) {
    eodSignals.unshift(radarNote);
  }

  return {
    status,
    intradayTone: intraday.tone,
    eodFiiTone: eod.tone,
    intradayStats: {
      sampleCount: rows.length,
      eventCount: events.length,
      bullish: intraday.bullish,
      bearish: intraday.bearish,
      neutral: intraday.neutral,
      writing: intraday.writing,
      eoh: intraday.eoh,
      radarBullish: intraday.radarBullish,
      radarBearish: intraday.radarBearish
    },
    eodSignals,
    summary
  };
}

interface ParticipantIntentProfile {
  participant: FiveDayTrendParticipant;
  callIntent: "BUYING" | "SELLING" | "MIXED";
  putIntent: "BUYING" | "SELLING" | "MIXED";
  tone: MarketTone;
  confidence: number;
  summary: string;
}

function fallbackProfile(participant: FiveDayTrendParticipant): ParticipantIntentProfile {
  return {
    participant,
    callIntent: "MIXED",
    putIntent: "MIXED",
    tone: "NEUTRAL",
    confidence: 35,
    summary: `${participant} 5D trend unavailable.`
  };
}

function profileFromSummary(
  summary: ParticipantsSummary | null,
  participant: FiveDayTrendParticipant
): ParticipantIntentProfile {
  if (!summary) {
    return fallbackProfile(participant);
  }

  const trend = summary.fiveDayTrends.find((item) => item.participant === participant);
  if (!trend) {
    return fallbackProfile(participant);
  }

  return {
    participant,
    callIntent: trend.callIntent,
    putIntent: trend.putIntent,
    tone: trend.tone,
    confidence: trend.confidence,
    summary: trend.summary
  };
}

function classifyLegAction(leg: VibeStrikeView["ce"]): StrikeParticipantInference["action"] {
  const coi = leg.coi ?? 0;
  const premium = leg.rocPremium ?? 0;

  if (Math.abs(coi) < 0.0001 && Math.abs(premium) < 0.25) {
    return "NEUTRAL";
  }
  if (coi > 0 && premium > 0) {
    return "OPTION_BUYING";
  }
  if (coi > 0 && premium < 0) {
    return "OPTION_SELLING";
  }
  if (coi < 0 && premium > 0) {
    return "SHORT_COVERING";
  }
  if (coi < 0 && premium < 0) {
    return "LONG_UNWIND";
  }
  return "NEUTRAL";
}

function actionIntent(action: StrikeParticipantInference["action"]): "BUYING" | "SELLING" | "MIXED" {
  if (action === "OPTION_BUYING" || action === "SHORT_COVERING") {
    return "BUYING";
  }
  if (action === "OPTION_SELLING" || action === "LONG_UNWIND") {
    return "SELLING";
  }
  return "MIXED";
}

function legSignalStrength(leg: VibeStrikeView["ce"]): number {
  const halchal = Math.abs(leg.halchalRatio ?? 0);
  const premium = Math.abs(leg.rocPremium ?? 0);
  const iv = Math.abs(leg.rocIv ?? 0);
  const volumeDelta = Math.abs(leg.volumeDelta ?? 0);

  const halchalScore = Math.min(1, halchal / 4.5);
  const premiumScore = Math.min(1, premium / 10);
  const ivScore = Math.min(1, iv / 10);
  const volumeScore = Math.min(1, Math.log10(volumeDelta + 1) / 4.2);

  return clamp(halchalScore * 0.34 + premiumScore * 0.28 + ivScore * 0.2 + volumeScore * 0.18, 0, 1);
}

function pickLikelyParticipant(
  side: "CE" | "PE",
  action: StrikeParticipantInference["action"],
  strength: number,
  profiles: ParticipantIntentProfile[]
): { participant: StrikeParticipantInference["likelyParticipant"]; confidence: number; reason: string } {
  if (action === "NEUTRAL" || strength < 0.12) {
    return {
      participant: "UNSURE",
      confidence: 24,
      reason: "Leg footprint is too weak/neutral for participant attribution."
    };
  }

  const neededIntent = actionIntent(action);
  const ranked = profiles
    .map((profile) => {
      const sideIntent = side === "CE" ? profile.callIntent : profile.putIntent;
      const intentMatch = sideIntent === "MIXED" ? 0.66 : sideIntent === neededIntent ? 1 : 0.24;
      const priority = profile.participant === "FII" ? 1.16 : profile.participant === "PRO" ? 1.08 : 0.94;
      const trendWeight = 0.45 + profile.confidence / 140;
      const score = strength * intentMatch * priority * trendWeight;
      return {
        profile,
        sideIntent,
        score
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.16) {
    return {
      participant: "UNSURE",
      confidence: Math.round(clamp(strength * 40, 20, 40)),
      reason: "Participant intents do not align cleanly with this strike footprint."
    };
  }

  return {
    participant: best.profile.participant,
    confidence: Math.round(clamp(best.score * 100, 35, 95)),
    reason: `${best.profile.participant} ${side} intent ${best.sideIntent} matches ${action.replaceAll("_", " ").toLowerCase()} footprint.`
  };
}

function isBuyingAction(action: StrikeParticipantInference["action"]): boolean {
  return action === "OPTION_BUYING" || action === "SHORT_COVERING";
}

function isSellingAction(action: StrikeParticipantInference["action"]): boolean {
  return action === "OPTION_SELLING" || action === "LONG_UNWIND";
}

function majorPlanNarrative(input: {
  inferences: StrikeParticipantInference[];
  spot: number | null;
}): string {
  const big = input.inferences.filter(
    (item) => (item.likelyParticipant === "FII" || item.likelyParticipant === "PRO") && item.confidence >= 45
  );
  if (big.length === 0) {
    return "No high-confidence big-player strike concentration yet. Treat the structure as rotational/noisy until stronger clustering appears.";
  }

  const ceSell = big.filter((item) => item.side === "CE" && isSellingAction(item.action));
  const peSell = big.filter((item) => item.side === "PE" && isSellingAction(item.action));
  const ceBuy = big.filter((item) => item.side === "CE" && isBuyingAction(item.action));
  const peBuy = big.filter((item) => item.side === "PE" && isBuyingAction(item.action));

  const callWall = ceSell[0]?.strike ?? null;
  const putWall = peSell[0]?.strike ?? null;
  const spotLabel = input.spot !== null && Number.isFinite(input.spot) ? input.spot.toFixed(2) : "spot";

  if (ceSell.length >= 2 && peSell.length >= 2 && Math.abs(ceSell.length - peSell.length) <= 1) {
    return `Big players are writing both sides (CE ${ceSell.length}, PE ${peSell.length}). Plan likely range control; premium decay benefits if ${spotLabel} stays between ${putWall ?? "--"} and ${callWall ?? "--"}.`;
  }
  if (ceSell.length > peSell.length + 1) {
    return `Call-side writing dominates (CE ${ceSell.length} vs PE ${peSell.length}). Plan favors a capped/soft-bearish tape; writers benefit if ${spotLabel} remains below ${callWall ?? "--"}.`;
  }
  if (peSell.length > ceSell.length + 1) {
    return `Put-side writing dominates (PE ${peSell.length} vs CE ${ceSell.length}). Plan favors support-building/upside drift; writers benefit if ${spotLabel} holds above ${putWall ?? "--"}.`;
  }
  if (peBuy.length + ceBuy.length >= 2) {
    return `Option buying footprint is active (CE buy ${ceBuy.length}, PE buy ${peBuy.length}). Plan likely volatility expansion; direction depends on which side keeps adding fresh OI.`;
  }

  return "Big-player footprints are mixed across active strikes; expect two-way movement unless one side starts dominating fresh OI build-up.";
}

export function buildParticipantEodIntel(input: {
  participantsSummary: ParticipantsSummary | null;
  topActiveStrikes: VibeStrikeView[];
  spot: number | null;
}): EodParticipantIntel {
  const profiles: ParticipantIntentProfile[] = [
    profileFromSummary(input.participantsSummary, "FII"),
    profileFromSummary(input.participantsSummary, "PRO"),
    profileFromSummary(input.participantsSummary, "CLIENT")
  ];

  const sortedActive = [...input.topActiveStrikes]
    .sort((a, b) => b.totalVolumeDelta - a.totalVolumeDelta)
    .slice(0, 5);

  const strikeInferences: StrikeParticipantInference[] = [];
  for (const row of sortedActive) {
    for (const side of ["CE", "PE"] as const) {
      const leg = side === "CE" ? row.ce : row.pe;
      const action = classifyLegAction(leg);
      const strength = legSignalStrength(leg);
      const pick = pickLikelyParticipant(side, action, strength, profiles);

      strikeInferences.push({
        strike: row.strike,
        side,
        action,
        likelyParticipant: pick.participant,
        confidence: pick.confidence,
        reason: pick.reason
      });
    }
  }

  strikeInferences.sort((a, b) => b.confidence - a.confidence);

  const participantPlans: ParticipantPlanSummary[] = (["FII", "PRO", "CLIENT"] as const).map((participant) => {
    const profile = profiles.find((item) => item.participant === participant) ?? fallbackProfile(participant);
    const likelyStrikes = strikeInferences.filter((item) => item.likelyParticipant === participant).slice(0, 5);
    return {
      participant,
      trend: profile.summary,
      likelyStrikes
    };
  });

  const fiiTrend = profiles.find((item) => item.participant === "FII")?.summary ?? "FII trend unavailable.";
  const proTrend = profiles.find((item) => item.participant === "PRO")?.summary ?? "PRO trend unavailable.";
  const retailTrend = profiles.find((item) => item.participant === "CLIENT")?.summary ?? "Retail trend unavailable.";

  const bigCount = strikeInferences.filter(
    (item) => item.likelyParticipant === "FII" || item.likelyParticipant === "PRO"
  ).length;
  const bigPlayerSummary =
    strikeInferences.length === 0
      ? "No active strike set available yet for participant matching."
      : `Big-player attribution on active legs: ${bigCount}/${strikeInferences.length}. Priority is given to FII/PRO intent alignment.`;

  const activeUniverse =
    sortedActive.length === 0
      ? "ATM +/-5 + top-volume 5 (desc) universe is not available yet."
      : `ATM +/-5 + top-volume 5 (desc) universe: ${sortedActive.map((item) => item.strike).join(", ")}.`;

  return {
    asOfDate: input.participantsSummary?.asOfDate ?? null,
    activeUniverse,
    fiiTrend,
    proTrend,
    retailTrend,
    bigPlayerSummary,
    strikeInferences,
    participantPlans,
    marketPlan: majorPlanNarrative({ inferences: strikeInferences, spot: input.spot })
  };
}

export async function loadEodBundle(tradeDate?: string, intradaySummary?: IntradaySummary): Promise<{
  participantsSummary: ParticipantsSummary | null;
  eodCorrelation: EodCorrelation;
  warnings: string[];
}> {
  const { summary, warning } = await getParticipantsSummary(tradeDate);
  const correlation = correlateWithEod(intradaySummary?.dominant ?? "NEUTRAL", summary);

  const warnings = [warning].filter((item): item is string => Boolean(item));

  return {
    participantsSummary: summary,
    eodCorrelation: correlation,
    warnings
  };
}
