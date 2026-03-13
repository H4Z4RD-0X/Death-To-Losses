export type OptionType = "CE" | "PE";
export type TradeSide = "BUY" | "SELL";

export type TradeStatus = "OPEN" | "CLOSED_TARGET" | "CLOSED_SL" | "CLOSED_TSL" | "CLOSED_MANUAL";

export interface InstrumentHint {
  symbol: string;
  strike: number;
  optionType: OptionType;
}

export interface ParsedNewTradeSignal extends InstrumentHint {
  side: TradeSide;
  entryLow: number | null;
  entryHigh: number | null;
  sl: number | null;
  targets: number[];
  expiryDate: string | null;
  rawText: string;
}

export interface ParsedTargetHit {
  targetIndex: number | null;
  price: number | null;
}

export interface ParsedTradeUpdate {
  instrumentHint: InstrumentHint | null;
  targetHits: ParsedTargetHit[];
  newTsl: number | null;
  holdFor: number | null;
  closeSignal: "SL" | "TSL" | "MANUAL" | null;
  rawText: string;
}

export interface TradeTargetHit {
  targetIndex: number;
  targetPrice: number;
  hitPrice: number | null;
  source: "auto" | "manual";
  hitAtIso: string;
}

export interface TradeUpdateRecord {
  updatedAtIso: string;
  sourceMessageId: number;
  rawText: string;
  targetHits: ParsedTargetHit[];
  newTsl: number | null;
  holdFor: number | null;
  closeSignal: "SL" | "TSL" | "MANUAL" | null;
}

export interface TradeRecord extends InstrumentHint {
  id: string;
  chatId: number;
  sourceMessageId: number;
  createdAtIso: string;
  tradingDate: string;
  side: TradeSide;
  expiryDate: string | null;
  entryLow: number | null;
  entryHigh: number | null;
  initialSl: number | null;
  trailingSl: number | null;
  targets: number[];
  targetHits: TradeTargetHit[];
  status: TradeStatus;
  closeReason: string | null;
  closedAtIso: string | null;
  closePrice: number | null;
  lastPrice: number | null;
  lastCheckedAtIso: string | null;
  updates: TradeUpdateRecord[];
}

export interface BotStoreState {
  version: 1;
  trades: TradeRecord[];
  summarySentByChat: Record<string, string>;
}
