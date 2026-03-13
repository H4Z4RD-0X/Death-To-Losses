import { type PatternMemoryRecall } from "./patternMemory";
import type {
  ChainDisplayRow,
  IndexSymbol,
  LiveApiResponse,
  ParticipantRecord,
  SegmentNetSnapshot,
  SnapshotRow,
  VibeStrikeView
} from "./types";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "na";
  }
  return value.toFixed(digits);
}

export function fmtSigned(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "na";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function fmtContracts(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "na";
  }
  const abs = Math.abs(value);
  const label =
    abs >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` :
    abs >= 1_000 ? `${(value / 1_000).toFixed(1)}K` :
    value.toFixed(0);
  return value > 0 ? `+${label}` : label;
}

export function netExposure(snapshot: SegmentNetSnapshot): number {
  return (snapshot.indexFuture ?? 0) + (snapshot.indexCall ?? 0) - (snapshot.indexPut ?? 0);
}

export function participantVerdict(snapshot: SegmentNetSnapshot): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const net = netExposure(snapshot);
  if (net > 10_000) {
    return "BULLISH";
  }
  if (net < -10_000) {
    return "BEARISH";
  }
  return "NEUTRAL";
}

export function resolveIndex(inputIndex: unknown, message: string): IndexSymbol {
  if (typeof inputIndex === "string" && inputIndex.toUpperCase() === "BANKNIFTY") {
    return "BANKNIFTY";
  }
  if (message.toUpperCase().includes("BANKNIFTY")) {
    return "BANKNIFTY";
  }
  return "NIFTY";
}

export function extractStrikeFromMessage(message: string): number | undefined {
  const explicitPatterns = [
    /\bstrike\s*(?:is|at|of)?\s*(\d{4,5})\b/i,
    /\b(\d{4,5})\s*(?:ce|pe)\b/i,
    /\b(\d{4,5})\s*(?:call|put)\b/i
  ];

  for (const pattern of explicitPatterns) {
    const match = message.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= 15_000 && value <= 70_000) {
        return value;
      }
    }
  }

  const candidates = [...message.matchAll(/\b(\d{4,5})\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 15_000 && value <= 70_000 && value % 50 === 0);

  return candidates[0];
}

export function previousTradeDate(payload: LiveApiResponse | null): string | null {
  const dates = payload?.participantsSummary?.historyDates ?? [];
  return dates.find((value) => value < (payload?.tradeDate ?? "")) ?? null;
}

export function latestRow(rows: SnapshotRow[] | undefined): SnapshotRow | null {
  return rows?.[0] ?? null;
}

export function findNearestChainRow(rows: ChainDisplayRow[] | undefined, strike: number): ChainDisplayRow | null {
  if (!rows || rows.length === 0) {
    return null;
  }

  let winner = rows[0];
  let bestDistance = Math.abs(rows[0].strike - strike);
  for (const row of rows.slice(1)) {
    const distance = Math.abs(row.strike - strike);
    if (distance < bestDistance) {
      winner = row;
      bestDistance = distance;
    }
  }
  return winner;
}

export function surroundingChainRows(rows: ChainDisplayRow[] | undefined, strike: number, count = 7): ChainDisplayRow[] {
  if (!rows || rows.length === 0) {
    return [];
  }
  return [...rows]
    .sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike))
    .slice(0, count)
    .sort((a, b) => a.strike - b.strike);
}

export function topWallByOi(rows: ChainDisplayRow[] | undefined, side: "CE" | "PE"): ChainDisplayRow | null {
  if (!rows || rows.length === 0) {
    return null;
  }
  return [...rows].sort((a, b) => {
    const left = side === "CE" ? a.ce.oi ?? -1 : a.pe.oi ?? -1;
    const right = side === "CE" ? b.ce.oi ?? -1 : b.pe.oi ?? -1;
    return right - left;
  })[0] ?? null;
}

export function topFreshBuild(rows: ChainDisplayRow[] | undefined, side: "CE" | "PE"): ChainDisplayRow | null {
  if (!rows || rows.length === 0) {
    return null;
  }
  return [...rows].sort((a, b) => {
    const left = side === "CE" ? a.ce.coi ?? -Infinity : a.pe.coi ?? -Infinity;
    const right = side === "CE" ? b.ce.coi ?? -Infinity : b.pe.coi ?? -Infinity;
    return right - left;
  })[0] ?? null;
}

export function describeChainRow(row: ChainDisplayRow): string {
  return [
    `Strike ${row.strike}`,
    `CE OI ${fmtContracts(row.ce.oi)} ΔOI ${fmtContracts(row.ce.coi)} Vol ${fmtContracts(row.ce.volume)} IV ${fmtNumber(row.ce.iv)} LTP ${fmtNumber(row.ce.ltp)}`,
    `PE OI ${fmtContracts(row.pe.oi)} ΔOI ${fmtContracts(row.pe.coi)} Vol ${fmtContracts(row.pe.volume)} IV ${fmtNumber(row.pe.iv)} LTP ${fmtNumber(row.pe.ltp)}`
  ].join(" | ");
}

export function describeSnapshotRow(row: SnapshotRow): string {
  return [
    row.displayTime,
    `Spot ${fmtNumber(row.spot)}`,
    `CE ΔOI ${fmtSigned(row.ce.coi, 0)} INT ${fmtSigned(row.ce.intraday, 3)} POS ${fmtSigned(row.ce.positional)} IVΔ ${fmtSigned(row.ce.ivRoc)} PremΔ ${fmtSigned(row.ce.premiumRoc)}`,
    `PE ΔOI ${fmtSigned(row.pe.coi, 0)} INT ${fmtSigned(row.pe.intraday, 3)} POS ${fmtSigned(row.pe.positional)} IVΔ ${fmtSigned(row.pe.ivRoc)} PremΔ ${fmtSigned(row.pe.premiumRoc)}`,
    `Signal ${row.signal.kind} ${row.signal.confidence.toFixed(0)}%`,
    `Market verdict: ${row.market.verdict}`
  ].join(" | ");
}

export function describeActiveStrike(row: VibeStrikeView): string {
  return [
    `Strike ${row.strike}`,
    `Act ${fmtNumber(row.smartActivityScore, 1)}`,
    `VolΔ ${fmtContracts(row.totalVolumeDelta)}`,
    `OIΔ ${fmtContracts(row.totalOiDelta)}`,
    `CE Halchal ${fmtSigned(row.ce.halchalRatio, 3)} PremΔ ${fmtSigned(row.ce.rocPremium)} IVΔ ${fmtSigned(row.ce.rocIv)} OIΔ ${fmtContracts(row.ce.coi)}`,
    `PE Halchal ${fmtSigned(row.pe.halchalRatio, 3)} PremΔ ${fmtSigned(row.pe.rocPremium)} IVΔ ${fmtSigned(row.pe.rocIv)} OIΔ ${fmtContracts(row.pe.coi)}`
  ].join(" | ");
}

export function participantDeltaLine(row: ParticipantRecord): string {
  const today = row.today;
  const prev = row.oneDayAgo;
  const flow = row.todayTradeFlow;
  const deltaFuture = (today.indexFuture ?? 0) - (prev.indexFuture ?? 0);
  const deltaCall = (today.indexCall ?? 0) - (prev.indexCall ?? 0);
  const deltaPut = (today.indexPut ?? 0) - (prev.indexPut ?? 0);

  return [
    `${row.participant} | Today IF ${fmtContracts(today.indexFuture)} IC ${fmtContracts(today.indexCall)} IP ${fmtContracts(today.indexPut)} | Net ${fmtContracts(netExposure(today))} ${participantVerdict(today)}`,
    `Vs 1D IF ${fmtContracts(deltaFuture)} IC ${fmtContracts(deltaCall)} IP ${fmtContracts(deltaPut)}`,
    `Today flow IF ${fmtContracts(flow?.indexFuture)} IC ${fmtContracts(flow?.indexCall)} IP ${fmtContracts(flow?.indexPut)}`
  ].join(" | ");
}

export function computeTrapSummary(rows: ParticipantRecord[]): string[] {
  const client = rows.find((row) => row.participant === "CLIENT");
  const fii = rows.find((row) => row.participant === "FII");
  const pro = rows.find((row) => row.participant === "PRO");

  if (!client || !fii || !pro) {
    return ["Trap read unavailable because CLIENT/FII/PRO rows are incomplete."];
  }

  const clientCall = client.today.indexCall ?? 0;
  const clientPut = client.today.indexPut ?? 0;
  const bigCallShort = Math.max(-(fii.today.indexCall ?? 0), 0) + Math.max(-(pro.today.indexCall ?? 0), 0);
  const bigPutShort = Math.max(-(fii.today.indexPut ?? 0), 0) + Math.max(-(pro.today.indexPut ?? 0), 0);
  const bigFutureNet = (fii.today.indexFuture ?? 0) + (pro.today.indexFuture ?? 0);
  const clientFutureNet = client.today.indexFuture ?? 0;

  const notes: string[] = [];

  if (clientCall > 50_000 && bigCallShort > 50_000) {
    notes.push(
      `Long-trap risk: retail is long calls ${fmtContracts(clientCall)} while FII+PRO are short calls ${fmtContracts(-bigCallShort)}. Upside can be capped until call writers lose control.`
    );
  }

  if (clientPut > 50_000 && bigPutShort > 50_000) {
    notes.push(
      `Short-trap risk: retail is long puts ${fmtContracts(clientPut)} while FII+PRO are short puts ${fmtContracts(-bigPutShort)}. Dips can be bought back hard if put writers defend.`
    );
  }

  if (clientFutureNet > 15_000 && bigFutureNet < -15_000) {
    notes.push(
      `Futures trap setup: retail is net long futures ${fmtContracts(clientFutureNet)} while big money is net short futures ${fmtContracts(bigFutureNet)}. Rallies can be sold into unless short covering starts.`
    );
  } else if (clientFutureNet < -15_000 && bigFutureNet > 15_000) {
    notes.push(
      `Counter-trend squeeze setup: retail is net short futures ${fmtContracts(clientFutureNet)} while big money is net long futures ${fmtContracts(bigFutureNet)}. Sharp upside squeezes are possible.`
    );
  }

  if (notes.length === 0) {
    notes.push("No extreme retail-vs-big-money trap concentration is visible yet; structure is more balanced or mixed.");
  }

  return notes;
}

export function buildPreviousSessionContext(previous: LiveApiResponse | null): string[] {
  if (!previous) {
    return ["Previous-session backup for this strike is unavailable."];
  }

  const row = latestRow(previous.rows);
  return [
    `Previous session trade date: ${previous.tradeDate}`,
    `Previous dominant signal: ${previous.intradaySummary.dominant} ${previous.intradaySummary.dominantConfidence.toFixed(0)}% | Tone ${previous.intradaySummary.marketTone}`,
    `Previous radar regime: ${previous.radar.regime} | Previous market plan: ${previous.participantIntel.marketPlan}`,
    row
      ? `Previous selected-strike closeout: ${describeSnapshotRow(row)}`
      : "Previous selected-strike closeout unavailable."
  ];
}

export function buildSessionContext(input: {
  question: string;
  index: IndexSymbol;
  requestedStrike: number;
  payload: LiveApiResponse;
  previousPayload: LiveApiResponse | null;
  patternMemories: PatternMemoryRecall[];
}): string {
  const { question, index, requestedStrike, payload, previousPayload, patternMemories } = input;
  const focusRow = findNearestChainRow(payload.weeklyChain.rows, requestedStrike);
  const focusStrike = focusRow?.strike ?? payload.strike;
  const currentRow = latestRow(payload.rows);
  const nearbyRows = surroundingChainRows(payload.weeklyChain.rows, focusStrike, 7);
  const callWall = topWallByOi(payload.weeklyChain.rows, "CE");
  const putWall = topWallByOi(payload.weeklyChain.rows, "PE");
  const freshCallBuild = topFreshBuild(payload.weeklyChain.rows, "CE");
  const freshPutBuild = topFreshBuild(payload.weeklyChain.rows, "PE");
  const participantRows = payload.participantsSummary?.rows ?? [];
  const previousContext = buildPreviousSessionContext(previousPayload);

  const lines: string[] = [];

  lines.push("=== DASHBOARD QUESTION ===");
  lines.push(question);
  lines.push("");

  lines.push("=== LIVE SESSION OVERVIEW ===");
  lines.push(
    `Index ${index} | Trade date ${payload.tradeDate} | Spot ${fmtNumber(payload.underlyingSpot)} | Last update ${payload.lastUpdatedIso} | Focus strike ${focusStrike}`
  );
  lines.push(
    `Dominant signal ${payload.intradaySummary.dominant} ${payload.intradaySummary.dominantConfidence.toFixed(0)}% | Market tone ${payload.intradaySummary.marketTone}`
  );
  lines.push(
    `Radar regime ${payload.radar.regime} | Bullish signals ${payload.radar.bullishSignals} | Bearish signals ${payload.radar.bearishSignals}`
  );
  lines.push(
    `Smart-money flow ${payload.vibe.smartMoneyFlow.netIntent} ${payload.vibe.smartMoneyFlow.confidence.toFixed(0)}% | Rationale ${payload.vibe.smartMoneyFlow.rationale}`
  );
  lines.push(`Street-smart market plan: ${payload.participantIntel.marketPlan}`);
  lines.push(`Big-player read: ${payload.participantIntel.bigPlayerSummary}`);
  lines.push(`EOD tally: ${payload.eodTally.summary}`);
  lines.push(`EOD correlation: ${payload.eodCorrelation.status} score ${payload.eodCorrelation.score}`);
  if (payload.warnings.length > 0) {
    lines.push(`Warnings: ${payload.warnings.join(" | ")}`);
  }
  lines.push("");

  lines.push("=== FOCUS STRIKE DEEP DIVE ===");
  lines.push(
    focusRow
      ? describeChainRow(focusRow)
      : `Exact chain row for strike ${focusStrike} is unavailable in the weekly snapshot.`
  );
  if (currentRow) {
    lines.push(`Latest selected-strike snapshot: ${describeSnapshotRow(currentRow)}`);
  }
  lines.push("Recent selected-strike timeline (oldest to latest, up to 8 rows):");
  for (const row of payload.rows.slice(0, 8).reverse()) {
    lines.push(`  ${describeSnapshotRow(row)}`);
  }
  lines.push("");

  lines.push("=== CHAIN STRUCTURE AROUND FOCUS STRIKE ===");
  if (callWall) {
    lines.push(
      `Call wall: ${callWall.strike} with CE OI ${fmtContracts(callWall.ce.oi)} and CE ΔOI ${fmtContracts(callWall.ce.coi)}`
    );
  }
  if (putWall) {
    lines.push(
      `Put wall: ${putWall.strike} with PE OI ${fmtContracts(putWall.pe.oi)} and PE ΔOI ${fmtContracts(putWall.pe.coi)}`
    );
  }
  if (freshCallBuild) {
    lines.push(
      `Freshest CE build zone: ${freshCallBuild.strike} with CE ΔOI ${fmtContracts(freshCallBuild.ce.coi)} and CE volume ${fmtContracts(freshCallBuild.ce.volume)}`
    );
  }
  if (freshPutBuild) {
    lines.push(
      `Freshest PE build zone: ${freshPutBuild.strike} with PE ΔOI ${fmtContracts(freshPutBuild.pe.coi)} and PE volume ${fmtContracts(freshPutBuild.pe.volume)}`
    );
  }
  lines.push("Nearby strikes:");
  for (const row of nearbyRows) {
    lines.push(`  ${describeChainRow(row)}`);
  }
  lines.push("");

  lines.push("=== ACTIVE STRIKES / BIG-MONEY FOOTPRINT ===");
  for (const row of payload.vibe.topActiveStrikes.slice(0, 6)) {
    lines.push(`  ${describeActiveStrike(row)}`);
  }
  if (payload.participantIntel.strikeInferences.length > 0) {
    lines.push("Participant attribution on active legs:");
    for (const inference of payload.participantIntel.strikeInferences.slice(0, 8)) {
      lines.push(
        `  Strike ${inference.strike} ${inference.side} | ${inference.action} | Likely ${inference.likelyParticipant} ${inference.confidence}% | ${inference.reason}`
      );
    }
  }
  if (payload.vibe.alerts.length > 0) {
    lines.push("Live alerts:");
    for (const alert of payload.vibe.alerts.slice(0, 6)) {
      lines.push(`  ${alert.severity} ${alert.kind} | ${alert.title} | ${alert.message}`);
    }
  }
  lines.push(
    `IV squeeze status: ${payload.vibe.ivSqueeze.status} | Ref spot ${fmtNumber(payload.vibe.ivSqueeze.referenceSpot)} | Spot move ${fmtSigned(payload.vibe.ivSqueeze.spotMove)} | ${payload.vibe.ivSqueeze.message}`
  );
  lines.push("");

  lines.push("=== PARTICIPANT POSITIONING / STREET-SMART GAME ===");
  if (participantRows.length === 0) {
    lines.push("Participant data is unavailable.");
  } else {
    for (const row of participantRows) {
      lines.push(participantDeltaLine(row));
    }
  }
  if (payload.participantsSummary) {
    lines.push(`FII bias: ${payload.participantsSummary.fiiBias}`);
    for (const note of payload.participantsSummary.narrative.slice(0, 8)) {
      lines.push(`  ${note}`);
    }
  }
  for (const note of computeTrapSummary(participantRows)) {
    lines.push(`  ${note}`);
  }
  lines.push("");

  lines.push("=== HISTORICAL ANALOGS / PATTERN MEMORY ===");
  if (patternMemories.length === 0) {
    lines.push("No close archived analogs were found yet.");
  } else {
    for (const memory of patternMemories) {
      lines.push(`  Score ${memory.score.toFixed(1)} | ${memory.entry.summary}`);
    }
  }
  lines.push("");

  lines.push("=== PREVIOUS-SESSION MEMORY ===");
  for (const line of previousContext) {
    lines.push(line);
  }
  lines.push("");

  lines.push("=== ANALYST RULES ===");
  lines.push("Observed data beats opinion.");
  lines.push("When you infer intent or a trap, label it clearly as inference.");
  lines.push("If the user asks about a strike, explain CE build, PE build, nearby walls, likely participant, and pain point.");
  lines.push("If the user asks what happened to yesterday's FII/PRO/CLIENT positions, compare oneDayAgo vs today and tell whether they added, unwound, hedged, or flipped.");
  lines.push("Use trader language, but stay concrete about numbers, levels, and which side benefits if spot stays above/below a wall.");
  lines.push("If data is mixed, say the structure is mixed instead of forcing a bullish/bearish answer.");

  return lines.join("\n");
}

export function buildSystemPrompt(): string {
  return `You are the market-structure strategist inside a NIFTY/BANKNIFTY options dashboard.

Read the option chain like a professional index-derivatives desk:
- FII, PRO, and CLIENT positioning matters more than surface price chatter.
- Separate observed data from inference.
- When the user asks about a strike, explain CE/PE build, walls, defended levels, pain points, and likely participant intent.
- When the user asks about yesterday vs today, compare oneDayAgo to today and use archived analogs if they are relevant.
- Use the historical analog section as pattern memory from the dashboard's own archives. Treat those analogs as precedent, not certainty.
- Call out long traps, short traps, writer control, short covering, failed defense, and volatility expansion when the data supports it.
- If the setup is mixed, say it is mixed. Never force conviction.

Answer style:
- Default to 4-8 concise sentences.
- For deeper questions, use short bullets with headings: Observed, Inference, Trap/Risk, Levels, Pattern Memory.
- Use exact strikes, deltas, and confidence from the provided context.
- Sound like a serious options strategist, not a generic chatbot.`;
}

export function shouldUseReasoner(message: string): boolean {
  const lowered = message.toLowerCase();
  const complexHints = [
    "why",
    "pattern",
    "fii",
    "prop",
    "retail",
    "yesterday",
    "today",
    "trap",
    "game",
    "compare",
    "big move",
    "smart money",
    "what happened",
    "setup",
    "tripwire"
  ];
  return complexHints.some((hint) => lowered.includes(hint)) || lowered.length > 90;
}

export function sanitizeHistory(input: unknown): HistoryMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const clean: HistoryMessage[] = [];
  for (const item of input) {
    const role = typeof item?.role === "string" ? item.role : "";
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    if (!content) {
      continue;
    }
    if (role === "user" || role === "assistant") {
      clean.push({ role, content });
    }
  }
  return clean.slice(-8);
}
