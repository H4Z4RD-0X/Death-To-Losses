"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CenteredExpiryTable } from "@/components/CenteredExpiryTable";
import { DashboardChat } from "@/components/DashboardChat";
import { LiveChainTable } from "@/components/LiveChainTable";
import { OiBarProfile } from "@/components/OiBarProfile";
import { VibeActiveStrikeTable } from "@/components/VibeActiveStrikeTable";
import { VibeLineChart } from "@/components/VibeLineChart";
import { ParticipantSummaryTable } from "@/components/ParticipantSummaryTable";
import { ParticipantIntelTable } from "@/components/ParticipantIntelTable";
import { PositionTimeline } from "@/components/PositionTimeline";
import { BrokerSettings } from "@/components/BrokerSettings";
import { groupPositions } from "@/lib/positionTracker";
import type { LiveApiResponse, ParticipantRecord, SegmentNetSnapshot, VibeStrikeView, ChainDisplaySnapshot } from "@/lib/types";

/* ─── Refresh interval: 188 seconds (matches server capture gate) ───────────── */
const REFRESH_INTERVAL_MS = 188_000;

function formatRefreshInterval(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const REFRESH_INTERVAL_LABEL = formatRefreshInterval(REFRESH_INTERVAL_MS);

/* ─── Helpers ───────────────────────────────────────────────────────────────── */
function todayIstDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year  = parts.find((p) => p.type === "year")?.value  ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day   = parts.find((p) => p.type === "day")?.value   ?? "01";
  return `${year}-${month}-${day}`;
}

