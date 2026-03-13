import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getIstDate } from "./time";
import type { BotStoreState, InstrumentHint, ParsedNewTradeSignal, TradeRecord, TradeSide } from "./types";

const DEFAULT_STATE: BotStoreState = {
  version: 1,
  trades: [],
  summarySentByChat: {}
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sortTargets(targets: number[], side: TradeSide): number[] {
  const unique = [...new Set(targets)];
  unique.sort((a, b) => (side === "BUY" ? a - b : b - a));
  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export class TradeStore {
  private loaded = false;
  private state: BotStoreState = clone(DEFAULT_STATE);

  constructor(private readonly statePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (isRecord(parsed)) {
        const trades = Array.isArray(parsed.trades) ? (parsed.trades as TradeRecord[]) : [];
        const summarySentByChat = isRecord(parsed.summarySentByChat)
          ? (parsed.summarySentByChat as Record<string, string>)
          : {};

        this.state = {
          version: 1,
          trades,
          summarySentByChat
        };
      } else {
        this.state = clone(DEFAULT_STATE);
      }
    } catch {
      this.state = clone(DEFAULT_STATE);
    }

    this.loaded = true;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.statePath);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  async createTrade(chatId: number, sourceMessageId: number, signal: ParsedNewTradeSignal): Promise<TradeRecord> {
    await this.ensureLoaded();

    const nowIso = new Date().toISOString();
    const trade: TradeRecord = {
      id: randomUUID(),
      chatId,
      sourceMessageId,
      createdAtIso: nowIso,
      tradingDate: getIstDate(),
      side: signal.side,
      symbol: signal.symbol,
      strike: signal.strike,
      optionType: signal.optionType,
      expiryDate: signal.expiryDate,
      entryLow: signal.entryLow,
      entryHigh: signal.entryHigh,
      initialSl: signal.sl,
      trailingSl: null,
      targets: sortTargets(signal.targets, signal.side),
      targetHits: [],
      status: "OPEN",
      closeReason: null,
      closedAtIso: null,
      closePrice: null,
      lastPrice: null,
      lastCheckedAtIso: null,
      updates: []
    };

    this.state.trades.push(trade);
    await this.persist();
    return clone(trade);
  }

  async saveTrade(trade: TradeRecord): Promise<void> {
    await this.ensureLoaded();
    const index = this.state.trades.findIndex((row) => row.id === trade.id);
    if (index === -1) {
      throw new Error(`Trade not found in store: ${trade.id}`);
    }

    this.state.trades[index] = clone(trade);
    await this.persist();
  }

  async listOpenTrades(): Promise<TradeRecord[]> {
    await this.ensureLoaded();
    return clone(this.state.trades.filter((trade) => trade.status === "OPEN"));
  }

  async listTradesForDate(chatId: number, tradeDate: string): Promise<TradeRecord[]> {
    await this.ensureLoaded();
    const filtered = this.state.trades.filter((trade) => trade.chatId === chatId && trade.tradingDate === tradeDate);
    return clone(filtered);
  }

  async listKnownChatIds(): Promise<number[]> {
    await this.ensureLoaded();
    const ids = new Set<number>();

    for (const trade of this.state.trades) {
      ids.add(trade.chatId);
    }

    for (const [key] of Object.entries(this.state.summarySentByChat)) {
      const parsed = Number(key);
      if (Number.isFinite(parsed)) {
        ids.add(parsed);
      }
    }

    return [...ids];
  }

  async findTradeForUpdate(chatId: number, hint: InstrumentHint | null): Promise<TradeRecord | null> {
    await this.ensureLoaded();
    const inChat = this.state.trades
      .filter((trade) => trade.chatId === chatId)
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

    const pickPreferred = (items: TradeRecord[]): TradeRecord | null => {
      const open = items.find((trade) => trade.status === "OPEN");
      return open ?? items[0] ?? null;
    };

    if (hint) {
      const instrumentMatched = inChat.filter(
        (trade) =>
          trade.symbol === hint.symbol && trade.strike === hint.strike && trade.optionType === hint.optionType
      );
      const selected = pickPreferred(instrumentMatched);
      if (selected) {
        return clone(selected);
      }
    }

    const fallback = inChat.find((trade) => trade.status === "OPEN") ?? null;
    return fallback ? clone(fallback) : null;
  }

  async wasSummarySent(chatId: number, tradeDate: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.state.summarySentByChat[String(chatId)] === tradeDate;
  }

  async markSummarySent(chatId: number, tradeDate: string): Promise<void> {
    await this.ensureLoaded();
    this.state.summarySentByChat[String(chatId)] = tradeDate;
    await this.persist();
  }
}
