export type IndexSymbol = "NIFTY" | "BANKNIFTY";

export type SignalKind =
  | "CALL_SHORT_COVERING"
  | "PUT_WRITING"
  | "DIRECTIONAL_OPTION_BUYING"
  | "PUT_WRITING_UNWIND"
  | "NEUTRAL";

export type SignalSide = "CE" | "PE" | "BOTH";
export type MarketRegime = "EOH" | "WRITING" | "NEUTRAL";
export type MarketTone = "BULLISH" | "BEARISH" | "NEUTRAL";
export type MarketRowColor = "PURPLE" | "GREEN" | "RED" | "NONE";
export type RadarZone = "ATM_NEAR_OTM" | "FAR_OTM";
export type RadarAction = "CALL_WRITING" | "PUT_WRITING" | "CALL_BUYING" | "PUT_BUYING";

export interface LegMetrics {
  oi: number | null;
  volume: number | null;
  iv: number | null;
  ltp: number | null;
  coi: number | null;
  dayCoi: number | null;
  oiRoc: number | null;
  volumeRoc: number | null;
  ltpChg: number | null;
  ivRoc: number | null;
  premiumRoc: number | null;
  ratioRoc: number | null;
  positional: number | null;
  intraday: number | null;
  coiVol: number | null;
  halchalRatio: number | null;
  activityRatio: number | null;
  /** NT (OHLC fallback) = (Open+Close)/(High+Low) — used only when real no_of_trades is unavailable */
  nt: number | null;
  /** Real NT = number of trades from NSE/Upstox market_data — used as denominator in Nitin Bhatia COI/Vol */
  numberOfTrades: number | null;
  /** Money flow shortcut = spot × Δ(OI) — Futures MF proxy per Nitin Bhatia */
  moneyFlow: number | null;
}

export interface SignalResult {
  kind: SignalKind;
  side: SignalSide;
  confidence: number;
  score: number;
  reasons: string[];
}

export interface MarketFlags {
  exchangeOfHands: boolean;
  highConvictionWriting: boolean;
  panicCovering: boolean;
}

export interface MarketVerdict {
  regime: MarketRegime;
  tone: MarketTone;
  rowColor: MarketRowColor;
  verdict: string;
  flags: MarketFlags;
  ceAr: number | null;
  peAr: number | null;
  dominantLeg: SignalSide;
}

export interface SnapshotRow {
  id: string;
  timestampIso: string;
  displayTime: string;
  spot: number | null;
  strike: number;
  ce: LegMetrics;
  pe: LegMetrics;
  signal: SignalResult;
  market: MarketVerdict;
  source: "upstox" | "mock";
}

export interface IntradaySummary {
  dominant: SignalKind;
  dominantConfidence: number;
  distribution: Record<SignalKind, number>;
  latestNarrative: string;
  marketTone: "BULLISH" | "BEARISH" | "MIXED";
}

export interface SegmentNetSnapshot {
  indexFuture: number | null;
  indexCall: number | null;
  indexPut: number | null;
  stockFuture: number | null;
  stockCall: number | null;
  stockPut: number | null;
}

export interface ParticipantRecord {
  participant: "CLIENT" | "DII" | "FII" | "PRO";
  today: SegmentNetSnapshot;
  oneDayAgo: SegmentNetSnapshot;
  twoDayAgo: SegmentNetSnapshot;
  todayTradeFlow?: SegmentNetSnapshot;
}

export interface ParticipantsSummary {
  asOfDate: string;
  sourceUrl: string;
  rows: ParticipantRecord[];
  fiiBias: string;
  narrative: string[];
  historyDates: string[];
  fiveDayTrends: ParticipantTrendSummary[];
}

export interface ParticipantTrendSummary {
  participant: "CLIENT" | "DII" | "FII" | "PRO";
  lookbackDays: number;
  tone: MarketTone;
  confidence: number;
  futuresChange: number | null;
  callChange: number | null;
  putChange: number | null;
  callIntent: "BUYING" | "SELLING" | "MIXED";
  putIntent: "BUYING" | "SELLING" | "MIXED";
  summary: string;
}