function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function signed(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(0)}`;
}

function spot(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(2);
}

function decimal(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function segmentLabel(snapshot: SegmentNetSnapshot): string {
  return [
    `IF ${signed(snapshot.indexFuture)}`,
    `IC ${signed(snapshot.indexCall)}`,
    `IP ${signed(snapshot.indexPut)}`,
    `SF ${signed(snapshot.stockFuture)}`,
    `SC ${signed(snapshot.stockCall)}`,
    `SP ${signed(snapshot.stockPut)}`,
  ].join(" | ");
}

function correlationClass(status: LiveApiResponse["eodCorrelation"]["status"]): string {
  if (status === "MATCHED")      return "status-matched";
  if (status === "CONTRADICTED") return "status-contradicted";
  if (status === "UNAVAILABLE")  return "status-unavailable";
  return "status-neutral";
}

function tallyClass(status: LiveApiResponse["eodTally"]["status"]): string {
  if (status === "MATCHED")      return "status-matched";
  if (status === "CONTRADICTED") return "status-contradicted";
  if (status === "UNAVAILABLE")  return "status-unavailable";
  return "status-neutral";
}

function radarRegimeClass(regime: LiveApiResponse["radar"]["regime"]): string {
  if (regime === "BULLISH") return "status-matched";
  if (regime === "BEARISH") return "status-contradicted";
  return "status-neutral";
}

function vibeSeverityClass(severity: LiveApiResponse["vibe"]["alerts"][number]["severity"]): string {
  if (severity === "ACTION") return "status-contradicted";
  if (severity === "WATCH")  return "status-unavailable";
  return "status-neutral";
}

function participantRows(summary: LiveApiResponse["participantsSummary"] | undefined): ParticipantRecord[] {
  return summary?.rows ?? [];
}

function participantActionLabel(action: LiveApiResponse["participantIntel"]["strikeInferences"][number]["action"]): string {
  return action.replaceAll("_", " ");
}

function participantToneClass(participant: LiveApiResponse["participantIntel"]["strikeInferences"][number]["likelyParticipant"]): string {
  if (participant === "FII" || participant === "PRO") return "status-matched";
  if (participant === "CLIENT") return "status-unavailable";
  return "status-neutral";
}

function regimeLabel(payload: LiveApiResponse | null): string {
  const regime = payload?.rows?.[0]?.market?.regime;
  if (regime === "EOH")     return "EoH (Exchange of Hands)";
  if (regime === "WRITING") return "Writing";
  return "Neutral";
}

/* ─── Participant net tone for EOD cards ─────────────────────────────────── */
function netToneClass(value: number | null): string {
  if (value === null) return "neut";
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "neut";
}

function fmtNet(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  let str: string;
  if (abs >= 1_000_000)      str = `${(value / 1_000_000).toFixed(2)}M`;
  else if (abs >= 1_000)     str = `${(value / 1_000).toFixed(1)}K`;
  else                       str = value.toFixed(0);
  return value > 0 ? `+${str}` : str;
}

function participantCardToneClass(participant: ParticipantRecord): string {
  // derive dominant intent from indexFuture + indexCall - indexPut
  const { indexFuture, indexCall, indexPut } = participant.today;
  const net = (indexFuture ?? 0) + (indexCall ?? 0) - (indexPut ?? 0);
  if (net > 10000)  return "tone-bull";
  if (net < -10000) return "tone-bear";
  return "tone-neut";
}

function participantCardToneLabel(participant: ParticipantRecord): string {
  const { indexFuture, indexCall, indexPut } = participant.today;
  const net = (indexFuture ?? 0) + (indexCall ?? 0) - (indexPut ?? 0);
  if (net > 10000)  return "BULLISH";
  if (net < -10000) return "BEARISH";
  return "NEUTRAL";
}

/* ════════════════════════════════════════════════════════════════════════════
   Smart-Money Enhancement Helpers
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Enhancement 1: BLUF one-liner generator ────────────────────────────── */
function generateBLUF(p: LiveApiResponse): string {
  const tone = p.intradaySummary.marketTone;
  const conf = p.intradaySummary.dominantConfidence.toFixed(0);
  const dominant = p.intradaySummary.dominant.replaceAll("_", " ").toLowerCase();

  const fiiRow = p.participantsSummary?.rows.find((r) => r.participant === "FII");
  const proRow = p.participantsSummary?.rows.find((r) => r.participant === "PRO");
  const clientRow = p.participantsSummary?.rows.find((r) => r.participant === "CLIENT");

  const fiiNet = fiiRow
    ? (fiiRow.today.indexFuture ?? 0) + (fiiRow.today.indexCall ?? 0) - (fiiRow.today.indexPut ?? 0)
    : null;
  const proCallNet = proRow?.today.indexCall ?? null;
  const clientCallNet = clientRow?.today.indexCall ?? null;
  const clientPutNet  = clientRow?.today.indexPut  ?? null;

  const parts: string[] = [];

  parts.push(`Trend: ${tone}.`);

  if (dominant !== "neutral") {
    parts.push(`Dominant signal: ${dominant} (${conf}% confidence).`);
  }

  if (fiiNet !== null) {
    if (fiiNet > 80_000)       parts.push("FIIs positioned aggressively long.");
    else if (fiiNet > 20_000)  parts.push("FIIs net long.");
    else if (fiiNet < -80_000) parts.push("FIIs positioned aggressively short.");
    else if (fiiNet < -20_000) parts.push("FIIs net short.");
    else                       parts.push("FIIs neutral.");
  }

  if (proCallNet !== null && proCallNet < -50_000) {
    parts.push("PROs writing calls aggressively — resistance building.");
  }

  if (clientCallNet !== null && clientCallNet > 100_000 && (proCallNet ?? 0) < -50_000) {
    parts.push("⚠ Retail heavily long calls vs PRO writing — Long Trap risk.");
  } else if (clientPutNet !== null && clientPutNet > 100_000) {
    parts.push("Retail heavily long puts — watch for Short Trap unwind.");
  }

  const radar = p.radar;
  if (radar.activeSignals.length >= 3) {
    const dominant = radar.bullishSignals > radar.bearishSignals ? "bullish" : "bearish";
    parts.push(`ATM radar: ${radar.activeSignals.length} signals (${dominant} bias).`);
  }

  return parts.join(" ") || "Insufficient intraday data for BLUF summary.";
}

/* ── Enhancement 2: Estimated Premium Money Flow ────────────────────────── */
interface PremiumFlowResult {
  ceFlow: number;
  peFlow: number;
  netFlow: number;
  topCeStrike: number | null;
  topPeStrike: number | null;
  interpretation: "BEARISH_MONEY_FLOW" | "BULLISH_MONEY_FLOW" | "NEUTRAL";
}

function computePremiumFlow(topStrikes: VibeStrikeView[]): PremiumFlowResult {
  let ceFlow = 0;
  let peFlow = 0;
  let topCeFlow = 0, topCeStrike: number | null = null;
  let topPeFlow = 0, topPeStrike: number | null = null;

  for (const s of topStrikes) {
    const ceLtp = Math.max(s.ce.ltp ?? 0, 0);
    const peLtp = Math.max(s.pe.ltp ?? 0, 0);
    const ceCoi = s.ce.coi ?? 0;
    const peCoi = s.pe.coi ?? 0;

    // Premium Flow = |ΔOI| × LTP (capital committed at this strike)
    const ceF = Math.abs(ceCoi) * ceLtp;
    const peF = Math.abs(peCoi) * peLtp;

    ceFlow += ceF;
    peFlow += peF;

    if (ceF > topCeFlow) { topCeFlow = ceF; topCeStrike = s.strike; }
    if (peF > topPeFlow) { topPeFlow = peF; topPeStrike = s.strike; }
  }

  const total = ceFlow + peFlow;
  const threshold = total * 0.15;
  const netFlow = peFlow - ceFlow;
  const interpretation =
    netFlow >  threshold ? "BEARISH_MONEY_FLOW" :
    netFlow < -threshold ? "BULLISH_MONEY_FLOW"  : "NEUTRAL";

  return { ceFlow, peFlow, netFlow, topCeStrike, topPeStrike, interpretation };
}

/* ── Enhancement 3: 3-Day Rolling Accumulation ──────────────────────────── */
interface RollingAccumRow {
  participant: string;
  days: (number | null)[];   // [2d ago, 1d ago, today]
  cumulative: number;
}

function computeRollingAccum(rows: ParticipantRecord[]): RollingAccumRow[] {
  return rows
    .filter((r) => ["FII", "PRO", "CLIENT"].includes(r.participant))
    .map((r) => {
      const snapshots = [r.twoDayAgo, r.oneDayAgo, r.today];
      const nets = snapshots.map((d) =>
        d
          ? (d.indexFuture ?? 0) + (d.indexCall ?? 0) - (d.indexPut ?? 0)
          : null,
      );
      return {
        participant: r.participant,
        days: nets,
        cumulative: nets.reduce<number>((sum, v) => sum + (v ?? 0), 0),
      };
    });
}

/* ── Enhancement 4: Retail Trap Multiplier ──────────────────────────────── */
interface RetailTrapResult {
  clientCallPct: number;
  fiiProCallShortPct: number;
  clientPutPct: number;
  fiiProPutShortPct: number;
  longTrap: boolean;
  shortTrap: boolean;
  trapStrength: "EXTREME" | "ELEVATED" | "NONE";
}

function computeRetailTrap(rows: ParticipantRecord[]): RetailTrapResult {
  const client = rows.find((r) => r.participant === "CLIENT");
  const fii    = rows.find((r) => r.participant === "FII");
  const pro    = rows.find((r) => r.participant === "PRO");

  const zero: RetailTrapResult = {
    clientCallPct: 0, fiiProCallShortPct: 0,
    clientPutPct: 0,  fiiProPutShortPct: 0,
    longTrap: false, shortTrap: false, trapStrength: "NONE",
  };
  if (!client || !fii || !pro) return zero;

  const cCallNet  = client.today.indexCall  ?? 0;
  const fCallNet  = fii.today.indexCall     ?? 0;
  const pCallNet  = pro.today.indexCall     ?? 0;
  const cPutNet   = client.today.indexPut   ?? 0;
  const fPutNet   = fii.today.indexPut      ?? 0;
  const pPutNet   = pro.today.indexPut      ?? 0;

  const totalCallExp = Math.abs(cCallNet) + Math.abs(fCallNet) + Math.abs(pCallNet);
  const totalPutExp  = Math.abs(cPutNet)  + Math.abs(fPutNet)  + Math.abs(pPutNet);

  const clientCallPct       = totalCallExp > 0 ? (cCallNet  / totalCallExp) * 100 : 0;
  const fiiProCallShortPct  = totalCallExp > 0 ? (-(fCallNet + pCallNet) / totalCallExp) * 100 : 0;
  const clientPutPct        = totalPutExp  > 0 ? (cPutNet   / totalPutExp)  * 100 : 0;
  const fiiProPutShortPct   = totalPutExp  > 0 ? (-(fPutNet  + pPutNet)  / totalPutExp)  * 100 : 0;

  const longTrap  = clientCallPct > 55 && fiiProCallShortPct > 55;
  const shortTrap = clientPutPct  > 55 && fiiProPutShortPct  > 55;

  const trapStrength =
    (clientCallPct > 72 && fiiProCallShortPct > 72) ||
    (clientPutPct  > 72 && fiiProPutShortPct  > 72)
      ? "EXTREME"
      : longTrap || shortTrap
      ? "ELEVATED"
      : "NONE";

  return { clientCallPct, fiiProCallShortPct, clientPutPct, fiiProPutShortPct, longTrap, shortTrap, trapStrength };
}

/* ── New: Session Summary for LiveChainTable ────────────────────────────── */
interface SessionSummaryResult {
  text: string;
  unifiedLabel: string;
  badgeCls: "bull" | "bear" | "neut";
}

function computeSessionSummary(rows: import("@/lib/types").SnapshotRow[]): SessionSummaryResult {
  if (rows.length === 0) return { text: "No captures yet.", unifiedLabel: "WAITING", badgeCls: "neut" };
  const best = rows.reduce((a, b) => (a.signal.confidence >= b.signal.confidence ? a : b));
  const kind = best.signal.kind;
  const conf = best.signal.confidence.toFixed(0);
  const verdict = best.market.verdict ?? "";
  const time = best.displayTime;
  const text = `Peak: ${kind.replaceAll("_"," ")} at ${time} (${conf}%) · Regime: ${verdict || "UNDEFINED"}`;
  const BULL_KINDS = ["PUT_WRITING_BUILDUP","BULL_BUILDUP","AGGRESSIVE_PUT_HEDGING"];
  const BEAR_KINDS = ["CALL_WRITING_BUILDUP","BEAR_BUILDUP","PANIC_COVERING","AGGRESSIVE_CALL_BUYING"];
  const badgeCls = BULL_KINDS.includes(kind) ? "bull" : BEAR_KINDS.includes(kind) ? "bear" : "neut";
  const LABEL_MAP: Record<string, string> = {
    "CALL_WRITING_BUILDUP": "Smart Selling Calls",
    "PUT_WRITING_BUILDUP": "Smart Selling Puts",
    "PANIC_COVERING": "Panic Unwind",
    "EXCHANGE_OF_HANDS": "Ownership Shift",
    "AGGRESSIVE_PUT_HEDGING": "Put Hedge Rush",
    "AGGRESSIVE_CALL_BUYING": "Call Buying Spree",
    "BULL_BUILDUP": "Bull Position Build",
    "BEAR_BUILDUP": "Bear Position Build",
    "NEUTRAL_DRIFT": "Sideways Drift",
  };
  const unifiedLabel = LABEL_MAP[kind] ?? kind.replaceAll("_"," ");
  return { text, unifiedLabel, badgeCls };
}

/* ── New: Status Board ───────────────────────────────────────────────────── */
interface StatusBoardResult {
  bigMoneyActivity: string;
  bigMoneyCls: "bull" | "bear" | "warn" | "neut";
  bigMoneySub: string;
  marketRegime: string;
  regimeCls: "bull" | "bear" | "warn" | "neut";
  regimeSub: string;
  primaryTrap: string;
  trapCls: "bull" | "bear" | "warn" | "neut";
  trapSub: string;
  keyAlert: string;
  alertCls: "bull" | "bear" | "warn" | "neut";
}

function computeStatusBoard(
  payload: LiveApiResponse | null,
  retailTrap: RetailTrapResult,
): StatusBoardResult {
  /* Big Money Activity */
  const radar = payload?.radar;
  let bigMoneyActivity = "INACTIVE";
  let bigMoneyCls: StatusBoardResult["bigMoneyCls"] = "neut";
  let bigMoneySub = "No radar signals in ATM ±300";
  if (radar && radar.activeSignals.length > 0) {
    if (radar.bullishSignals > radar.bearishSignals) {
      bigMoneyActivity = "ACTIVE — BULLISH";
      bigMoneyCls = "bull";
      bigMoneySub = `${radar.activeSignals.length} active signals (${radar.bullishSignals} bull / ${radar.bearishSignals} bear)`;
    } else if (radar.bearishSignals > radar.bullishSignals) {
      bigMoneyActivity = "ACTIVE — BEARISH";
      bigMoneyCls = "bear";
      bigMoneySub = `${radar.activeSignals.length} active signals (${radar.bullishSignals} bull / ${radar.bearishSignals} bear)`;
    } else {
      bigMoneyActivity = "ACTIVE — MIXED";
      bigMoneyCls = "warn";
      bigMoneySub = `${radar.activeSignals.length} signals, equal bull/bear — undecided`;
    }
  }

  /* Market Regime */
  const ivSqueezeStatus = payload?.vibe.ivSqueeze.status;
  const tone = payload?.intradaySummary.marketTone ?? "NEUTRAL";
  let marketRegime = "RANGE-BOUND (WRITER CONTROL)";
  let regimeCls: StatusBoardResult["regimeCls"] = "neut";
  let regimeSub = "Market expected between put wall and call wall";
  if (ivSqueezeStatus === "VALIDATED") {
    marketRegime = "VOLATILE BREAKOUT";
    regimeCls = "bear";
    regimeSub = "IV Squeeze validated — real directional move confirmed";
  } else if (tone === "BULLISH" || tone === "BEARISH") {
    marketRegime = "TRENDING";
    regimeCls = tone === "BULLISH" ? "bull" : "bear";
    regimeSub = `Intraday bias: ${tone}`;
  }

  /* Primary Trap */
  let primaryTrap = "NONE";
  let trapCls: StatusBoardResult["trapCls"] = "bull";
  let trapSub = "Positions balanced — no retail-vs-smart divergence";
  if (retailTrap.trapStrength !== "NONE") {
    primaryTrap = retailTrap.longTrap ? "LONG TRAP" : "SHORT TRAP";
    trapCls = retailTrap.trapStrength === "EXTREME" ? "bear" : "warn";
    trapSub = retailTrap.longTrap
      ? "Retail long calls vs smart short calls — reversal risk"
      : "Retail long puts vs smart short puts — squeeze risk";
  }

  /* Key Alert */
  const actionAlert = payload?.vibe.alerts.find((a) => a.severity === "ACTION");
  let keyAlert = ivSqueezeStatus === "VALIDATED" ? "IV SQUEEZE VALIDATED" : "No action alerts";
  let alertCls: StatusBoardResult["alertCls"] = ivSqueezeStatus === "VALIDATED" ? "bear" : "neut";
  if (actionAlert) {
    keyAlert = actionAlert.title;
    alertCls = "bear";
  }

  return { bigMoneyActivity, bigMoneyCls, bigMoneySub, marketRegime, regimeCls, regimeSub, primaryTrap, trapCls, trapSub, keyAlert, alertCls };
}

/* ── New: Key Level Banner ───────────────────────────────────────────────── */
interface KeyLevelResult {
  resistance: number | null;
  resistanceDesc: string;
  resistanceWds: number | null;   // Wall Defense Score 0-10
  support: number | null;
  supportDesc: string;
  supportWds: number | null;      // Wall Defense Score 0-10
}

/**
 * Wall Defense Score components:
 *  (i)  FII+PRO net futures position → 0–3.3
 *  (ii) FII+PRO net options position at the wall strike → 0–3.3
 *  (iii) IV momentum near the wall (IV rising = writers defending) → 0–3.4
 * Sum = 0-10. Higher score = stronger defense expected at that wall.
 */
function computeWallDefenseScore(
  wallStrike: number | null,
  wallSide: "CE" | "PE",
  chain: ChainDisplaySnapshot,
  pSummary: import("@/lib/types").ParticipantsSummary | null
): number | null {
  if (!wallStrike || !pSummary) return null;

  const rows = pSummary.rows;
  const fii = rows.find((r: import("@/lib/types").ParticipantRecord) => r.participant === "FII");
  const pro = rows.find((r: import("@/lib/types").ParticipantRecord) => r.participant === "PRO");
  if (!fii || !pro) return null;

  // (i) Futures: FII+PRO net futures — negative = net short = defending ceiling
  const fiiFut = fii.todayTradeFlow?.indexFuture ?? fii.today.indexFuture ?? 0;
  const proFut = pro.todayTradeFlow?.indexFuture  ?? pro.today.indexFuture  ?? 0;
  const netFut = fiiFut + proFut;
  // For CE wall: net short futures reinforces defense. For PE wall: net long reinforces.
  const futScore = wallSide === "CE"
    ? Math.max(0, Math.min(3.3, (-netFut / 5000) * 3.3))
    : Math.max(0, Math.min(3.3, (netFut  / 5000) * 3.3));

  // (ii) Options: FII+PRO net at this exact strike
  const fiiCall = fii.todayTradeFlow?.indexCall ?? fii.today.indexCall ?? 0;
  const proCall = pro.todayTradeFlow?.indexCall  ?? pro.today.indexCall  ?? 0;
  const netCall = fiiCall + proCall;
  // CE wall: net short calls = selling premium into resistance
  const optScore = wallSide === "CE"
    ? Math.max(0, Math.min(3.3, (-netCall / 5000) * 3.3))
    : Math.max(0, Math.min(3.3, (netCall  / 5000) * 3.3));

  // (iii) IV behaviour near wall: if IV at wall strike > median chain IV, writers are defending
  const chainRow = chain.rows.find((r) => r.strike === wallStrike);
  const wallIv = wallSide === "CE" ? (chainRow?.ce.iv ?? 0) : (chainRow?.pe.iv ?? 0);
  const allIvs = chain.rows
    .map((r) => (wallSide === "CE" ? r.ce.iv : r.pe.iv))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const medianIv = allIvs.length > 0
    ? [...allIvs].sort((a, b) => a - b)[Math.floor(allIvs.length / 2)]
    : 0;
  const ivScore = wallIv > medianIv
    ? Math.min(3.4, ((wallIv - medianIv) / (medianIv + 0.01)) * 10)
    : 0;

  return Math.min(10, futScore + optScore + ivScore);
}

function computeNextKeyLevels(
  chain: ChainDisplaySnapshot | undefined,
  currentSpot: number | null,
  pSummary?: import("@/lib/types").ParticipantsSummary | null,
): KeyLevelResult {
  if (!chain || !currentSpot) return { resistance: null, resistanceDesc: "—", resistanceWds: null, support: null, supportDesc: "—", supportWds: null };
  const spot = currentSpot;
  let topCeOi = 0;
  let resistance: number | null = null;
  let topPeOi = 0;
  let support: number | null = null;
  for (const row of chain.rows) {
    if (row.strike > spot) {
      const oi = row.ce.oi ?? 0;
      if (oi > topCeOi) { topCeOi = oi; resistance = row.strike; }
    } else if (row.strike < spot) {
      const oi = row.pe.oi ?? 0;
      if (oi > topPeOi) { topPeOi = oi; support = row.strike; }
    }
  }
  const rDiff = resistance ? Math.abs(resistance - spot).toFixed(0) : "";
  const sDiff = support ? Math.abs(spot - support).toFixed(0) : "";
  const ps = pSummary ?? null;
  const resistanceWds = computeWallDefenseScore(resistance, "CE", chain, ps);
  const supportWds    = computeWallDefenseScore(support,    "PE", chain, ps);
  return {
    resistance,
    resistanceDesc: resistance ? `CE Wall · ${rDiff} pts above · Break triggers short covering` : "No clear call wall identified",
    resistanceWds,
    support,
    supportDesc: support ? `PE Wall · ${sDiff} pts below · Break triggers bearish move` : "No clear put wall identified",
    supportWds,
  };
}

/* ── Enhancement 6: PCR + Participant-wise PCR ──────────────────────────── */
interface PCRResult {
  pcr: number;
  totalCeOi: number;
  totalPeOi: number;
  fiiPcr: number | null;
  clientPcr: number | null;
  interpretation: "EXTREME_BULLISH" | "BULLISH" | "NEUTRAL" | "BEARISH" | "EXTREME_BEARISH";
}

function computePCR(chain: ChainDisplaySnapshot, pRows: ParticipantRecord[]): PCRResult {
  let totalCeOi = 0;
  let totalPeOi = 0;
  for (const row of chain.rows) {
    totalCeOi += row.ce.oi ?? 0;
    totalPeOi += row.pe.oi ?? 0;
  }
  const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : 0;

  const fii    = pRows.find((r) => r.participant === "FII");
  const client = pRows.find((r) => r.participant === "CLIENT");

  // Participant PCR = |indexPut| / |indexCall| — higher means more put activity vs call
  const fiiPcr =
    fii && (fii.today.indexCall ?? 0) !== 0
      ? Math.abs(fii.today.indexPut ?? 0) / Math.abs(fii.today.indexCall ?? 0)
      : null;
  const clientPcr =
    client && (client.today.indexCall ?? 0) !== 0
      ? Math.abs(client.today.indexPut ?? 0) / Math.abs(client.today.indexCall ?? 0)
      : null;

  const interpretation =
    pcr > 1.5  ? "EXTREME_BULLISH"  :
    pcr > 1.15 ? "BULLISH"          :
    pcr < 0.70 ? "EXTREME_BEARISH"  :
    pcr < 0.90 ? "BEARISH"          : "NEUTRAL";

  return { pcr, totalCeOi, totalPeOi, fiiPcr, clientPcr, interpretation };
}

/* ════════════════════════════════════════════════════════════════════════════
   Net Sentiment Engine — FII / PRO / CLIENT Bullish vs Bearish Score
   Formula: Bullish = Call Long + Put Short | Bearish = Put Long + Call Short
   Net Score = Bullish - Bearish. Positive = BULLISH, Negative = BEARISH.
   Since SegmentNetSnapshot gives NET (long minus short), we derive:
     Call Long  = max(indexCall, 0)   Call Short = max(-indexCall, 0)
     Put Long   = max(indexPut,  0)   Put Short  = max(-indexPut,  0)
   ════════════════════════════════════════════════════════════════════════════ */
interface NetSentimentRow {
  participant: string;
  callLong: number;
  callShort: number;
  putLong: number;
  putShort: number;
  totalBullish: number;   /* Call Long + Put Short */
  totalBearish: number;   /* Put Long + Call Short */
  netScore: number;       /* totalBullish - totalBearish */
  verdict: "BULLISH" | "BEARISH" | "NEUTRAL";
}

function computeNetSentiment(rows: ParticipantRecord[]): NetSentimentRow[] {
  return rows
    .filter((r) => ["FII", "PRO", "CLIENT"].includes(r.participant))
    .map((r) => {
      const iCall = r.today.indexCall ?? 0;
      const iPut  = r.today.indexPut  ?? 0;
      const callLong  = Math.max(iCall,  0);
      const callShort = Math.max(-iCall, 0);
      const putLong   = Math.max(iPut,   0);
      const putShort  = Math.max(-iPut,  0);
      const totalBullish = callLong + putShort;
      const totalBearish = putLong  + callShort;
      const netScore     = totalBullish - totalBearish;
      const verdict: NetSentimentRow["verdict"] =
        netScore >  5_000 ? "BULLISH" :
        netScore < -5_000 ? "BEARISH" : "NEUTRAL";
      return { participant: r.participant, callLong, callShort, putLong, putShort, totalBullish, totalBearish, netScore, verdict };
    });
}

/* ════════════════════════════════════════════════════════════════════════════
   EOD Narrative Engine — plain-English story of what each participant did
   ════════════════════════════════════════════════════════════════════════════ */
interface EodParticipantNarrative {
  participant: string;
  sentences: string[];
  netPosition: string;
  netValue: number;
  simpleVerdict: "BULLISH" | "BEARISH" | "NEUTRAL";
}
interface EodNarrativeResult {
  narratives: EodParticipantNarrative[];
  smartMoneySummary: string;
  smartMoneyVerdict: "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED";
}

function narrateSentence(field: "future" | "call" | "put", v: number | null): string {
  if (v === null || Math.abs(v) < 200) return "";
  const abs = Math.abs(v);
  const fmt = abs >= 100_000 ? `${(abs / 1_000).toFixed(0)}K` : abs >= 1_000 ? `${(abs / 1_000).toFixed(1)}K` : String(Math.round(abs));
  if (field === "future") {
    return v > 0
      ? `Added ${fmt} futures longs — directly betting the market will go UP.`
      : `Added ${fmt} futures shorts — directly betting the market will go DOWN.`;
  }
  if (field === "call") {
    return v > 0
      ? `Bought ${fmt} more call options — bullish upside positioning.`
      : `Closed or wrote ${fmt} call contracts — reducing call exposure or writing premium.`;
  }
  // put
  return v > 0
    ? `Added ${fmt} put positions — building a downside hedge or bearish bet.`
    : `Reduced ${fmt} put positions — removing bearish protection (a bullish signal).`;
}

function generateEodNarrative(rows: ParticipantRecord[]): EodNarrativeResult | null {
  const targets = rows.filter((r) => ["FII", "PRO", "CLIENT"].includes(r.participant));
  if (targets.length === 0) return null;

  const narratives: EodParticipantNarrative[] = targets.map((row) => {
    const flow    = row.todayTradeFlow;
    const today   = row.today;
    const yest    = row.oneDayAgo;
    const sentences: string[] = [];

    /* What changed today (flow = delta from yesterday's close) */
    if (flow) {
      const ifS = narrateSentence("future", flow.indexFuture ?? null);
      const icS = narrateSentence("call",   flow.indexCall  ?? null);
      const ipS = narrateSentence("put",    flow.indexPut   ?? null);
      if (ifS) sentences.push(ifS);
      if (icS) sentences.push(icS);
      if (ipS) sentences.push(ipS);
    }

    /* Compare today's net vs yesterday's net for each leg */
    const deltaF = (today.indexFuture ?? 0) - (yest.indexFuture ?? 0);
    const deltaC = (today.indexCall   ?? 0) - (yest.indexCall   ?? 0);
    const deltaP = (today.indexPut    ?? 0) - (yest.indexPut    ?? 0);
    // If no todayTradeFlow, fall back to simple delta sentences
    if (!flow && (Math.abs(deltaF) + Math.abs(deltaC) + Math.abs(deltaP)) > 500) {
      const df = narrateSentence("future", deltaF);
      const dc = narrateSentence("call",   deltaC);
      const dp = narrateSentence("put",    deltaP);
      if (df) sentences.push(df);
      if (dc) sentences.push(dc);
      if (dp) sentences.push(dp);
    }

    if (sentences.length === 0) {
      sentences.push("No significant positional change from yesterday — holding steady.");
    }

    /* Current net position */
    const net = (today.indexFuture ?? 0) + (today.indexCall ?? 0) - (today.indexPut ?? 0);
    const absN = Math.abs(net);
    const netFmt = absN >= 100_000 ? `${(net / 1_000).toFixed(0)}K` : `${net.toFixed(0)}`;
    const netPosition = `Net position: ${net >= 0 ? "+" : ""}${netFmt} contracts (${net > 10_000 ? "net BULLISH" : net < -10_000 ? "net BEARISH" : "roughly flat"})`;
    const simpleVerdict: EodParticipantNarrative["simpleVerdict"] =
      net > 10_000 ? "BULLISH" : net < -10_000 ? "BEARISH" : "NEUTRAL";

    return { participant: row.participant, sentences, netPosition, netValue: net, simpleVerdict };
  });

  /* Smart money summary — FII + PRO alignment */
  const fiiN   = narratives.find((n) => n.participant === "FII");
  const proN   = narratives.find((n) => n.participant === "PRO");
  const cliN   = narratives.find((n) => n.participant === "CLIENT");
  const fiiNet = fiiN?.netValue ?? 0;
  const proNet = proN?.netValue ?? 0;
  const cliNet = cliN?.netValue ?? 0;
  const fiiBull  = fiiNet > 10_000;
  const fiiBear  = fiiNet < -10_000;
  const proBull  = proNet > 10_000;
  const proBear  = proNet < -10_000;

  const netFmtShort = (v: number) => {
    const a = Math.abs(v);
    const s = a >= 100_000 ? `${(v/1_000).toFixed(0)}K` : a >= 1_000 ? `${(v/1_000).toFixed(1)}K` : String(Math.round(v));
    return v >= 0 ? `+${s}` : s;
  };

  let smartMoneyVerdict: EodNarrativeResult["smartMoneyVerdict"];
  let smartMoneySummary: string;

  if (fiiBull && proBull) {
    smartMoneyVerdict = "BULLISH";
    smartMoneySummary =
      `🟢 SMART MONEY IS BULLISH — Both FIIs (${netFmtShort(fiiNet)}) and PROs (${netFmtShort(proNet)}) are net long. ` +
      `This is a strong conviction signal. ` +
      (cliNet < -10_000
        ? `Retail (CLIENT) is net short ${netFmtShort(cliNet)} — a classic short squeeze setup. Expect upward pressure.`
        : cliNet > 10_000
          ? `Retail (CLIENT) is also long ${netFmtShort(cliNet)} — market-wide bullish but watch for overbought.`
          : `Retail is roughly flat. Smart money is leading this move. Favour buy-side setups.`);
  } else if (fiiBear && proBear) {
    smartMoneyVerdict = "BEARISH";
    smartMoneySummary =
      `🔴 SMART MONEY IS BEARISH — Both FIIs (${netFmtShort(fiiNet)}) and PROs (${netFmtShort(proNet)}) are net short. ` +
      `Strong institutional conviction on the downside. ` +
      (cliNet > 10_000
        ? `Retail (CLIENT) is net long ${netFmtShort(cliNet)} — classic bear trap. Retail longs will likely be squeezed out.`
        : cliNet < -10_000
          ? `Even retail is short ${netFmtShort(cliNet)} — market may have a panic bottom, but primary trend is down.`
          : `Retail is flat. FII + PRO pressure should prevail. Favour sell-side setups.`);
  } else if ((fiiBull && proBear) || (fiiBear && proBull)) {
    smartMoneyVerdict = "MIXED";
    smartMoneySummary =
      `⚪ SMART MONEY IS SPLIT — FIIs are ${fiiBull ? `bullish (${netFmtShort(fiiNet)})` : `bearish (${netFmtShort(fiiNet)})`} ` +
      `while PROs are ${proBull ? `bullish (${netFmtShort(proNet)})` : `bearish (${netFmtShort(proNet)})`}. ` +
      `When FII and PRO disagree, avoid strong directional bets. Wait for them to align before entering.`;
  } else {
    smartMoneyVerdict = "NEUTRAL";
    smartMoneySummary =
      `⚪ NO STRONG SIGNAL — Institutional players have not taken a decisive stance. ` +
      `FII: ${netFmtShort(fiiNet)}, PRO: ${netFmtShort(proNet)}, CLIENT: ${netFmtShort(cliNet)}. ` +
      `In neutral conditions, option writers tend to win. Avoid buying expensive options.`;
  }

  return { narratives, smartMoneySummary, smartMoneyVerdict };
}

/* ════════════════════════════════════════════════════════════════════════════
   Street-Smart Analysis Engine
   Deep read: what each participant did yesterday, what they hold now, which
   levels protect their profits, and who is setting a trap for whom.
   ════════════════════════════════════════════════════════════════════════════ */
interface ParticipantStory {
  participant: string;
  yesterdayBrief: string;
  todayAction: string;
  netStance: string;
  netValue: number;
  verdict: "BULLISH" | "BEARISH" | "NEUTRAL";
  painPoint: string;
  keyLevel: string;
}
interface CriticalLevel {
  label: string;
  strike: number;
  oi: number;
  side: "CALL_WALL" | "PUT_WALL";
  whoDefends: string;
  tradingImplication: string;
}
interface TrapAlert {
  trapType: "LONG_TRAP" | "SHORT_TRAP" | "FUTURES_TRAP";
  severity: "HIGH" | "MODERATE";
  headline: string;
  detail: string;
  advice: string;
}
interface StreetSmartResult {
  stories: ParticipantStory[];
  criticalLevels: CriticalLevel[];
  traps: TrapAlert[];
  masterConclusion: string;
  oneLineTrade: string;
  overallBias: "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED";
}

function generateStreetSmartAnalysis(
  pRows: ParticipantRecord[],
  weeklyChain: ChainDisplaySnapshot,
  spot: number | null,
): StreetSmartResult | null {
  if (pRows.length === 0) return null;

  const fmtK = (v: number | null): string => {
    if (v === null) return "—";
    const a = Math.abs(v);
    const s = a >= 100_000 ? `${(v / 1_000).toFixed(0)}K`
            : a >= 1_000   ? `${(v / 1_000).toFixed(1)}K`
            : String(Math.round(v));
    return v >= 0 ? `+${s}` : s;
  };

  const fii    = pRows.find((r) => r.participant === "FII");
  const pro    = pRows.find((r) => r.participant === "PRO");
  const client = pRows.find((r) => r.participant === "CLIENT");

  /* ── Find call wall & put wall from option chain ────────────────────── */
  let callWall: { strike: number; oi: number } | null = null;
  let putWall:  { strike: number; oi: number } | null = null;
  for (const row of weeklyChain.rows) {
    const ceOi = row.ce.oi ?? 0;
    const peOi = row.pe.oi ?? 0;
    if (!callWall || ceOi > callWall.oi) callWall = { strike: row.strike, oi: ceOi };
    if (!putWall  || peOi > putWall.oi)  putWall  = { strike: row.strike, oi: peOi };
  }

  const cwS = callWall?.strike.toLocaleString("en-IN") ?? "—";
  const pwS = putWall?.strike.toLocaleString("en-IN") ?? "—";

  /* ── Build per-participant story ─────────────────────────────────────── */
  const buildStory = (row: ParticipantRecord | undefined, name: string): ParticipantStory => {
    if (!row) return {
      participant: name, yesterdayBrief: "No data available.", todayAction: "No data.",
      netStance: "—", netValue: 0, verdict: "NEUTRAL", painPoint: "—", keyLevel: "—",
    };

    const yF = row.oneDayAgo.indexFuture ?? 0;
    const yC = row.oneDayAgo.indexCall   ?? 0;
    const yP = row.oneDayAgo.indexPut    ?? 0;
    const tF = row.today.indexFuture     ?? 0;
    const tC = row.today.indexCall       ?? 0;
    const tP = row.today.indexPut        ?? 0;
    const flow = row.todayTradeFlow;

    const yestNet  = yF + yC - yP;
    const todayNet = tF + tC - tP;

    /* Yesterday brief */
    const yParts: string[] = [];
    if (Math.abs(yF) > 500) yParts.push(`${yF > 0 ? "Long" : "Short"} ${fmtK(Math.abs(yF))} futures`);
    if (Math.abs(yC) > 500) yParts.push(`${yC > 0 ? "Long" : "Short"} ${fmtK(Math.abs(yC))} calls`);
    if (Math.abs(yP) > 500) yParts.push(`${yP > 0 ? "Long" : "Short"} ${fmtK(Math.abs(yP))} puts`);
    const yesterdayBrief = yParts.length > 0
      ? `${yParts.join(", ")}. Net bias yesterday: ${fmtK(yestNet)} (${yestNet > 5_000 ? "BULLISH" : yestNet < -5_000 ? "BEARISH" : "FLAT"}).`
      : "No significant positions yesterday — starting fresh.";

    /* Today's action (use flow if available, else delta) */
    const dF = flow?.indexFuture ?? (tF - yF);
    const dC = flow?.indexCall   ?? (tC - yC);
    const dP = flow?.indexPut    ?? (tP - yP);
    const actions: string[] = [];
    if (Math.abs(dF) > 500) actions.push(dF > 0
      ? `Added ${fmtK(dF)} futures longs (direct bullish bet)`
      : `Added ${fmtK(dF)} futures shorts (direct bearish bet)`);
    if (Math.abs(dC) > 500) actions.push(dC > 0
      ? `Bought ${fmtK(dC)} calls (bullish positioning)`
      : `Closed/wrote ${fmtK(Math.abs(dC))} calls (reducing upside or writing premium)`);
    if (Math.abs(dP) > 500) actions.push(dP > 0
      ? `Added ${fmtK(dP)} puts (downside hedge or bearish bet)`
      : `Removed ${fmtK(Math.abs(dP))} puts — reducing bearish hedge (bullish signal)`);
    const todayAction = actions.length > 0 ? actions.join("; ") + "." : "No major changes today.";

    const verdict: "BULLISH" | "BEARISH" | "NEUTRAL" =
      todayNet > 10_000 ? "BULLISH" : todayNet < -10_000 ? "BEARISH" : "NEUTRAL";
    const netStance = `${fmtK(todayNet)} (${verdict})`;

    /* Pain point: what level they need to protect */
    let painPoint = "";
    let keyLevel  = "—";
    if (tP < -5_000) {
      // Wrote puts → want market ABOVE put wall
      painPoint = `Has written ${fmtK(Math.abs(tP))} puts net. These puts expire worthless only if market stays ABOVE ${pwS}. ` +
        `A crash below the put wall forces emergency buying (delta hedge) — expect a violent support defence at ${pwS}.`;
      keyLevel = `PUT WALL ${pwS} — must hold UP`;
    } else if (tC < -5_000) {
      // Wrote calls → want market BELOW call wall
      painPoint = `Has written ${fmtK(Math.abs(tC))} calls net. These expire worthless only if market stays BELOW ${cwS}. ` +
        `A breakout above the call wall forces panic short-covering — watch for a rapid squeeze above ${cwS}.`;
      keyLevel = `CALL WALL ${cwS} — must stay BELOW`;
    } else if (tF > 10_000) {
      const lvl = spot ? (spot - 200).toFixed(0) : "current levels";
      painPoint = `Long ${fmtK(tF)} futures. Profit only if market goes UP from here. ` +
        `Stop loss conceptually near ~${lvl} (approx support). Any sustained move lower would trigger losses + forced selling.`;
      keyLevel = spot ? `~${(spot - 200).toFixed(0)} — futures support` : "below current spot";
    } else if (tF < -10_000) {
      const lvl = spot ? (spot + 200).toFixed(0) : "current levels";
      painPoint = `Short ${fmtK(Math.abs(tF))} futures. Profit only if market FALLS. ` +
        `Stop loss conceptually near ~${lvl}. Any sustained rally would trigger losses + forced covering.`;
      keyLevel = spot ? `~${(spot + 200).toFixed(0)} — futures resistance` : "above current spot";
    } else {
      painPoint = "Mixed or hedged position — no single dominant pain point. Acting as market maker, collecting from both sides.";
      keyLevel  = "No single critical level";
    }

    return { participant: name, yesterdayBrief, todayAction, netStance, netValue: todayNet, verdict, painPoint, keyLevel };
  };

  const fiiStory    = buildStory(fii,    "FII");
  const proStory    = buildStory(pro,    "PRO");
  const clientStory = buildStory(client, "CLIENT");
  const stories     = [fiiStory, proStory, clientStory];

  /* ── Critical levels ─────────────────────────────────────────────────── */
  const criticalLevels: CriticalLevel[] = [];
  if (callWall) {
    const fiiCW = (fii?.today.indexCall  ?? 0) < -5_000;
    const proCW = (pro?.today.indexCall  ?? 0) < -5_000;
    criticalLevels.push({
      label: `Call Wall — ${cwS} CE`, strike: callWall.strike, oi: callWall.oi,
      side: "CALL_WALL",
      whoDefends: fiiCW ? "FII (written calls)" : proCW ? "PRO (written calls)" : "General option writers",
      tradingImplication:
        `Strongest resistance at ${cwS}. ${fiiCW ? "FII has written calls here" : "Heaviest call OI = maximum pain point for call writers"}. ` +
        `Market staying BELOW ${cwS} through expiry = full premium to writers. ` +
        `BREAKOUT ABOVE ${cwS} = short covering rally (squeeze) — dangerous for short call holders. ` +
        `Watch for aggressive call-writing activity near this strike as a top signal.`,
    });
  }
  if (putWall) {
    const fiiPW = (fii?.today.indexPut  ?? 0) < -5_000;
    const proPW = (pro?.today.indexPut  ?? 0) < -5_000;
    criticalLevels.push({
      label: `Put Wall — ${pwS} PE`, strike: putWall.strike, oi: putWall.oi,
      side: "PUT_WALL",
      whoDefends: fiiPW ? "FII (written puts)" : proPW ? "PRO (written puts)" : "General option writers",
      tradingImplication:
        `Strongest support at ${pwS}. ${fiiPW ? "FII has written puts here" : "Heaviest put OI = maximum pain point for put writers"}. ` +
        `Market staying ABOVE ${pwS} through expiry = full premium to writers. ` +
        `BREAKDOWN BELOW ${pwS} = forced delta hedging (futures buying) — can create sharp counter-rally. ` +
        `Watch for put-writing activity near this strike as a bottom signal.`,
    });
  }

  /* ── Trap detection ─────────────────────────────────────────────────── */
  const traps: TrapAlert[] = [];
  const cliCallLong    = Math.max(client?.today.indexCall  ?? 0,  0);
  const smCallShort    = Math.max(-(fii?.today.indexCall   ?? 0), 0) + Math.max(-(pro?.today.indexCall ?? 0), 0);
  const cliPutLong     = Math.max(client?.today.indexPut   ?? 0,  0);
  const smPutShort     = Math.max(-(fii?.today.indexPut    ?? 0), 0) + Math.max(-(pro?.today.indexPut  ?? 0), 0);
  const cliFutNet      = client?.today.indexFuture ?? 0;
  const smFutNet       = (fii?.today.indexFuture ?? 0) + (pro?.today.indexFuture ?? 0);

  if (cliCallLong > 50_000 && smCallShort > 50_000) {
    const ratio = smCallShort / Math.max(cliCallLong, 1);
    traps.push({
      trapType: "LONG_TRAP", severity: ratio > 0.8 ? "HIGH" : "MODERATE",
      headline: "⚠️ LONG TRAP — Retail Bought Calls, Smart Money Sold Them",
      detail:
        `Retail (CLIENT) is holding ${fmtK(cliCallLong)} net call longs. ` +
        `FII + PRO have WRITTEN (sold) ${fmtK(smCallShort)} calls against them. ` +
        `This means for every call retail bought, smart money is on the other side COLLECTING PREMIUM. ` +
        `Smart money makes money as long as market stays below the call wall at ${cwS}. ` +
        `Time decay works AGAINST retail call buyers every single day.`,
      advice:
        `If you hold call options and market is not moving up fast, EXIT. Smart money will let your calls expire worthless. ` +
        `Only hold calls if market is already in a strong uptrend breaking above ${cwS}.`,
    });
  }
  if (cliPutLong > 50_000 && smPutShort > 50_000) {
    const ratio = smPutShort / Math.max(cliPutLong, 1);
    traps.push({
      trapType: "SHORT_TRAP", severity: ratio > 0.8 ? "HIGH" : "MODERATE",
      headline: "⚠️ SHORT TRAP — Retail Bought Puts, Smart Money Sold Them",
      detail:
        `Retail (CLIENT) holds ${fmtK(cliPutLong)} put longs (betting on crash). ` +
        `FII + PRO have written ${fmtK(smPutShort)} puts against them. ` +
        `Smart money is comfortable as long as market stays ABOVE the put wall at ${pwS}. ` +
        `If market drifts sideways or up, retail put buyers lose everything to time decay.`,
      advice:
        `Don't buy puts just because market "feels" bearish. FII/PRO are protecting the put wall at ${pwS}. ` +
        `Only short the market if price BREAKS and CLOSES below ${pwS} with volume.`,
    });
  }
  if (cliFutNet > 30_000 && smFutNet < -30_000) {
    traps.push({
      trapType: "FUTURES_TRAP", severity: "HIGH",
      headline: "⚠️ FUTURES LONG TRAP — Retail Long, Smart Money Short",
      detail:
        `Retail is long ${fmtK(cliFutNet)} futures. FII + PRO are SHORT ${fmtK(smFutNet)} futures combined. ` +
        `This is a pure directional fight — smart money's firepower vs retail's FOMO buying. ` +
        `In this battle, smart money almost always wins. They have deeper pockets and better information.`,
      advice: `Avoid long futures. Ride shorts or wait on sidelines until retail capitulates.`,
    });
  } else if (cliFutNet < -30_000 && smFutNet > 30_000) {
    traps.push({
      trapType: "FUTURES_TRAP", severity: "MODERATE",
      headline: "⚠️ FUTURES SHORT TRAP — Retail Short, Smart Money Long",
      detail:
        `Retail is short ${fmtK(cliFutNet)} futures while FII + PRO hold ${fmtK(smFutNet)} longs. ` +
        `Short squeeze risk is elevated. Smart money can force a rally that wipes retail shorts.`,
      advice: `Avoid short futures. Buy dips instead.`,
    });
  }

  /* ── Master conclusion ────────────────────────────────────────────────── */
  const fiiNet = fiiStory.netValue;
  const proNet = proStory.netValue;
  const fiiBull = fiiNet > 10_000; const fiiBear = fiiNet < -10_000;
  const proBull = proNet > 10_000; const proBear = proNet < -10_000;

  let overallBias: StreetSmartResult["overallBias"];
  let masterConclusion: string;
  let oneLineTrade: string;

  const trapLine = traps.length > 0
    ? ` TRAP ALERT: ${traps.map((t) => t.headline).join(" | ")}.`
    : " No major traps currently active.";

  if (fiiBull && proBull) {
    overallBias = "BULLISH";
    masterConclusion =
      `FII (${fmtK(fiiNet)}) and PRO (${fmtK(proNet)}) are BOTH net long — high-conviction bullish alignment. ` +
      `The put wall at ${pwS} is actively defended by put writers — a dip to this level is a buying opportunity, NOT a breakdown. ` +
      `The call wall at ${cwS} is the ceiling — a breakout above it triggers short covering and a fast move higher. ` +
      `Smart money wants market to expire between ${pwS} and ${cwS}, closer to ${cwS}. ` +
      `Retail fading this rally (buying puts or shorting) is walking into a trap.` + trapLine;
    oneLineTrade = `📈 BUY dips near ${pwS} (put wall). Target ${cwS}. Smart money is on your side.`;
  } else if (fiiBear && proBear) {
    overallBias = "BEARISH";
    masterConclusion =
      `FII (${fmtK(fiiNet)}) and PRO (${fmtK(proNet)}) are BOTH net short — high-conviction bearish alignment. ` +
      `The call wall at ${cwS} is actively defended by call writers — any rally to this level will be sold hard. ` +
      `The put wall at ${pwS} is the critical floor — if market falls BELOW this, put writers are forced to buy futures (delta hedging), causing a sharp bounce. ` +
      `Smart money profits most if market expires near ${pwS} from above. ` +
      `Retail buying calls or going long here is swimming against the institutional tide.` + trapLine;
    oneLineTrade = `📉 SELL rallies near ${cwS} (call wall). Watch for put wall bounce at ${pwS}.`;
  } else if ((fiiBull && proBear) || (fiiBear && proBull)) {
    overallBias = "MIXED";
    masterConclusion =
      `FII and PRO are on OPPOSITE sides — FII ${fiiStory.verdict} (${fmtK(fiiNet)}) vs PRO ${proStory.verdict} (${fmtK(proNet)}). ` +
      `This split usually happens near major turning points or when big players disagree on macro direction. ` +
      `Market likely to chop between ${pwS} and ${cwS} until one side capitulates. ` +
      `The side that "wins" will be clear when volume and OI confirm a break of either wall. ` +
      `Wait for clarity — attempting strong directional trades here has low success probability.` + trapLine;
    oneLineTrade = `⚡ RANGE TRADE: Sell near ${cwS}, buy near ${pwS}. No strong directional until walls break.`;
  } else {
    overallBias = "NEUTRAL";
    masterConclusion =
      `Institutional positioning is mixed or minimal — neither strong bulls nor strong bears. ` +
      `The market is likely in consolidation between ${pwS} (put wall) and ${cwS} (call wall). ` +
      `Option writers on both sides are profitable in this scenario — time decay is the dominant force. ` +
      `Don't pay high premium for options in a neutral market; premium buyers lose to writers.` + trapLine;
    oneLineTrade = `⚪ WAIT — no clear edge. Premium sellers win. Don't buy options at peak IV.`;
  }

  return { stories, criticalLevels, traps, masterConclusion, oneLineTrade, overallBias };
}