export interface StrikeParticipantInference {
  strike: number;
  side: "CE" | "PE";
  action: "OPTION_BUYING" | "OPTION_SELLING" | "SHORT_COVERING" | "LONG_UNWIND" | "NEUTRAL";
  likelyParticipant: "FII" | "PRO" | "CLIENT" | "UNSURE";
  confidence: number;
  reason: string;
}

export interface ParticipantPlanSummary {
  participant: "FII" | "PRO" | "CLIENT";
  trend: string;
  likelyStrikes: StrikeParticipantInference[];
}

export interface EodParticipantIntel {
  asOfDate: string | null;
  activeUniverse: string;
  fiiTrend: string;
  proTrend: string;
  retailTrend: string;
  bigPlayerSummary: string;
  strikeInferences: StrikeParticipantInference[];
  participantPlans: ParticipantPlanSummary[];
  marketPlan: string;
}

export interface EodCorrelation {
  status: "MATCHED" | "CONTRADICTED" | "NEUTRAL" | "UNAVAILABLE";
  score: number;
  notes: string[];
}

export interface SmartMoneyEvent {
  id: string;
  timestampIso: string;
  displayTime: string;
  fromRegime: MarketRegime;
  toRegime: MarketRegime;
  signalKind: SignalKind;
  tone: MarketTone;
  confidence: number;
  verdict: string;
}

export interface RadarSignal {
  id: string;
  strike: number;
  side: "CE" | "PE";
  zone: RadarZone;
  action: RadarAction;
  tone: MarketTone;
  coi: number | null;
  volume: number | null;
  ivRoc: number | null;
  coiVolPower: number | null;
  absorption: boolean;
  confidence: number;
  reason: string;
}

export interface SmartMoneyRadar {
  spot: number | null;
  strikeStep: number;
  monitorRange: number;
  consideredStrikes: number;
  activeSignals: RadarSignal[];
  bullishSignals: number;
  bearishSignals: number;
  regime: MarketTone;
  summary: string;
}

export interface ChainDisplayLeg {
  oi: number | null;
  volume: number | null;
  iv: number | null;
  ltp: number | null;
  coi: number | null;   /* Change in OI vs day-open baseline */
}

export interface ChainDisplayRow {
  strike: number;
  spot: number | null;
  isSpotRow: boolean;
  ce: ChainDisplayLeg;
  pe: ChainDisplayLeg;
}

export interface ChainDisplaySnapshot {
  expiryDate: string | null;
  spot: number | null;
  rows: ChainDisplayRow[];
}

export type VibeAlertKind =
  | "PUT_BUY_DIRECTIONAL"
  | "LIQUIDITY_ABSORPTION"
  | "EXCHANGE_OF_HANDS"
  | "AGGRESSIVE_CALL_WRITING"
  | "AGGRESSIVE_PUT_WRITING"
  | "IV_SQUEEZE_WAIT"
  | "IV_SQUEEZE_VALIDATED"
  | "DII_SUPPORT_HOLDING"
  | "FLOW_CLUSTERING"
  | "TRAP_SPRING";

export type VibeAlertSeverity = "INFO" | "WATCH" | "ACTION";

export interface VibeLegView {
  oi: number | null;
  volume: number | null;
  iv: number | null;
  ltp: number | null;
  coi: number | null;
  volumeDelta: number | null;
  ltpDelta: number | null;
  halchalRatio: number | null;
  rocPremium: number | null;
  rocIv: number | null;
  rocRatio: number | null;
  normalized: {
    rocPremium: number | null;
    rocIv: number | null;
    halchalRatio: number | null;
  };
}

export interface VibeStrikeView {
  strike: number;
  totalVolumeDelta: number;
  totalOiDelta: number;
  smartActivityScore: number;
  /** Clustering coefficient 0-10: fires when volume+OI delta both exceed 1σ of session mean */
  clusteringCoeff: number | null;
  ce: VibeLegView;
  pe: VibeLegView;
}

export interface VibeSmartMoneyFlow {
  topStrikes: number[];
  buyPressure: number;
  sellPressure: number;
  netIntent: "LONG" | "SHORT" | "NEUTRAL";
  confidence: number;
  rationale: string;
}

export interface VibeTrendLeg {
  reading: string;
  confidence: number;
  oiDelta: number | null;
  volumeDelta: number | null;
  premiumRoc: number | null;
  ivRoc: number | null;
  coiVol: number | null;
}

export interface VibeContinuousTrend {
  windowMinutes: number | null;
  sampleCount: number;
  ce: VibeTrendLeg;
  pe: VibeTrendLeg;
  summary: string;
}

export interface VibeAlert {
  id: string;
  timestampIso: string;
  kind: VibeAlertKind;
  severity: VibeAlertSeverity;
  title: string;
  message: string;
  strike?: number;
  side?: "CE" | "PE";
  /** True if the same signal fired in ≥2 consecutive vibe builds — single-snapshot flashes are false */
  isPersistent: boolean;
}

export interface VibeNormalizedPoint {
  timestampIso: string;
  displayTime: string;
  premiumRoc: number | null;
  ivRoc: number | null;
  halchalRatio: number | null;
  premiumNorm: number | null;
  ivNorm: number | null;
  halchalNorm: number | null;
}

export interface VibeEcgPoint {
  timestampIso: string;
  displayTime: string;
  ceIvRoc: number | null;
  peIvRoc: number | null;
}

export interface VibeSqueezeStatus {
  active: boolean;
  status: "IDLE" | "WAITING_VALIDATION" | "VALIDATED";
  referenceSpot: number | null;
  spotMove: number | null;
  message: string;
}

export interface VibeCaptureSummary {
  activeStrikes: number;
  snapshotsCaptured: number;
  captureIntervalMs: number | null;
  latestTimestampIso: string | null;
}

export interface VibeAnalysis {
  capture: VibeCaptureSummary;
  topActiveStrikes: VibeStrikeView[];
  smartMoneyFlow: VibeSmartMoneyFlow;
  trend: VibeContinuousTrend;
  alerts: VibeAlert[];
  ivSqueeze: VibeSqueezeStatus;
  normalizedTimeline: VibeNormalizedPoint[];
  ivEcg: VibeEcgPoint[];
}

export interface EodTally {
  status: "MATCHED" | "CONTRADICTED" | "PARTIAL" | "UNAVAILABLE";
  intradayTone: MarketTone;
  eodFiiTone: MarketTone;
  intradayStats: {
    sampleCount: number;
    eventCount: number;
    bullish: number;
    bearish: number;
    neutral: number;
    writing: number;
    eoh: number;
    radarBullish: number;
    radarBearish: number;
  };
  eodSignals: string[];
  summary: string;
}

export interface BackupInfo {
  updatedAt: string;
  path: string;
  retainedDays: number;
  totalBackups: number;
  sessionKey: string;
}

export interface LiveApiResponse {
  index: IndexSymbol;
  strike: number;
  expiryDate: string | null;
  monthExpiryDate: string | null;
  underlyingSpot: number | null;
  tradeDate: string;
  pollCount: number;
  refreshCount: number;
  lastUpdatedIso: string;
  weeklyChain: ChainDisplaySnapshot;
  monthlyChain: ChainDisplaySnapshot;
  rows: SnapshotRow[];
  events: SmartMoneyEvent[];
  radar: SmartMoneyRadar;
  vibe: VibeAnalysis;
  intradaySummary: IntradaySummary;
  participantsSummary: ParticipantsSummary | null;
  participantIntel: EodParticipantIntel;
  eodCorrelation: EodCorrelation;
  eodTally: EodTally;
  backupInfo: BackupInfo | null;
  warnings: string[];
}

export interface UpstoxLegRaw {
  market_data?: {
    oi?: number;
    volume?: number;
    ltp?: number;
    /** Number of trades in the session — real NT for Nitin Bhatia COI/Vol formula */
    no_of_trades?: number;
  };
  option_greeks?: {
    iv?: number;
  };
}

export interface UpstoxChainRowRaw {
  strike_price?: number;
  underlying_spot_price?: number;
  call_options?: UpstoxLegRaw;
  put_options?: UpstoxLegRaw;
}

export interface UpstoxChainResponseRaw {
  status?: string;
  data?: UpstoxChainRowRaw[];
  message?: string;
}