/* ── Formatting helpers for new widgets ─────────────────────────────────── */
function fmtPremium(v: number): string {
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 10_000_000) s = `${(v / 10_000_000).toFixed(2)} Cr`;
  else if (abs >= 100_000) s = `${(v / 100_000).toFixed(1)} L`;
  else if (abs >= 1_000)   s = `${(v / 1_000).toFixed(0)} K`;
  else                     s = v.toFixed(0);
  return v >= 0 ? `+${s}` : s;
}



/* ─── Component ─────────────────────────────────────────────────────────── */
export default function HomePage() {
  const [strike, setStrike]               = useState<number>(24_900);
  const [strikeInput, setStrikeInput]     = useState<string>("24900");
  /* tradeDate = what is shown in the date picker (may not be fetched yet) */
  const [tradeDate, setTradeDate]         = useState<string>(todayIstDate());
  /* loadedDate = the date we actually fetched — only changes when user clicks Load */
  const [loadedDate, setLoadedDate]       = useState<string>(todayIstDate());
  const [payload, setPayload]             = useState<LiveApiResponse | null>(null);
  const [error, setError]                 = useState<string>("");
  const [loading, setLoading]             = useState<boolean>(true);
  const [countdown, setCountdown]         = useState<number>(REFRESH_INTERVAL_MS);
  const nextRefreshRef                    = useRef<number>(Date.now() + REFRESH_INTERVAL_MS);

  const [showOnlyHighConf, setShowOnlyHighConf] = useState<boolean>(false);
  const [showLastThree, setShowLastThree]       = useState<boolean>(false);

  /* Derived: is the currently displayed date today? */
  const isToday        = tradeDate === todayIstDate();
  const hasPendingDate = tradeDate !== loadedDate;

  const requestUrl = useMemo(() => {
    const search = new URLSearchParams({
      index: "NIFTY",
      strike: String(strike),
      tradeDate: loadedDate,   // ← use loadedDate, not tradeDate
    });
    return `/api/live?${search.toString()}`;
  }, [strike, loadedDate]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(requestUrl, { cache: "no-store" });
      const json = (await response.json()) as LiveApiResponse & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "Live API failed");
      setPayload(json);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load live data");
    } finally {
      setLoading(false);
      // Reset countdown after each load
      nextRefreshRef.current = Date.now() + REFRESH_INTERVAL_MS;
      setCountdown(REFRESH_INTERVAL_MS);
    }
  }, [requestUrl]);



  /* ── When date picker changes back to today → auto-sync loadedDate ──────── */
  useEffect(() => {
    if (isToday) setLoadedDate(todayIstDate());
  }, [tradeDate, isToday]);

  /* ── Main refresh timer — only auto-refresh for today's data ────────────── */
  useEffect(() => {
    void load();
    // Historical dates: load once, no recurring timer
    if (!isToday) return;

    // Self-correcting setTimeout loop:
    // Instead of setInterval (which drifts and can be throttled by the browser),
    // we schedule each tick to fire at the exact next 188s wall-clock boundary.
    // If a tick fires 300ms late, the next tick fires 300ms early — drift never accumulates.
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const nextBoundary = Date.now() + REFRESH_INTERVAL_MS;
    nextRefreshRef.current = nextBoundary;

    function scheduleTick(fireAt: number) {
      const delay = Math.max(0, fireAt - Date.now());
      timerId = setTimeout(() => {
        if (cancelled) return;
        void load();
        // Advance by exactly one interval from the intended fire time,
        // not from now — this is what prevents drift accumulation.
        const next = fireAt + REFRESH_INTERVAL_MS;
        nextRefreshRef.current = next;
        scheduleTick(next);
      }, delay);
    }

    scheduleTick(nextBoundary);

    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [load, isToday]);

  /* ── Countdown ticker (updates every second) ────────────────────────────── */
  useEffect(() => {
    const tick = window.setInterval(() => {
      setCountdown(Math.max(0, nextRefreshRef.current - Date.now()));
    }, 1000);
    return () => window.clearInterval(tick);
  }, []);



  const rows              = payload?.rows ?? [];
  const normalizedTimeline = payload?.vibe.normalizedTimeline ?? [];
  const ecgTimeline       = payload?.vibe.ivEcg ?? [];
  const chartLabels       = normalizedTimeline.map((p) => p.displayTime);
  const ecgLabels         = ecgTimeline.map((p) => p.displayTime);
  const participantData   = participantRows(payload?.participantsSummary);

  // Derive smart money positions from the multi-day row history (client-side, no extra fetch).
  const positions = useMemo(() => groupPositions(rows), [rows]);

  /* ── Enhancement computed values ──────────────────────────────────────── */
  const bluf = useMemo(
    () => (payload ? generateBLUF(payload) : null),
    [payload],
  );

  const premiumFlow = useMemo(
    () => computePremiumFlow(payload?.vibe.topActiveStrikes ?? []),
    [payload],
  );

  const rollingAccum = useMemo(
    () => computeRollingAccum(participantData),
    [participantData],
  );

  const retailTrap = useMemo(
    () => computeRetailTrap(participantData),
    [participantData],
  );

  const weeklyPCR = useMemo(
    () => computePCR(
      payload?.weeklyChain ?? { expiryDate: null, spot: null, rows: [] },
      participantData,
    ),
    [payload, participantData],
  );

  const netSentiment = useMemo(
    () => computeNetSentiment(participantData),
    [participantData],
  );

  const eodNarrative = useMemo(
    () => generateEodNarrative(participantData),
    [participantData],
  );

  const streetSmartAnalysis = useMemo(
    () => generateStreetSmartAnalysis(
      participantData,
      payload?.weeklyChain ?? { expiryDate: null, spot: null, rows: [] },
      payload?.underlyingSpot ?? null,
    ),
    [participantData, payload],
  );

  return (
    <main className="page-wrap">

      {/* ── Control Card ─────────────────────────────────────────────── */}
      <section className="control-card">
        <div className="top-row">
          <h1>NIFTY Smart Money Tracker</h1>
        </div>

        <BrokerSettings onTokenUpdate={load} />

        {/* Field grid */}
        <div className="field-grid">
          <label>
            Trade Date
            <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} />
          </label>
          <label>
            Strike Price
            <input
              type="number"
              value={strikeInput}
              step={50}
              onChange={(e) => setStrikeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = Number(strikeInput);
                  if (!Number.isNaN(val) && val > 0) setStrike(val);
                }
              }}
              onBlur={() => {
                const val = Number(strikeInput);
                if (!Number.isNaN(val) && val > 0) setStrike(val);
              }}
            />
          </label>
          <label>
            Expiry Scope
            <input value="Auto: Current Week + Month-End" readOnly />
          </label>
        </div>

        {/* Refresh status */}
        <p className="refresh-meta">
          Sampled {payload?.refreshCount ?? 0}× from {payload?.pollCount ?? 0} polls
          {" · "}Last update: {payload
            ? new Date(payload.lastUpdatedIso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })
            : "--:--:--"}
          {" · "}Weekly expiry: <strong>{payload?.expiryDate ?? "…"}</strong>
          {" · "}Month-end: <strong>{payload?.monthExpiryDate ?? "…"}</strong>
          {" · "}Spot: <strong>{spot(payload?.underlyingSpot ?? null)}</strong>
          {" · "}Radar signals: <strong>{payload?.radar.activeSignals.length ?? 0}</strong>
        </p>

        <div className="refresh-countdown-bar">
          <span className="refresh-countdown">
            <span className="refresh-dot" />
            {isToday
              ? <>Next refresh in {fmtCountdown(countdown)} &nbsp;(interval: {REFRESH_INTERVAL_LABEL})</>
              : <>Historical mode — no auto-refresh. Loaded: <strong>{loadedDate}</strong></>
            }
          </span>
        </div>

        <p className="regime-meta">Current Regime: {regimeLabel(payload)}</p>
      </section>

      {/* ══ Historical Date Pending Banner ═══════════════════════════════════ */}
      {hasPendingDate && (
        <div className="hist-banner">
          <div>
            <span className="hist-banner-text">📅 Date changed to {tradeDate}</span>
            <span className="hist-banner-note">&nbsp;— Previous day data is NOT loaded automatically.</span>
          </div>
          <button
            type="button"
            className="hist-load-btn"
            onClick={() => setLoadedDate(tradeDate)}
          >
            📂 Load {tradeDate} Data
          </button>
        </div>
      )}

      {/* ══ BLUF — One-line market verdict ══════════════════════════════════ */}
      {bluf && (
        <div className="bluf-box">
          <span className="bluf-icon">🎯</span>
          <div className="bluf-body">
            <div className="bluf-label">Today's Trading Summary — Plain English</div>
            <p className="bluf-text">{bluf}</p>
          </div>
        </div>
      )}

      {/* ══ NET SENTIMENT ENGINE — FII / PRO / CLIENT VERDICT ═══════════════ */}
      <section className="sentiment-section">
        <h2>🧠 Net Sentiment Engine — Who's Bullish, Who's Bearish</h2>
        <div className="explain-bar">
          <span className="explain-chip">
            <strong>Formula:</strong> Bullish Score = Call Long + Put Short (betting market goes UP).
            Bearish Score = Put Long + Call Short (betting market goes DOWN).
            Net Score = Bullish − Bearish. <strong>Positive = BULLISH. Negative = BEARISH.</strong>
            <strong>Rule:</strong> Long positions (buying) go to Far OTM strikes.
            Short positions (writing) go to Near ATM strikes.
            <strong>Follow FII + PRO. Fade CLIENT when they diverge.</strong>
          </span>
        </div>
        {netSentiment.length === 0 ? (
          <p className="events-empty">Waiting for NSE EOD participant data…</p>
        ) : (
          <div className="sentiment-grid">
            {netSentiment.map((row) => {
              const total = row.totalBullish + row.totalBearish;
              const bullPct = total > 0 ? (row.totalBullish / total) * 100 : 50;
              const bearPct = total > 0 ? (row.totalBearish / total) * 100 : 50;
              return (
                <div key={row.participant} className={`sentiment-card sentiment-${row.verdict.toLowerCase()}`}>
                  <div className="sentiment-header">
                    <span className="sentiment-name">{row.participant}</span>
                    <span className={`sentiment-verdict ${row.verdict === "BULLISH" ? "status-matched" : row.verdict === "BEARISH" ? "status-contradicted" : "status-neutral"}`}>
                      {row.verdict === "BULLISH" ? "🟢 BULLISH" : row.verdict === "BEARISH" ? "🔴 BEARISH" : "⚪ NEUTRAL"}
                    </span>
                  </div>
                  {/* Bull vs Bear bar */}
                  <div className="sentiment-bar-wrap">
                    <div className="sentiment-bar-track">
                      <div className="sentiment-bar-bull" style={{ width: `${bullPct.toFixed(1)}%` }} />
                      <div className="sentiment-bar-bear" style={{ width: `${bearPct.toFixed(1)}%` }} />
                    </div>
                    <div className="sentiment-bar-labels">
                      <span style={{ color: "var(--bull)" }}>↑ {bullPct.toFixed(0)}% Bullish</span>
                      <span style={{ color: "var(--bear)" }}>{bearPct.toFixed(0)}% Bearish ↓</span>
                    </div>
                  </div>
                  <div className="sentiment-rows">
                    <div className="sentiment-row">
                      <span className="sentiment-label">Call Long <em className="metric-tip">(bought calls, bullish)</em></span>
                      <strong className="pos">{fmtNet(row.callLong)}</strong>
                    </div>
                    <div className="sentiment-row">
                      <span className="sentiment-label">Put Short <em className="metric-tip">(wrote puts, bullish)</em></span>
                      <strong className="pos">{fmtNet(row.putShort)}</strong>
                    </div>
                    <div className="sentiment-row">
                      <span className="sentiment-label">Put Long <em className="metric-tip">(bought puts, bearish)</em></span>
                      <strong className="neg">{fmtNet(row.putLong)}</strong>
                    </div>
                    <div className="sentiment-row">
                      <span className="sentiment-label">Call Short <em className="metric-tip">(wrote calls, bearish)</em></span>
                      <strong className="neg">{fmtNet(row.callShort)}</strong>
                    </div>
                    <div className="sentiment-row sentiment-net-row">
                      <span><strong>NET SCORE</strong></span>
                      <strong style={{ fontSize: 14, color: row.netScore > 0 ? "var(--bull)" : row.netScore < 0 ? "var(--bear)" : "var(--muted)" }}>
                        {row.netScore > 0 ? "+" : ""}{fmtNet(row.netScore)}
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ════ STREET-SMART ANALYSIS ════════════════════════════════════════ */}
        {streetSmartAnalysis && (
          <div className="ssa-wrap">

            {/* Section header */}
            <div className="ssa-header">
              <h3 className="ssa-title">🕵️ Street-Smart Analysis — What Big Money is Really Doing</h3>
              <span className={`ssa-bias-pill ssa-bias-${streetSmartAnalysis.overallBias.toLowerCase()}`}>
                {streetSmartAnalysis.overallBias}
              </span>
            </div>
            <p className="ssa-subtitle">
              Built from NSE EOD OI data. Compares yesterday's positions to today's, identifies who is writing options, who holds futures, which levels they must defend to stay in profit, and where retail is walking into a trap.
            </p>

            {/* Per-participant story cards */}
            <div className="ssa-story-grid">
              {streetSmartAnalysis.stories.map((story) => (
                <div key={story.participant} className={`ssa-story-card ssa-${story.verdict.toLowerCase()}`}>
                  <div className="ssa-story-header">
                    <span className="ssa-story-name">
                      {story.participant === "FII" ? "🏦 FII" : story.participant === "PRO" ? "⚡ PROP DESK" : "👥 RETAIL (CLIENT)"}
                    </span>
                    <span className={`ssa-story-verdict ssa-verdict-${story.verdict.toLowerCase()}`}>
                      {story.verdict === "BULLISH" ? "🟢 BULLISH" : story.verdict === "BEARISH" ? "🔴 BEARISH" : "⚪ NEUTRAL"}
                    </span>
                  </div>

                  <div className="ssa-story-block">
                    <span className="ssa-story-block-label">📅 Yesterday they held</span>
                    <p className="ssa-story-text">{story.yesterdayBrief}</p>
                  </div>

                  <div className="ssa-story-block">
                    <span className="ssa-story-block-label">📊 What they did today</span>
                    <p className="ssa-story-text">{story.todayAction}</p>
                  </div>

                  <div className="ssa-story-block">
                    <span className="ssa-story-block-label">📌 Net position now</span>
                    <p className={`ssa-story-net ssa-net-${story.verdict.toLowerCase()}`}>{story.netStance}</p>
                  </div>

                  <div className="ssa-story-block ssa-pain-block">
                    <span className="ssa-story-block-label">🎯 Key level to watch</span>
                    <code className="ssa-key-level">{story.keyLevel}</code>
                    <p className="ssa-story-text" style={{ marginTop: 4 }}>{story.painPoint}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Critical levels table */}
            {streetSmartAnalysis.criticalLevels.length > 0 && (
              <div className="ssa-levels-wrap">
                <h4 className="ssa-sub-heading">🧱 Critical Levels — Where the Walls Are</h4>
                <div className="ssa-levels-grid">
                  {streetSmartAnalysis.criticalLevels.map((lvl) => (
                    <div key={lvl.label} className={`ssa-level-card ssa-level-${lvl.side.toLowerCase()}`}>
                      <div className="ssa-level-header">
                        <span className="ssa-level-label">{lvl.label}</span>
                        <span className="ssa-level-oi">OI: {lvl.oi.toLocaleString("en-IN")}</span>
                      </div>
                      <p className="ssa-level-defender">Defended by: <strong>{lvl.whoDefends}</strong></p>
                      <p className="ssa-level-impl">{lvl.tradingImplication}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trap alerts */}
            {streetSmartAnalysis.traps.length > 0 && (
              <div className="ssa-traps-wrap">
                <h4 className="ssa-sub-heading">🪤 Active Traps Detected</h4>
                {streetSmartAnalysis.traps.map((trap, i) => (
                  <div key={i} className={`ssa-trap-card ssa-trap-${trap.severity.toLowerCase()}`}>
                    <div className="ssa-trap-headline">{trap.headline}</div>
                    <p className="ssa-trap-detail">{trap.detail}</p>
                    <div className="ssa-trap-advice">
                      <span className="ssa-trap-advice-label">💡 What to do:</span>
                      {" "}{trap.advice}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Master conclusion */}
            <div className={`ssa-conclusion ssa-conclusion-${streetSmartAnalysis.overallBias.toLowerCase()}`}>
              <div className="ssa-conclusion-header">🧠 Master Conclusion</div>
              <p className="ssa-conclusion-text">{streetSmartAnalysis.masterConclusion}</p>
              <div className="ssa-one-line-trade">{streetSmartAnalysis.oneLineTrade}</div>
            </div>

          </div>
        )}

      </section>

      {/* ── EOD Participants ─────────────────────────────────────────── */}
      <section className="eod-section">
        <h2>🏦 Who's Actually Positioned What — End of Day Data</h2>
        <div className="explain-bar">
          <span className="explain-chip">
            <strong>FII</strong> = Foreign Institutional Investors (big foreign funds — the smartest money).
            <strong> PRO</strong> = Proprietary traders (Indian brokers trading their own money — very sharp).
            <strong> CLIENT</strong> = Retail traders (you and me — usually on the wrong side).
            <strong> Positive number</strong> = net long (bullish position).
            <strong> Negative number</strong> = net short (bearish position).
            <strong>Key rule:</strong> Follow FII and PRO. Fade (go opposite to) CLIENT when FII/PRO diverge from them.
          </span>
        </div>
        <div className="legend-row">
          <span className="legend-pill legend-pill-bull">+ Positive = Net Long (Bullish)</span>
          <span className="legend-pill legend-pill-bear">− Negative = Net Short (Bearish)</span>
          <span className="legend-pill legend-pill-accent">FII + PRO direction = Smart Money verdict</span>
          <span className="legend-pill legend-pill-warn">CLIENT opposite to FII = Trap forming</span>
        </div>
        <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 8px" }}>
          Source: NSE Official Bhav Copy{" "}
          {payload?.participantsSummary?.sourceUrl ? (
            <a href={payload.participantsSummary.sourceUrl} target="_blank" rel="noreferrer">↗ View raw data</a>
          ) : null}
        </p>

        {/* ─── Participant Cards — easy at-a-glance view ─────────────── */}
        {participantData.length > 0 ? (
          <div className="participant-cards-grid">
            {participantData.map((row) => {
              // Compute simple net index position for the card headline
              const todayIfNet = (row.today.indexFuture ?? 0) + (row.today.indexCall ?? 0) - (row.today.indexPut ?? 0);
              const flowIfNet  = row.todayTradeFlow
                ? ((row.todayTradeFlow.indexFuture ?? 0) + (row.todayTradeFlow.indexCall ?? 0) - (row.todayTradeFlow.indexPut ?? 0))
                : null;
              return (
                <div key={row.participant} className="participant-card">
                  <div className="participant-card-header">
                    <span className="participant-card-name">{row.participant}</span>
                    <span className={`participant-card-tone ${participantCardToneClass(row)}`}>
                      {participantCardToneLabel(row)}
                    </span>
                  </div>

                  {/* Today's net index open interest */}
                  <div className="participant-segment-label">Today — Index OI Net</div>
                  <div className="participant-card-row">
                    <span className="participant-card-label">Idx Future</span>
                    <span className={`participant-card-value ${netToneClass(row.today.indexFuture)}`}>{fmtNet(row.today.indexFuture)}</span>
                  </div>
                  <div className="participant-card-row">
                    <span className="participant-card-label">Idx Call</span>
                    <span className={`participant-card-value ${netToneClass(row.today.indexCall)}`}>{fmtNet(row.today.indexCall)}</span>
                  </div>
                  <div className="participant-card-row">
                    <span className="participant-card-label">Idx Put</span>
                    <span className={`participant-card-value ${netToneClass(row.today.indexPut)}`}>{fmtNet(row.today.indexPut)}</span>
                  </div>
                  <div className="participant-card-row">
                    <span className="participant-card-label" style={{ fontWeight: 700 }}>Net Index Bias</span>
                    <span className={`participant-card-value ${netToneClass(todayIfNet)}`} style={{ fontWeight: 800, fontSize: 13 }}>
                      {fmtNet(todayIfNet)}
                    </span>
                  </div>

                  {/* Today's trade flow (intraday change) */}
                  {row.todayTradeFlow ? (
                    <>
                      <div className="participant-segment-label" style={{ marginTop: 10 }}>Today Flow (Δ from prev close)</div>
                      <div className="participant-card-row">
                        <span className="participant-card-label">IF Flow</span>
                        <span className={`participant-card-value ${netToneClass(row.todayTradeFlow.indexFuture)}`}>{fmtNet(row.todayTradeFlow.indexFuture)}</span>
                      </div>
                      <div className="participant-card-row">
                        <span className="participant-card-label">IC Flow</span>
                        <span className={`participant-card-value ${netToneClass(row.todayTradeFlow.indexCall)}`}>{fmtNet(row.todayTradeFlow.indexCall)}</span>
                      </div>
                      <div className="participant-card-row">
                        <span className="participant-card-label">IP Flow</span>
                        <span className={`participant-card-value ${netToneClass(row.todayTradeFlow.indexPut)}`}>{fmtNet(row.todayTradeFlow.indexPut)}</span>
                      </div>
                      {flowIfNet !== null ? (
                        <div className="participant-card-row">
                          <span className="participant-card-label" style={{ fontWeight: 700 }}>Net Flow Bias</span>
                          <span className={`participant-card-value ${netToneClass(flowIfNet)}`} style={{ fontWeight: 800, fontSize: 13 }}>
                            {fmtNet(flowIfNet)}
                          </span>
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {/* 5D trend text */}
                  {payload?.participantsSummary?.fiveDayTrends ? (
                    (() => {
                      const trend = payload.participantsSummary.fiveDayTrends?.find(
                        (t) => t.participant === row.participant
                      );
                      if (!trend) return null;
                      return (
                        <div className="participant-card-trend">
                          <strong style={{ color: "var(--text)" }}>5-Day Trend: </strong>
                          {trend.summary}
                        </div>
                      );
                    })()
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="events-empty" style={{ marginTop: 8 }}>No EOD participant data available yet.</p>
        )}

        {/* ══ What Each Player Did Today — Plain-English Narrative ════════ */}
        {eodNarrative && (
          <div className="eod-narrative-section">
            <h3 style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 800 }}>
              📖 What Happened Today — Plain English Breakdown
            </h3>
            <p className="metric-tip" style={{ marginBottom: 8, fontSize: 11 }}>
              Below is a human-readable story of what each major participant did today vs yesterday, what positions they hold right now, and what smart money might be planning.
            </p>

            {/* Individual participant narratives */}
            <div className="eod-narrative-grid">
              {eodNarrative.narratives.map((n) => (
                <div key={n.participant} className="eod-narrative-card">
                  <h4>
                    {n.participant}
                    <span className={`eod-narrative-verdict ${n.simpleVerdict === "BULLISH" ? "bull" : n.simpleVerdict === "BEARISH" ? "bear" : "neut"}`}>
                      {n.simpleVerdict === "BULLISH" ? "🟢 BULLISH" : n.simpleVerdict === "BEARISH" ? "🔴 BEARISH" : "⚪ NEUTRAL"}
                    </span>
                  </h4>
                  <ul className="eod-narrative-sentences">
                    {n.sentences.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                  <div className="eod-narrative-position">{n.netPosition}</div>
                </div>
              ))}
            </div>

            {/* Smart money summary box */}
            <div className={`eod-smart-money-box ${
              eodNarrative.smartMoneyVerdict === "BULLISH" ? "bull"
              : eodNarrative.smartMoneyVerdict === "BEARISH" ? "bear"
              : eodNarrative.smartMoneyVerdict === "MIXED" ? "mixed" : "neut"
            }`}>
              <strong style={{ display: "block", marginBottom: 4, fontSize: 13, letterSpacing: "0.02em" }}>
                🧠 Smart Money Conclusion
              </strong>
              {eodNarrative.smartMoneySummary}
            </div>
          </div>
        )}

        {/* ── Detailed EOD table ───────────────────────────────────── */}
        <h3>Detailed Segment Breakdown (Today)</h3>
        <ParticipantSummaryTable rows={payload?.participantsSummary?.rows ?? []} />

        {/* ── Narrative ────────────────────────────────────────────── */}
        <div className="narrative-list">
          {(payload?.participantsSummary?.narrative ?? []).map((note) => (
            <p key={note}>{note}</p>
          ))}
          {(payload?.eodTally.eodSignals ?? []).map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>

        {/* ── Inferred Big Player Activity ─────────────────────────── */}
        <h3>Inferred Big Player Activity</h3>
        <p className="events-subtitle">
          Targeted strikes with heavy positional buildup during the day.
        </p>
        <ParticipantIntelTable inferences={payload?.participantIntel.strikeInferences ?? []} />

        {/* ── 5-Day Trend Cards ─────────────────────────────────────── */}
        <h3>5-Day Trend Summary</h3>
        <div className="participant-intel-grid">
          <article className="summary-card participant-intel-card">
            <h2>FII (5D)</h2>
            <p className="mono">{payload?.participantIntel.fiiTrend ?? "FII trend pending."}</p>
          </article>
          <article className="summary-card participant-intel-card">
            <h2>Prop Desk (5D)</h2>
            <p className="mono">{payload?.participantIntel.proTrend ?? "Prop trend pending."}</p>
          </article>
          <article className="summary-card participant-intel-card">
            <h2>Retail / Clients (5D)</h2>
            <p className="mono">{payload?.participantIntel.retailTrend ?? "Retail trend pending."}</p>
          </article>
        </div>

        {/* Source link */}
        <p className="source-line">
          NSE Source:{" "}
          {payload?.participantsSummary?.sourceUrl ? (
            <a href={payload.participantsSummary.sourceUrl} target="_blank" rel="noreferrer">NSE Bhav Copy ↗</a>
          ) : (
            "Awaiting file"
          )}
        </p>
        <p className="backup-line">{payload?.participantIntel.bigPlayerSummary ?? "Big-player summary pending."}</p>
      </section>

      {/* ── Option Chains ──────────────────────────────────────────────── */}
      {/* Key Level Banner (Change 6) */}
      {(() => {
        const kl = computeNextKeyLevels(
          payload?.weeklyChain,
          payload?.underlyingSpot ?? null,
          payload?.participantsSummary,
        );
        const wdsFmt = (wds: number | null) =>
          wds !== null ? `WDS: ${wds.toFixed(1)}/10` : null;
        return (
          <div className="key-level-banner">
            <div className="klb-side klb-resistance">
              <span className="klb-tag">⬆ Next Resistance (CE Wall)</span>
              <span className="klb-level">{kl.resistance ? kl.resistance.toLocaleString("en-IN") : "—"}</span>
              <span className="klb-desc">{kl.resistanceDesc}</span>
              {wdsFmt(kl.resistanceWds) && (
                <span
                  className="wds-chip wds-resistance"
                  title="Wall Defense Score: how committed are FII+PRO to defending this level?"
                >
                  {wdsFmt(kl.resistanceWds)}
                </span>
              )}
            </div>
            <div className="klb-side klb-support">
              <span className="klb-tag">⬇ Next Support (PE Wall)</span>
              <span className="klb-level">{kl.support ? kl.support.toLocaleString("en-IN") : "—"}</span>
              <span className="klb-desc">{kl.supportDesc}</span>
              {wdsFmt(kl.supportWds) && (
                <span
                  className="wds-chip wds-support"
                  title="Wall Defense Score: how committed are FII+PRO to defending this level?"
                >
                  {wdsFmt(kl.supportWds)}
                </span>
              )}
            </div>
          </div>
        );
      })()}
      <div className="explain-bar">
        <span className="explain-chip">
          <strong>How to read the Option Chain:</strong> Each row is a strike price.
          <strong> CE = Call option</strong> (buyers profit if market goes UP).
          <strong> PE = Put option</strong> (buyers profit if market goes DOWN).
          <strong> OI</strong> = total open contracts at that strike — higher means more interest.
          <strong> COI</strong> = change in OI since today's open — positive means new positions being added (green), negative means positions closing (red).
          <strong> COI/Vol &gt; 0.5</strong> = smart money building positions, not just day-trading. The highlighted row = current market price.
        </span>
      </div>
      <section className="spot-chain-grid">
        <CenteredExpiryTable
          title="Current Week Expiry Chain"
          snapshot={payload?.weeklyChain ?? { expiryDate: null, spot: null, rows: [] }}
        />
        <CenteredExpiryTable
          title="Month-End Expiry Chain"
          snapshot={payload?.monthlyChain ?? { expiryDate: null, spot: null, rows: [] }}
        />
      </section>

      {/* ══ 3-Minute Strike Capture — RIGHT BELOW OPTION CHAINS ═════════════ */}
      <section className="timeline-section timeline-center">
        <h2>⏱ 3-Min Smart Money Tracker — Strike {payload?.strike ?? strike} &nbsp;
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--muted)" }}>
            {isToday ? "🟢 Live" : `📅 Historical: ${loadedDate}`}
          </span>
        </h2>
        <div className="explain-bar">
          <span className="explain-chip">
            <strong>What is this?</strong> Every ~3 minutes, we snapshot your selected strike.
            <strong> C-OI rising</strong> = more call writers/buyers entering — watch direction.
            <strong> P-OI rising</strong> = more put writers/buyers entering.
            <strong> CE Signal = "Exchange of Hands"</strong> → positions changing ownership — reversal may follow.
            <strong> C-POS / P-POS &gt; 1</strong> = positional (multi-day) conviction, not just intraday noise.
            Expiry: <strong>{payload?.expiryDate ?? "—"}</strong>
          </span>
        </div>
        <div className="legend-row">
          <span className="legend-pill legend-pill-bull">▲ OI Rising = New Positions Building</span>
          <span className="legend-pill legend-pill-bear">▼ OI Falling = Positions Closing / Squaring Off</span>
          <span className="legend-pill legend-pill-accent">C-POS/P-POS &gt; 1 = Smart Money, Not Day-Trade Noise</span>
          <span className="legend-pill legend-pill-warn">Exchange of Hands = Reversal Signal</span>
        </div>
        {/* ── Session Summary Bar (Change 2) ──────────────────────────── */}
        {(() => {
          const ss = computeSessionSummary(rows);
          return (
            <div className="session-summary-bar">
              <span className="ssb-label">Session Peak</span>
              <span className="ssb-text">{ss.text}</span>
              <span className={`ssb-badge ${ss.badgeCls}`}>{ss.unifiedLabel}</span>
            </div>
          );
        })()}
        {/* ── Filter Controls (Change 2) ──────────────────────────────── */}
        <div className="lct-filter-row">
          <span className="lct-filter-label">Filter:</span>
          <button
            type="button"
            className={`lct-filter-btn${showOnlyHighConf ? " active" : ""}`}
            onClick={() => setShowOnlyHighConf((v) => !v)}
          >
            &gt;70% Confidence
          </button>
          <button
            type="button"
            className={`lct-filter-btn${showLastThree ? " active" : ""}`}
            onClick={() => setShowLastThree((v) => !v)}
          >
            Show Last 3
          </button>
          {(showOnlyHighConf || showLastThree) && (
            <button
              type="button"
              className="lct-filter-btn"
              onClick={() => { setShowOnlyHighConf(false); setShowLastThree(false); }}
            >
              ✕ Clear
            </button>
          )}
        </div>
        <LiveChainTable
          rows={rows}
          strike={payload?.strike ?? strike}
          filterConf={showOnlyHighConf ? 70 : undefined}
          maxRows={showLastThree ? 3 : undefined}
        />
      </section>

      {/* ══ OI Bar Profile — Visual Walls ═══════════════════════════════════ */}
      <section className="oibp-section">
        <h2>OI Bar Profile — Where Smart Money Has Built Walls</h2>
        <div className="explain-bar">
          <span className="explain-chip">
            <strong>What is this?</strong> This shows you visually where large institutions have stacked the most option contracts.
            <strong> Green bars (left side)</strong> = Put options = support levels. Market tends to bounce UP from here.
            <strong> Red bars (right side)</strong> = Call options = resistance levels. Market tends to reverse DOWN from here.
            <strong> Thickest bar</strong> = the most important level — this is where the wall is.
            The price is likely to stay between the Put Wall and Call Wall until expiry.
          </span>
        </div>
        <div className="legend-row">
          <span className="legend-pill legend-pill-bull">🟢 Green Bar = Put OI = Support (buy zone)</span>
          <span className="legend-pill legend-pill-bear">🔴 Red Bar = Call OI = Resistance (sell zone)</span>
          <span className="legend-pill legend-pill-warn">◄ Yellow Row = Current Price</span>
          <span className="legend-pill legend-pill-accent">Thicker Bar = Stronger Wall</span>
        </div>
        <div className="oibp-grid">
          <div className="oibp-card">
            <div className="oibp-card-title">Weekly Expiry — {payload?.expiryDate ?? "…"}</div>
            <OiBarProfile snapshot={payload?.weeklyChain ?? { expiryDate: null, spot: null, rows: [] }} />
          </div>
          <div className="oibp-card">
            <div className="oibp-card-title">Month-End Expiry — {payload?.monthExpiryDate ?? "…"}</div>
            <OiBarProfile snapshot={payload?.monthlyChain ?? { expiryDate: null, spot: null, rows: [] }} />
          </div>
        </div>
      </section>

      {/* ── Status Board (Change 5) ──────────────────────────────────── */}
      {(() => {
        const sb = computeStatusBoard(payload, retailTrap);
        const tiles: { label: string; value: string; sub: string; cls: string }[] = [
          { label: "Big Money Activity",  value: sb.bigMoneyActivity,  sub: sb.bigMoneySub,  cls: `status-tile-${sb.bigMoneyCls}` },
          { label: "Market Regime",       value: sb.marketRegime,      sub: sb.regimeSub,    cls: `status-tile-${sb.regimeCls}` },
          { label: "Retail Trap",         value: sb.primaryTrap,       sub: sb.trapSub,      cls: `status-tile-${sb.trapCls}` },
          { label: "Key Alert",           value: sb.keyAlert,          sub: "",              cls: `status-tile-${sb.alertCls}` },
        ];
        const trapSpringFired = (payload?.vibe?.alerts ?? []).some(
          (a: import("@/lib/types").VibeAlert) => a.kind === "TRAP_SPRING"
        );
        const pdiTileClass = trapSpringFired ? "pdi-tile pdi-trap-spring" : "pdi-tile";
        return (
          <>
            <div className="status-board">
              {tiles.map((t) => (
                <div key={t.label} className={`status-tile ${t.cls}`}>
                  <span className="status-tile-label">{t.label}</span>
                  <span className="status-tile-value">{t.value}</span>
                  {t.sub && <span className="status-tile-sub">{t.sub}</span>}
                </div>
              ))}
            </div>
            <div className={pdiTileClass}>
              <span className="pdi-label">
                📡 Positioning Divergence Index
                <em className="metric-tip"> (CLIENT long calls vs FII/PRO short calls)</em>
              </span>
              {trapSpringFired ? (
                <span className="pdi-value trap-spring-badge">⚠ TRAP SPRING — High-Probability Trap Setup Active</span>
              ) : (
                <span className="pdi-value pdi-neutral">
                  {payload?.vibe
                    ? "Monitoring — no extreme divergence detected yet."
                    : "Waiting for participant data…"}
                </span>
              )}
              <span className="pdi-sub">Fires when PDI ≥ 90th-percentile AND clustering ≥ 6/10 at a key strike</span>
            </div>
          </>
        );
      })()}

      {/* ── Summary Cards ────────────────────────────────────────────── */}
      <section className="summary-grid">
        <article className="summary-card">
          <h2>📊 What's Happening Right Now</h2>
          <p className="metric-tip" style={{ marginBottom: 6, fontSize: 11 }}>
            The algorithm reads 3-minute OI/volume data and tells you if smart money is buying or selling.
          </p>
          <p className="mono">{payload?.intradaySummary.latestNarrative ?? "Waiting for first print"}</p>
          <div className="kv">
            <span>Who's in control <em className="metric-tip">(dominant activity type)</em></span>
            <strong>{payload?.intradaySummary.dominant.replaceAll("_", " ") ?? "NEUTRAL"}</strong>
          </div>
          <div className="kv">
            <span>How sure are we <em className="metric-tip">(higher = stronger signal)</em></span>
            <strong>{payload ? `${payload.intradaySummary.dominantConfidence.toFixed(1)}%` : "0.0%"}</strong>
          </div>
          <div className="kv">
            <span>Overall market mood</span>
            <strong>{payload?.intradaySummary.marketTone ?? "MIXED"}</strong>
          </div>
        </article>

        <article className="summary-card">
          <h2>🎯 ATM Strike Radar (±300 pts)</h2>
          <p className="metric-tip" style={{ marginBottom: 6, fontSize: 11 }}>
            Watches the strikes closest to the current price for smart money activity.
            <strong> BULLISH</strong> = big players buying/writing puts.
            <strong> BEARISH</strong> = big players writing calls or buying puts aggressively.
          </p>
          <p className={`status-pill ${radarRegimeClass(payload?.radar.regime ?? "NEUTRAL")}`}>
            {payload?.radar.regime ?? "NEUTRAL"}
          </p>
          <p style={{ margin: "8px 0", fontSize: "12px" }}>{payload?.radar.summary ?? "Monitoring ATM ±300 strikes…"}</p>
          <div className="kv">
            <span>Active signals <em className="metric-tip">(bull / bear)</em></span>
            <strong>
              {payload
                ? `${payload.radar.activeSignals.length} (${payload.radar.bullishSignals} ↑ / ${payload.radar.bearishSignals} ↓)`
                : "0 (0 / 0)"}
            </strong>
          </div>
          <div className="kv">
            <span>Strikes being watched</span>
            <strong>{payload?.radar.consideredStrikes ?? 0}</strong>
          </div>
        </article>

        <article className="summary-card">
          <h2>🤝 Live vs EOD Match</h2>
          <p className="metric-tip" style={{ marginBottom: 6, fontSize: 11 }}>
            Compares what FIIs/institutions are doing <strong>intraday</strong> vs their <strong>official end-of-day</strong> positions.
            <strong> MATCHED</strong> = consistent signal (high confidence).
            <strong> CONTRADICTED</strong> = they may be faking intraday moves.
          </p>
          <p className={`status-pill ${correlationClass(payload?.eodCorrelation.status ?? "UNAVAILABLE")}`}>
            {payload?.eodCorrelation.status ?? "UNAVAILABLE"}
            {payload ? ` (score: ${payload.eodCorrelation.score})` : ""}
          </p>
          <p style={{ margin: "8px 0", fontSize: "12px" }}>{payload?.participantsSummary?.fiiBias ?? "Waiting for NSE participant file"}</p>
          <ul>
            {(payload?.eodCorrelation.notes ?? []).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </article>

        <article className="summary-card">
          <h2>📋 EOD Score Card</h2>
          <p className="metric-tip" style={{ marginBottom: 6, fontSize: 11 }}>
            Summary of what the NSE official data says about today's trading.
            <strong> MATCHED</strong> = intraday signals confirm EOD data.
            Intraday Tone is what the live data says. EOD FII Tone is what the official NSE file says.
          </p>
          <p className={`status-pill ${tallyClass(payload?.eodTally.status ?? "UNAVAILABLE")}`}>
            {payload?.eodTally.status ?? "UNAVAILABLE"}
          </p>
          <p style={{ margin: "8px 0", fontSize: "12px" }}>{payload?.eodTally.summary ?? "Waiting for tally data."}</p>
          <div className="kv">
            <span>Live feed reading</span>
            <strong>{payload?.eodTally.intradayTone ?? "NEUTRAL"}</strong>
          </div>
          <div className="kv">
            <span>FII official data reading</span>
            <strong>{payload?.eodTally.eodFiiTone ?? "NEUTRAL"}</strong>
          </div>
          <div className="kv">
            <span>Data samples captured</span>
            <strong>
              {payload ? `${payload.eodTally.intradayStats.sampleCount} samples / ${payload.eodTally.intradayStats.eventCount} events` : "0 / 0"}
            </strong>
          </div>
        </article>

        <article className="summary-card">
          <h2>⚙️ System Status</h2>
          {error ? <p className="error-text">{error}</p> : null}
          <p className="backup-line">
            Data backup: {payload?.backupInfo ? `10-day rolling (${payload.backupInfo.totalBackups} files saved)` : "pending"}
          </p>
          <ul>
            {(payload?.warnings ?? []).length === 0 ? <li style={{ color: "var(--bull)" }}>✓ All systems normal. No warnings.</li> : null}
            {(payload?.warnings ?? []).map((w) => <li key={w}>{w}</li>)}
          </ul>
        </article>

        {/* ══ Premium Money Flow ═══════════════════════════════════════════════ */}
        <article className="summary-card">
          <h2>💰 Estimated Premium Flow</h2>
          <p className="metric-tip" style={{ marginBottom: 8, display: "block", fontSize: 11, lineHeight: 1.5 }}>
            This shows where money is actually flowing in rupee terms.
            Formula: <strong>|Change in OI| × Option Price</strong> = capital committed at that strike.
            <strong> CE Flow higher</strong> = more money going into calls (bearish, big players selling calls).
            <strong> PE Flow higher</strong> = more money going into puts (bullish, big players buying protection).
          </p>
          <div className="pflow-grid">
            <div className="pflow-block">
              <div className="pflow-block-label ce-label">Call Side</div>
              <div className="pflow-row">
                <span className="pflow-label">CE Flow</span>
                <span className={`pflow-val ${premiumFlow.ceFlow > 0 ? "neg" : ""}`}>
                  {fmtPremium(premiumFlow.ceFlow)}
                </span>
              </div>
              <div className="pflow-row">
                <span className="pflow-label">Top Strike</span>
                <span className="pflow-val">{premiumFlow.topCeStrike ?? "—"}</span>
              </div>
            </div>
            <div className="pflow-block">
              <div className="pflow-block-label pe-label">Put Side</div>
              <div className="pflow-row">
                <span className="pflow-label">PE Flow</span>
                <span className={`pflow-val ${premiumFlow.peFlow > 0 ? "pos" : ""}`}>
                  {fmtPremium(premiumFlow.peFlow)}
                </span>
              </div>
              <div className="pflow-row">
                <span className="pflow-label">Top Strike</span>
                <span className="pflow-val">{premiumFlow.topPeStrike ?? "—"}</span>
              </div>
            </div>
          </div>
          <div className={`pflow-net-bar ${
            premiumFlow.interpretation === "BEARISH_MONEY_FLOW" ? "bearish-flow" :
            premiumFlow.interpretation === "BULLISH_MONEY_FLOW" ? "bullish-flow" : "neutral-flow"
          }`}>
            <span className="pflow-net-label">Net Premium Bias</span>
            <span className={`pflow-net-val ${
              premiumFlow.interpretation === "BEARISH_MONEY_FLOW" ? "neg" :
              premiumFlow.interpretation === "BULLISH_MONEY_FLOW" ? "pos" : ""
            }`} style={{ color: premiumFlow.interpretation === "BEARISH_MONEY_FLOW" ? "var(--bear)" : premiumFlow.interpretation === "BULLISH_MONEY_FLOW" ? "var(--bull)" : "var(--muted)" }}>
              {premiumFlow.interpretation.replaceAll("_", " ")}
            </span>
          </div>
        </article>

        {/* ══ Retail Trap Detector ═════════════════════════════════════════════ */}
        <article className="summary-card">
          <h2>⚠️ Retail Trap Detector</h2>
          <p className="metric-tip" style={{ marginBottom: 8, display: "block", fontSize: 11, lineHeight: 1.5 }}>
            <strong>What is a trap?</strong> Retail traders buy options, smart money (FII/PRO) writes the SAME options against them.
            When both sides are extreme, retail gets wiped out. <strong>Long Trap</strong> = retail bought calls, smart money is short — price will likely fall.
            <strong> Short Trap</strong> = retail bought puts, smart money is short — price will likely rise. The bars below show the mismatch.
          </p>
          {/* ── Trap Badge (Change 3) ──────────────────────────────── */}
          <div className={`trap-badge ${
            retailTrap.trapStrength === "NONE" ? "trap-none" :
            retailTrap.trapStrength === "EXTREME" ? "trap-extreme" : "trap-elevated"
          }`}>
            <span className="trap-badge-title">
              {retailTrap.trapStrength === "NONE"
                ? "✓ NO TRAP ACTIVE"
                : retailTrap.longTrap
                ? (retailTrap.trapStrength === "EXTREME" ? "🔴 EXTREME LONG TRAP" : "⚡ LONG TRAP ACTIVE")
                : (retailTrap.trapStrength === "EXTREME" ? "🔴 EXTREME SHORT TRAP" : "⚡ SHORT TRAP ACTIVE")}
            </span>
            <span className="trap-badge-subtitle">
              CLIENT Long Calls: {retailTrap.clientCallPct.toFixed(0)}% | Smart Short Calls: {retailTrap.fiiProCallShortPct.toFixed(0)}% | Net Diff: {(retailTrap.clientCallPct - retailTrap.fiiProCallShortPct).toFixed(0)}pts
            </span>
          </div>
          {/* Traffic light */}
          <div className="trap-traffic">
            <div className="trap-light-group">
              <div className={`trap-light ${retailTrap.trapStrength === "NONE" ? "trap-light-green" : "trap-light-off"}`} title="Clear" />
              <div className={`trap-light ${retailTrap.trapStrength === "ELEVATED" ? "trap-light-yellow" : "trap-light-off"}`} title="Elevated" />
              <div className={`trap-light ${retailTrap.trapStrength === "EXTREME" ? "trap-light-red" : "trap-light-off"}`} title="Extreme" />
            </div>
            <div className="trap-light-text">
              {retailTrap.trapStrength === "NONE"     && "✓ No active trap — positions balanced"}
              {retailTrap.trapStrength === "ELEVATED" && (retailTrap.longTrap ? "⚡ LONG TRAP RISK — look to short bounces" : "⚡ SHORT TRAP RISK — watch for unwind")}
              {retailTrap.trapStrength === "EXTREME"  && (retailTrap.longTrap ? "🔴 EXTREME LONG TRAP — high reversal probability" : "🔴 EXTREME SHORT TRAP — squeeze likely")}
            </div>
          </div>
          {/* Call trap bars */}
          <div className="trap-bar-row" style={{ marginTop: 8 }}>
            <span className="trap-bar-label">Retail Call Long</span>
            <div className="trap-bar-track">
              <div className="trap-bar-fill trap-bar-client"
                style={{ width: `${Math.min(Math.max(retailTrap.clientCallPct, 0), 100)}%` }} />
            </div>
            <span className="trap-bar-pct">{retailTrap.clientCallPct.toFixed(0)}%</span>
          </div>
          <div className="trap-bar-row">
            <span className="trap-bar-label">Smart Call Short</span>
            <div className="trap-bar-track">
              <div className="trap-bar-fill trap-bar-smart"
                style={{ width: `${Math.min(Math.max(retailTrap.fiiProCallShortPct, 0), 100)}%` }} />
            </div>
            <span className="trap-bar-pct">{retailTrap.fiiProCallShortPct.toFixed(0)}%</span>
          </div>
          {/* Put trap bars */}
          <div className="trap-bar-row" style={{ marginTop: 6 }}>
            <span className="trap-bar-label">Retail Put Long</span>
            <div className="trap-bar-track">
              <div className="trap-bar-fill trap-bar-client"
                style={{ width: `${Math.min(Math.max(retailTrap.clientPutPct, 0), 100)}%` }} />
            </div>
            <span className="trap-bar-pct">{retailTrap.clientPutPct.toFixed(0)}%</span>
          </div>
          <div className="trap-bar-row">
            <span className="trap-bar-label">Smart Put Short</span>
            <div className="trap-bar-track">
              <div className="trap-bar-fill trap-bar-smart"
                style={{ width: `${Math.min(Math.max(retailTrap.fiiProPutShortPct, 0), 100)}%` }} />
            </div>
            <span className="trap-bar-pct">{retailTrap.fiiProPutShortPct.toFixed(0)}%</span>
          </div>
        </article>
      </section>

      {/* ── Vibe Overview ────────────────────────────────────────────── */}
      <section className="vibe-overview-grid">
        <article className="summary-card vibe-summary-card">
          <h2>🐋 Smart Money Flow (Your Strike)</h2>
          <p className="metric-tip" style={{ marginBottom: 6, display: "block", fontSize: 11, lineHeight: 1.5 }}>
            Specifically watches YOUR selected strike for large player activity. <strong>LONG</strong> = net buying pressure (bullish). <strong>SHORT</strong> = net selling pressure (bearish). Confidence shows how strong this signal is.
          </p>
          <p className={`status-pill ${payload?.vibe.smartMoneyFlow.netIntent === "LONG" ? "status-matched" : payload?.vibe.smartMoneyFlow.netIntent === "SHORT" ? "status-contradicted" : "status-neutral"}`}>
            {payload?.vibe.smartMoneyFlow.netIntent ?? "NEUTRAL"}
            {" "}
            {payload ? `(${payload.vibe.smartMoneyFlow.confidence.toFixed(1)}%)` : ""}
          </p>
          <p style={{ margin: "8px 0", fontSize: "12px" }}>{payload?.vibe.smartMoneyFlow.rationale ?? "Waiting for first chain snapshots…"}</p>
          <div className="kv"><span>Top Strikes</span><strong>{payload?.vibe.smartMoneyFlow.topStrikes.join(", ") || "—"}</strong></div>
          <div className="kv"><span>Buy Pressure</span><strong>{payload ? decimal(payload.vibe.smartMoneyFlow.buyPressure, 1) : "0.0"}</strong></div>
          <div className="kv"><span>Sell Pressure</span><strong>{payload ? decimal(payload.vibe.smartMoneyFlow.sellPressure, 1) : "0.0"}</strong></div>
        </article>

        <article className="summary-card vibe-summary-card">
          <h2>📈 Trend Direction (Last 20-30 min)</h2>
          <p className="metric-tip" style={{ marginBottom: 6, display: "block", fontSize: 11, lineHeight: 1.5 }}>
            Looks at what happened in the last 20-30 minutes across all captures.
            <strong> CE Trend</strong> = call option trend. <strong>PE Trend</strong> = put option trend. "WRITING" means big players are selling options to collect premium — very strong signal.
          </p>
          <p className="mono">{payload?.vibe.trend.summary ?? "Building trend context…"}</p>
          <div className="kv"><span>Window / Samples</span><strong>{payload?.vibe.trend.windowMinutes ?? "—"}m / {payload?.vibe.trend.sampleCount ?? 0}</strong></div>
          <div className="kv"><span>CE Trend</span><strong>{payload?.vibe.trend.ce.reading ?? "Insufficient"} ({payload ? `${payload.vibe.trend.ce.confidence}%` : "0%"})</strong></div>
          <div className="kv"><span>PE Trend</span><strong>{payload?.vibe.trend.pe.reading ?? "Insufficient"} ({payload ? `${payload.vibe.trend.pe.confidence}%` : "0%"})</strong></div>
        </article>

        <article className="summary-card vibe-summary-card">
          <h2>💥 IV Squeeze Detector</h2>
          <p className="metric-tip" style={{ marginBottom: 6, display: "block", fontSize: 11, lineHeight: 1.5 }}>
            <strong>IV Squeeze</strong> = when Implied Volatility drops sharply WHILE the price moves more than 30 points. This means the move is real, not just option pricing noise. <strong>VALIDATED</strong> = confirmed breakout/breakdown.
          </p>
          <p className={`status-pill ${payload?.vibe.ivSqueeze.status === "VALIDATED" ? "status-matched" : payload?.vibe.ivSqueeze.status === "WAITING_VALIDATION" ? "status-unavailable" : "status-neutral"}`}>
            {payload?.vibe.ivSqueeze.status ?? "IDLE"}
          </p>
          <p style={{ margin: "8px 0", fontSize: "12px" }}>{payload?.vibe.ivSqueeze.message ?? "No squeeze state."}</p>
          <div className="kv"><span>Reference Spot</span><strong>{spot(payload?.vibe.ivSqueeze.referenceSpot ?? null)}</strong></div>
          <div className="kv"><span>Spot Move</span><strong>{decimal(payload?.vibe.ivSqueeze.spotMove ?? null, 1)}</strong></div>
          <div className="kv"><span>Validation Rule</span><strong>{"> 30 pts"}</strong></div>
        </article>

        <article className="summary-card vibe-summary-card">
          <h2>Capture Backbone</h2>
          <p className="mono" style={{ marginBottom: 8 }}>All active strikes: CE/PE OI, Volume, IV, LTP captured each interval.</p>
          <div className="kv"><span>Active Strikes</span><strong>{payload?.vibe.capture.activeStrikes ?? 0}</strong></div>
          <div className="kv"><span>Total Snapshots</span><strong>{payload?.vibe.capture.snapshotsCaptured ?? 0}</strong></div>
          <div className="kv">
            <span>Cadence</span>
            <strong>
              {payload?.vibe.capture.captureIntervalMs != null
                ? `${Math.round(payload.vibe.capture.captureIntervalMs / 1000)}s`
                : "n/a"}
            </strong>
          </div>
        </article>

        {/* ══ PCR Gauge ════════════════════════════════════════════════════════ */}
        <article className="summary-card vibe-summary-card">
          <h2>📐 Put-Call Ratio (PCR) Gauge</h2>
          <p className="metric-tip" style={{ marginBottom: 6, display: "block", fontSize: 11, lineHeight: 1.5 }}>
            PCR = Total Put OI ÷ Total Call OI. <strong>Above 1.15</strong> = more puts than calls = market is buying protection = usually bullish (market goes up).
            <strong> Below 0.90</strong> = more calls than puts = overconfident bulls = usually bearish (market falls).
            <strong> FII PCR</strong> = what big foreign funds are doing. <strong>Client PCR</strong> = what retail traders are doing.
          </p>
          <div className="legend-row" style={{ marginBottom: 8 }}>
            <span className="legend-pill legend-pill-bull">PCR &gt; 1.15 = Market likely going UP</span>
            <span className="legend-pill legend-pill-bear">PCR &lt; 0.90 = Market likely going DOWN</span>
            <span className="legend-pill legend-pill-neut">0.90–1.15 = Market undecided</span>
          </div>
          {/* PCR gauge */}
          <div className="pcr-gauge-wrap">
            <div className="kv" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
              <span>Weekly PCR</span>
              <strong style={{ color: weeklyPCR.pcr > 1.15 ? "var(--bull)" : weeklyPCR.pcr < 0.90 ? "var(--bear)" : "var(--text)" }}>
                {weeklyPCR.pcr.toFixed(2)}
                {" "}
                <span className={`status-pill ${weeklyPCR.interpretation.includes("BULL") ? "status-matched" : weeklyPCR.interpretation.includes("BEAR") ? "status-contradicted" : "status-neutral"}`}
                  style={{ fontSize: 9 }}>
                  {weeklyPCR.interpretation.replaceAll("_", " ")}
                </span>
              </strong>
            </div>
            {/* Visual gauge */}
            <div className="pcr-gauge-track" style={{ marginTop: 6 }}>
              <div className="pcr-gauge-needle"
                style={{
                  left: `${Math.min(Math.max(((weeklyPCR.pcr - 0.4) / (2.0 - 0.4)) * 100, 2), 98)}%`,
                }} />
            </div>
            <div className="pcr-gauge-labels">
              <span>0.4 (Bearish)</span>
              <span style={{ textAlign: "center" }}>1.0</span>
              <span>2.0 (Bullish)</span>
            </div>
          </div>
          {/* Participant PCR */}
          <div className="pcr-participant-row">
            <span className="pcr-participant-label">FII PCR</span>
            <span className="pcr-participant-val">
              {weeklyPCR.fiiPcr != null ? weeklyPCR.fiiPcr.toFixed(2) : "n/a"}
            </span>
            <span className={`pcr-participant-bias ${weeklyPCR.fiiPcr != null && weeklyPCR.fiiPcr > 1.1 ? "pcr-bias-bull" : weeklyPCR.fiiPcr != null && weeklyPCR.fiiPcr < 0.85 ? "pcr-bias-bear" : "pcr-bias-neut"}`}>
              {weeklyPCR.fiiPcr != null && weeklyPCR.fiiPcr > 1.1 ? "HEDGING" : weeklyPCR.fiiPcr != null && weeklyPCR.fiiPcr < 0.85 ? "NAKED" : "BALANCED"}
            </span>
          </div>
          <div className="pcr-participant-row">
            <span className="pcr-participant-label">Client PCR</span>
            <span className="pcr-participant-val">
              {weeklyPCR.clientPcr != null ? weeklyPCR.clientPcr.toFixed(2) : "n/a"}
            </span>
            <span className={`pcr-participant-bias ${weeklyPCR.clientPcr != null && weeklyPCR.clientPcr > 1.1 ? "pcr-bias-bull" : weeklyPCR.clientPcr != null && weeklyPCR.clientPcr < 0.85 ? "pcr-bias-bear" : "pcr-bias-neut"}`}>
              {weeklyPCR.clientPcr != null && weeklyPCR.clientPcr > 1.1 ? "PUT HEAVY" : weeklyPCR.clientPcr != null && weeklyPCR.clientPcr < 0.85 ? "CALL HEAVY" : "BALANCED"}
            </span>
          </div>
          <div className="kv">
            <span>Total CE OI</span>
            <strong>{fmtNet(weeklyPCR.totalCeOi)}</strong>
          </div>
          <div className="kv">
            <span>Total PE OI</span>
            <strong>{fmtNet(weeklyPCR.totalPeOi)}</strong>
          </div>
        </article>
      </section>

      {/* ── Vibe Alerts ──────────────────────────────────────────────── */}
      <section className="vibe-alerts-section">
        <h2>🚨 Live Alerts — What Just Happened</h2>
        <div className="explain-bar">
          <span className="explain-chip">
            <strong>ACTION</strong> = Do something now (strong signal). <strong>WATCH</strong> = Pay attention, signal forming. <strong>INFO</strong> = Background data.
            Key alerts to watch: <strong>AGGRESSIVE CALL WRITING</strong> = big players selling calls = bearish.
            <strong> EXCHANGE OF HANDS</strong> = positions changing ownership = reversal possible.
            <strong> IV SQUEEZE VALIDATED</strong> = a real directional move confirmed.
          </span>
        </div>
        <div className="events-shell">
          {(payload?.vibe.alerts ?? []).length === 0 ? (
            <p className="events-empty">No active vibe alerts in the latest sample.</p>
          ) : (
            <ul className="events-list">
              {(payload?.vibe.alerts ?? []).map((alert) => (
                <li key={alert.id} className="event-item vibe-alert-item">
                  <span className={`status-pill ${vibeSeverityClass(alert.severity)}`}>{alert.severity}</span>
                  <span className="event-signal">{alert.title}</span>
                  <span className="event-shift">
                    {alert.strike ? `${alert.strike}${alert.side ? ` ${alert.side}` : ""}` : alert.kind}
                  </span>
                  <span className="event-verdict">{alert.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── Vibe Charts ──────────────────────────────────────────────── */}
      <section className="vibe-chart-grid">
        <VibeLineChart
          title="Normalized Pulse (0–100) | ROC Premium vs ROC IV vs Halchal"
          labels={chartLabels}
          yMin={0}
          yMax={100}
          series={[
            { label: "Premium ROC", color: "#C15F3C", values: normalizedTimeline.map((p) => p.premiumNorm) },
            { label: "IV ROC",      color: "#B1ADA1", values: normalizedTimeline.map((p) => p.ivNorm) },
            { label: "Halchal",    color: "#9A6C00", values: normalizedTimeline.map((p) => p.halchalNorm) },
          ]}
        />
        <VibeLineChart
          title="ROC IV ECG Check"
          labels={ecgLabels}
          valueSuffix="%"
          series={[
            { label: "CE ROC IV", color: "#C15F3C", values: ecgTimeline.map((p) => p.ceIvRoc) },
            { label: "PE ROC IV", color: "#C0392B", values: ecgTimeline.map((p) => p.peIvRoc) },
          ]}
        />
      </section>

      {/* ── Top Active Strikes (kept in place for vibe section) ──────── */}
      <VibeActiveStrikeTable rows={payload?.vibe.topActiveStrikes ?? []} hideInactive={true} />

      {/* ── Radar ────────────────────────────────────────────────────── */}
      <section className="radar-section">
        <h2>🔍 Strike Radar — Smart Money Activity Near Current Price</h2>
        <div className="explain-bar">
          <span className="explain-chip">
            <strong>The Golden Rules of Smart Money:</strong>
            Smart money <strong>WRITES</strong> (sells) options near ATM to collect premium.
            They <strong>BUY</strong> options only Far OTM as cheap insurance.
            If you see big players WRITING near ATM Calls → they expect price to fall.
            Writing near ATM Puts → they expect price to rise.
            <strong>COI/VOL ratio</strong> here shows if it's real conviction or just noise.
            <strong>Absorption</strong> = big player absorbing all retail buying = very strong signal.
          </span>
        </div>
        <div className="legend-row">
          <span className="legend-pill legend-pill-bull">🟢 BULLISH = Smart money expects price to rise</span>
          <span className="legend-pill legend-pill-bear">🔴 BEARISH = Smart money expects price to fall</span>
          <span className="legend-pill legend-pill-accent">⚡ Absorption = Strongest signal — must act on</span>
        </div>
        <div className="events-shell">
          {(payload?.radar.activeSignals ?? []).length === 0 ? (
            <p className="events-empty">No high-conviction smart-money activity detected in ATM ±300 range.</p>
          ) : (
            <ul className="radar-list">
              {(payload?.radar.activeSignals ?? []).map((signal) => (
                <li key={signal.id} className="radar-item">
                  <span className="event-time">{signal.strike}</span>
                  <span className={`radar-bias ${signal.tone === "BULLISH" ? "radar-bullish" : "radar-bearish"}`}>
                    {signal.tone}
                  </span>
                  <span className="event-shift">{signal.side}</span>
                  <span className="event-signal">{signal.action.replaceAll("_", " ")}</span>
                  <span className="event-confidence">{signal.confidence.toFixed(0)}%</span>
                  <span className="event-verdict">
                    COI/VOL: {signal.coiVolPower?.toFixed(2) ?? "—"} | IV ROC: {signal.ivRoc?.toFixed(2) ?? "—"}
                    {signal.absorption ? " | ⚡ Shark Absorption" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── Smart Money Events ───────────────────────────────────────── */}
      <section className="events-section">
        <h2>Smart Money Events</h2>
        <p className="events-subtitle">Regime shifts detected from Smart Money Verdict transitions.</p>
        <div className="events-shell">
          {(payload?.events ?? []).length === 0 ? (
            <p className="events-empty">No regime shift events yet for this session.</p>
          ) : (
            <ul className="events-list">
              {(payload?.events ?? []).slice(0, 16).map((event) => (
                <li key={event.id} className="event-item">
                  <span className="event-time">{event.displayTime}</span>
                  <span className="event-shift">
                    {event.fromRegime} → {event.toRegime}
                  </span>
                  <span className="event-signal">{event.signalKind.replaceAll("_", " ")}</span>
                  <span className="event-confidence">{event.confidence.toFixed(0)}%</span>
                  <span className="event-verdict">{event.verdict}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── Smart Money Position Log ─────────────────────────────────── */}
      <PositionTimeline
        positions={positions}
        strike={payload?.strike ?? strike}
        loading={loading}
      />


      {/* ══ 3-Day Rolling Accumulation ═══════════════════════════════════════ */}
      <section className="rollaccum-section">
        <h2>📅 3-Day Smart Money Buildup Tracker</h2>
        <div className="explain-bar">
          <span className="explain-chip">
            <strong>What is this?</strong> Shows each participant's net position over the last 3 trading days.
            Formula: <strong>Index Future + Index Call − Index Put</strong> = true directional bias.
            <strong> Green bar</strong> = net bullish (buying more than selling).
            <strong> Red bar</strong> = net bearish (selling more than buying).
            <strong> 3D Cumulative</strong> = their total conviction over 3 days — bigger number = stronger conviction. If FII has been green for 3 days in a row, that's a very strong signal.
          </span>
        </div>
        <div className="legend-row">
          <span className="legend-pill legend-pill-bull">🟢 Green = Bullish (net long)</span>
          <span className="legend-pill legend-pill-bear">🔴 Red = Bearish (net short)</span>
          <span className="legend-pill legend-pill-accent">3D Cumulative = Total 3-day conviction strength</span>
          <span className="legend-pill legend-pill-warn">5D Net = 5-day total directional change</span>
        </div>
        <div className="rollaccum-grid">
          {rollingAccum.map(({ participant, days, cumulative }) => {
            const maxAbs = Math.max(...days.map((d) => Math.abs(d ?? 0)), 1);
            const dayLabels = ["2D Ago", "1D Ago", "Today"];
            /* 5-day net from fiveDayTrends if available */
            const trend5d = payload?.participantsSummary?.fiveDayTrends?.find((t) => t.participant === participant);
            const net5d = trend5d
              ? (trend5d.futuresChange ?? 0) + (trend5d.callChange ?? 0) - (trend5d.putChange ?? 0)
              : null;
            return (
              <div key={participant} className="rollaccum-card">
                <div className="rollaccum-name">{participant}</div>
                <div className="rollaccum-bars">
                  {days.map((v, i) => {
                    const pct = v != null ? Math.min((Math.abs(v) / maxAbs) * 100, 100) : 0;
                    const barClass = v === null ? "rollaccum-bar-neut" : v > 0 ? "rollaccum-bar-bull" : "rollaccum-bar-bear";
                    return (
                      <div key={i} className="rollaccum-bar-row">
                        <span className="rollaccum-day-label">{dayLabels[i]}</span>
                        <div className="rollaccum-bar-track">
                          <div className={`rollaccum-bar-fill ${barClass}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className={`rollaccum-val ${v == null ? "" : v > 0 ? "pos" : "neg"}`}
                          style={{ color: v == null ? "var(--muted)" : v > 0 ? "var(--bull)" : "var(--bear)" }}>
                          {v != null ? fmtNet(v) : "—"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="rollaccum-cumulative">
                  <span className="rollaccum-cum-label">3D Cumulative</span>
                  <span className={`rollaccum-cum-val ${cumulative > 0 ? "pos" : cumulative < 0 ? "neg" : "neut"}`}>
                    {fmtNet(cumulative)}
                  </span>
                </div>
                {net5d !== null ? (
                  <div className="rollaccum-5d">
                    <span className="rollaccum-5d-label">5D Net Change</span>
                    <span className="rollaccum-5d-val" style={{ color: net5d > 0 ? "var(--bull)" : net5d < 0 ? "var(--bear)" : "var(--muted)" }}>
                      {fmtNet(net5d)}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
          {rollingAccum.length === 0 && (
            <p style={{ color: "var(--muted)", fontSize: 12 }}>
              Waiting for NSE EOD participant data to compute rolling accumulation.
            </p>
          )}
        </div>
      </section>

      {/* ── Loading indicator ────────────────────────────────────────── */}
      {loading ? (
        <div className="loading-indicator">
          <span className="loading-spinner" />
          Refreshing data…
        </div>
      ) : null}

      {/* ── Claude chat assistant ────────────────────────────────────── */}
      <DashboardChat index="NIFTY" strike={payload?.strike ?? strike} />
    </main>
  );
}
