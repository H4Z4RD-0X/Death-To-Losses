import { Telegraf } from "telegraf";
import { parseNewTradeSignal, parseTradeUpdate } from "./parser";
import { formatDateTimeForSummary, formatIstTime, getIstClock, isIstWeekday } from "./time";
import { TradeStore } from "./store";
import type { ParsedTargetHit, ParsedTradeUpdate, TradeRecord, TradeSide } from "./types";
import { UpstoxMarketData } from "./upstoxMarket";

interface IncomingMessage {
  chatId: number;
  messageId: number;
  text: string;
}

interface MessageLike {
  chat?: {
    id?: number;
  };
  message_id?: number;
  text?: string;
  caption?: string;
}

export interface TelegramTradeBotConfig {
  token: string;
  statePath: string;
  pollIntervalMs: number;
  summaryHour: number;
  summaryMinute: number;
  allowedChatIds: Set<number> | null;
  summaryChatIds: number[];
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
}

function formatEntryRange(low: number | null, high: number | null): string {
  if (low === null && high === null) {
    return "-";
  }

  if (low !== null && high !== null) {
    if (Math.abs(low - high) < 0.0001) {
      return formatPrice(low);
    }
    return `${formatPrice(low)}-${formatPrice(high)}`;
  }

  return formatPrice(low ?? high);
}

function inferEntryReference(trade: TradeRecord): number | null {
  if (trade.entryLow !== null && trade.entryHigh !== null) {
    return (trade.entryLow + trade.entryHigh) / 2;
  }
  return trade.entryLow ?? trade.entryHigh;
}

function getPointMove(trade: TradeRecord): number | null {
  const entry = inferEntryReference(trade);
  const exit = trade.closePrice ?? trade.lastPrice;
  if (entry === null || exit === null) {
    return null;
  }

  return trade.side === "BUY" ? exit - entry : entry - exit;
}

function sortTargets(targets: number[], side: TradeSide): number[] {
  const unique = [...new Set(targets)];
  unique.sort((a, b) => (side === "BUY" ? a - b : b - a));
  return unique;
}

function tradeLabel(trade: TradeRecord): string {
  return `${trade.symbol} ${formatPrice(trade.strike)} ${trade.optionType}`;
}

export class TelegramTradeBot {
  private readonly bot: Telegraf;
  private readonly store: TradeStore;
  private readonly marketData: UpstoxMarketData;
  private pollInProgress = false;
  private summaryInProgress = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: TelegramTradeBotConfig) {
    this.bot = new Telegraf(config.token);
    this.store = new TradeStore(config.statePath);
    this.marketData = new UpstoxMarketData();
  }

  async start(): Promise<void> {
    this.bot.on("channel_post", async (ctx) => {
      await this.handleRawUpdate(ctx.update);
    });

    this.bot.on("message", async (ctx) => {
      await this.handleRawUpdate(ctx.update);
    });

    this.bot.catch((error) => {
      console.error("Telegram error:", error);
    });

    await this.bot.launch();
    console.log("Telegram trade bot started.");

    await this.pollOpenTrades();
    await this.checkDailySummary();

    this.pollTimer = setInterval(() => void this.pollOpenTrades(), this.config.pollIntervalMs);
    this.summaryTimer = setInterval(() => void this.checkDailySummary(), 30_000);

    process.once("SIGINT", () => void this.stop("SIGINT"));
    process.once("SIGTERM", () => void this.stop("SIGTERM"));
  }

  private async stop(signal: string): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }

    this.bot.stop(signal);
  }

  private toMessageLike(value: unknown): MessageLike | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    return value as MessageLike;
  }

  private extractIncoming(update: unknown): IncomingMessage | null {
    if (!update || typeof update !== "object") {
      return null;
    }

    const updateRecord = update as { channel_post?: unknown; message?: unknown };
    const message = this.toMessageLike(updateRecord.channel_post) ?? this.toMessageLike(updateRecord.message);
    if (!message) {
      return null;
    }

    const chatId = message.chat?.id;
    const messageId = message.message_id;
    const text = message.text ?? message.caption;

    if (!Number.isFinite(chatId) || !Number.isFinite(messageId) || typeof text !== "string" || text.trim().length === 0) {
      return null;
    }

    return {
      chatId: Number(chatId),
      messageId: Number(messageId),
      text: text.trim()
    };
  }

  private isAllowedChat(chatId: number): boolean {
    if (!this.config.allowedChatIds) {
      return true;
    }
    return this.config.allowedChatIds.has(chatId);
  }

  private async handleRawUpdate(update: unknown): Promise<void> {
    const incoming = this.extractIncoming(update);
    if (!incoming || !this.isAllowedChat(incoming.chatId)) {
      return;
    }

    const newTrade = parseNewTradeSignal(incoming.text);
    if (newTrade) {
      const trade = await this.store.createTrade(incoming.chatId, incoming.messageId, newTrade);
      const acknowledgement = [
        `Trade tracked: ${trade.side} ${tradeLabel(trade)}`,
        `Entry: ${formatEntryRange(trade.entryLow, trade.entryHigh)}`,
        `SL: ${formatPrice(trade.initialSl)} | Targets: ${
          trade.targets.length > 0 ? trade.targets.map((target) => formatPrice(target)).join(", ") : "-"
        }`,
        `Expiry: ${trade.expiryDate ?? "Auto-resolve"}`
      ].join("\n");

      await this.sendMessage(incoming.chatId, acknowledgement);
      return;
    }

    const parsedUpdate = parseTradeUpdate(incoming.text);
    if (!parsedUpdate) {
      return;
    }

    const trade = await this.store.findTradeForUpdate(incoming.chatId, parsedUpdate.instrumentHint);
    if (!trade) {
      await this.sendMessage(incoming.chatId, "Update received but no matching tracked trade was found.");
      return;
    }

    const updateNotes = this.applyManualUpdate(trade, parsedUpdate, incoming.messageId);
    await this.store.saveTrade(trade);

    if (updateNotes.length > 0) {
      await this.sendMessage(
        incoming.chatId,
        [`Manual update applied for ${tradeLabel(trade)}:`, ...updateNotes].join("\n")
      );
    }
  }

  private isTargetAlreadyHit(trade: TradeRecord, targetIndex: number): boolean {
    return trade.targetHits.some((targetHit) => targetHit.targetIndex === targetIndex);
  }

  private hasTargetLevelHit(side: TradeSide, currentPrice: number, targetPrice: number): boolean {
    return side === "BUY" ? currentPrice >= targetPrice : currentPrice <= targetPrice;
  }

  private hasStopHit(side: TradeSide, currentPrice: number, stopPrice: number): boolean {
    return side === "BUY" ? currentPrice <= stopPrice : currentPrice >= stopPrice;
  }

  private hasAllTargetsHit(trade: TradeRecord): boolean {
    if (trade.targets.length === 0) {
      return false;
    }
    return trade.targets.every((_, index) => this.isTargetAlreadyHit(trade, index));
  }

  private recordTargetHit(
    trade: TradeRecord,
    targetIndex: number,
    hitPrice: number | null,
    source: "auto" | "manual",
    hitAtIso: string
  ): void {
    if (this.isTargetAlreadyHit(trade, targetIndex)) {
      return;
    }

    trade.targetHits.push({
      targetIndex,
      targetPrice: trade.targets[targetIndex],
      hitPrice,
      source,
      hitAtIso
    });

    trade.targetHits.sort((a, b) => a.targetIndex - b.targetIndex);
  }

  private closeTrade(
    trade: TradeRecord,
    reason: "SL" | "TSL" | "TARGET" | "MANUAL",
    closePrice: number | null,
    closedAtIso: string
  ): void {
    if (trade.status !== "OPEN") {
      return;
    }

    if (reason === "SL") {
      trade.status = "CLOSED_SL";
      trade.closeReason = "SL_HIT";
    } else if (reason === "TSL") {
      trade.status = "CLOSED_TSL";
      trade.closeReason = "TRAILING_SL_HIT";
    } else if (reason === "TARGET") {
      trade.status = "CLOSED_TARGET";
      trade.closeReason = "FINAL_TARGET_HIT";
    } else {
      trade.status = "CLOSED_MANUAL";
      trade.closeReason = "MANUAL_EXIT";
    }

    trade.closedAtIso = closedAtIso;
    trade.closePrice = closePrice ?? trade.lastPrice;
  }

  private resolveManualTargetIndex(trade: TradeRecord, targetHit: ParsedTargetHit): number | null {
    const explicit = targetHit.targetIndex !== null ? Math.round(targetHit.targetIndex) - 1 : null;
    if (explicit !== null && explicit >= 0 && explicit < trade.targets.length) {
      return explicit;
    }

    const tolerance = 0.4;

    const hitPrice = targetHit.price;
    if (hitPrice !== null) {
      const byPrice = trade.targets.findIndex(
        (targetPrice, index) => !this.isTargetAlreadyHit(trade, index) && Math.abs(targetPrice - hitPrice) <= tolerance
      );
      if (byPrice >= 0) {
        return byPrice;
      }

      if (trade.side === "BUY") {
        const buyCandidate = trade.targets.findIndex(
          (targetPrice, index) => !this.isTargetAlreadyHit(trade, index) && targetPrice <= hitPrice + tolerance
        );
        if (buyCandidate >= 0) {
          return buyCandidate;
        }
      } else {
        const sellCandidate = trade.targets.findIndex(
          (targetPrice, index) => !this.isTargetAlreadyHit(trade, index) && targetPrice >= hitPrice - tolerance
        );
        if (sellCandidate >= 0) {
          return sellCandidate;
        }
      }
    }

    return trade.targets.findIndex((_, index) => !this.isTargetAlreadyHit(trade, index));
  }

  private applyManualUpdate(trade: TradeRecord, parsedUpdate: ParsedTradeUpdate, sourceMessageId: number): string[] {
    const nowIso = new Date().toISOString();
    const notes: string[] = [];

    if (parsedUpdate.newTsl !== null) {
      trade.trailingSl = parsedUpdate.newTsl;
      notes.push(`TSL moved to ${formatPrice(parsedUpdate.newTsl)}.`);
    }

    const holdFor = parsedUpdate.holdFor;
    if (holdFor !== null) {
      const exists = trade.targets.some((targetPrice) => Math.abs(targetPrice - holdFor) < 0.0001);
      if (!exists) {
        trade.targets = sortTargets([...trade.targets, holdFor], trade.side);
        notes.push(`New hold target added: ${formatPrice(holdFor)}.`);
      }
    }

    for (const targetHit of parsedUpdate.targetHits) {
      const targetIndex = this.resolveManualTargetIndex(trade, targetHit);
      if (targetIndex === null || targetIndex < 0) {
        continue;
      }
      if (this.isTargetAlreadyHit(trade, targetIndex)) {
        continue;
      }

      const markedPrice = targetHit.price ?? trade.targets[targetIndex];
      this.recordTargetHit(trade, targetIndex, markedPrice, "manual", nowIso);
      notes.push(`Target ${targetIndex + 1} marked hit at ${formatPrice(markedPrice)}.`);
    }

    if (trade.status === "OPEN" && parsedUpdate.closeSignal) {
      const reason = parsedUpdate.closeSignal === "SL" ? "SL" : parsedUpdate.closeSignal === "TSL" ? "TSL" : "MANUAL";
      this.closeTrade(trade, reason, trade.lastPrice, nowIso);
      notes.push(`Trade closed (${trade.closeReason ?? "MANUAL_EXIT"}).`);
    }

    if (trade.status === "OPEN" && this.hasAllTargetsHit(trade)) {
      this.closeTrade(trade, "TARGET", trade.lastPrice, nowIso);
      notes.push("All targets complete. Trade closed.");
    }

    trade.updates.push({
      updatedAtIso: nowIso,
      sourceMessageId,
      rawText: parsedUpdate.rawText,
      targetHits: parsedUpdate.targetHits,
      newTsl: parsedUpdate.newTsl,
      holdFor: parsedUpdate.holdFor,
      closeSignal: parsedUpdate.closeSignal
    });

    return notes;
  }

  private async pollOpenTrades(): Promise<void> {
    if (this.pollInProgress) {
      return;
    }

    this.pollInProgress = true;
    try {
      const openTrades = await this.store.listOpenTrades();
      for (const trade of openTrades) {
        await this.evaluateOpenTrade(trade);
      }
    } finally {
      this.pollInProgress = false;
    }
  }

  private async evaluateOpenTrade(trade: TradeRecord): Promise<void> {
    try {
      const quote = await this.marketData.getOptionLtp({
        symbol: trade.symbol,
        strike: trade.strike,
        optionType: trade.optionType,
        expiryDate: trade.expiryDate
      });

      const nowIso = new Date().toISOString();
      const previousPrice = trade.lastPrice;
      const previousExpiry = trade.expiryDate;
      const previousCheckedAt = trade.lastCheckedAtIso;

      trade.lastPrice = quote.ltp;
      trade.lastCheckedAtIso = nowIso;
      if (trade.expiryDate !== quote.expiryDate) {
        trade.expiryDate = quote.expiryDate;
      }

      const stopPrice = trade.trailingSl ?? trade.initialSl;
      if (stopPrice !== null && this.hasStopHit(trade.side, quote.ltp, stopPrice)) {
        const stopType = trade.trailingSl !== null ? "TSL" : "SL";
        this.closeTrade(trade, stopType, quote.ltp, nowIso);
        await this.store.saveTrade(trade);
        await this.sendMessage(
          trade.chatId,
          `${tradeLabel(trade)} ${stopType} HIT at ${formatPrice(quote.ltp)} (${formatIstTime(nowIso)} IST).`
        );
        return;
      }

      const hitMessages: string[] = [];
      for (let index = 0; index < trade.targets.length; index += 1) {
        if (this.isTargetAlreadyHit(trade, index)) {
          continue;
        }

        const targetPrice = trade.targets[index];
        if (!this.hasTargetLevelHit(trade.side, quote.ltp, targetPrice)) {
          continue;
        }

        this.recordTargetHit(trade, index, quote.ltp, "auto", nowIso);
        hitMessages.push(
          `${tradeLabel(trade)} TARGET ${index + 1} HIT at ${formatPrice(quote.ltp)} (target ${formatPrice(
            targetPrice
          )})`
        );
      }

      if (trade.status === "OPEN" && this.hasAllTargetsHit(trade)) {
        this.closeTrade(trade, "TARGET", quote.ltp, nowIso);
        hitMessages.push(`${tradeLabel(trade)} all listed targets completed. Trade closed at ${formatPrice(quote.ltp)}.`);
      }

      const changed =
        previousPrice !== trade.lastPrice ||
        previousExpiry !== trade.expiryDate ||
        previousCheckedAt !== trade.lastCheckedAtIso ||
        hitMessages.length > 0 ||
        trade.status !== "OPEN";

      if (changed) {
        await this.store.saveTrade(trade);
      }

      for (const message of hitMessages) {
        await this.sendMessage(trade.chatId, `${message} (${formatIstTime(nowIso)} IST).`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown market-data error";
      console.error(`Trade poll failed for ${tradeLabel(trade)}: ${message}`);
    }
  }

  private statusForSummary(trade: TradeRecord): string {
    if (trade.status === "OPEN") {
      return `OPEN @ ${formatPrice(trade.lastPrice)}`;
    }
    const closeValue = formatPrice(trade.closePrice ?? trade.lastPrice);
    return `${trade.status.replace("CLOSED_", "")} @ ${closeValue}`;
  }

  private buildDailySummary(tradeDate: string, trades: TradeRecord[]): string {
    const counts = {
      open: trades.filter((trade) => trade.status === "OPEN").length,
      target: trades.filter((trade) => trade.status === "CLOSED_TARGET").length,
      sl: trades.filter((trade) => trade.status === "CLOSED_SL").length,
      tsl: trades.filter((trade) => trade.status === "CLOSED_TSL").length,
      manual: trades.filter((trade) => trade.status === "CLOSED_MANUAL").length
    };

    const ordered = [...trades].sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
    const lines: string[] = [
      `Daily Trade Summary (${tradeDate}, IST)`,
      `Total: ${trades.length} | Open: ${counts.open} | Target: ${counts.target} | SL: ${counts.sl} | TSL: ${counts.tsl} | Manual: ${counts.manual}`,
      ""
    ];

    const maxLength = 3900;
    for (let index = 0; index < ordered.length; index += 1) {
      const trade = ordered[index];
      const hits =
        trade.targetHits.length > 0 ? trade.targetHits.map((hit) => `T${hit.targetIndex + 1}`).join(",") : "-";
      const pointMove = getPointMove(trade);
      const pointText = pointMove === null ? "" : ` | Pts ${pointMove >= 0 ? "+" : ""}${formatPrice(pointMove)}`;
      const line = `${index + 1}. ${trade.side} ${tradeLabel(trade)} | ${this.statusForSummary(
        trade
      )} | Hits ${hits}${pointText}`;

      if (lines.join("\n").length + line.length + 1 > maxLength) {
        lines.push(`...and ${ordered.length - index} more trades.`);
        break;
      }

      lines.push(line);
    }

    return lines.join("\n");
  }

  private async checkDailySummary(): Promise<void> {
    if (this.summaryInProgress) {
      return;
    }

    this.summaryInProgress = true;
    try {
      const clock = getIstClock();
      if (!isIstWeekday(clock.weekday)) {
        return;
      }

      if (clock.hour !== this.config.summaryHour || clock.minute !== this.config.summaryMinute) {
        return;
      }

      const knownChatIds = await this.store.listKnownChatIds();
      const summaryChatIds = new Set<number>([...this.config.summaryChatIds, ...knownChatIds]);

      for (const chatId of summaryChatIds) {
        if (!this.isAllowedChat(chatId) && !this.config.summaryChatIds.includes(chatId)) {
          continue;
        }

        const alreadySent = await this.store.wasSummarySent(chatId, clock.date);
        if (alreadySent) {
          continue;
        }

        const trades = await this.store.listTradesForDate(chatId, clock.date);
        if (trades.length === 0) {
          await this.sendMessage(chatId, `Daily Trade Summary (${clock.date}, IST)\nNo tracked trades for today.`);
        } else {
          const summary = this.buildDailySummary(clock.date, trades);
          await this.sendMessage(chatId, summary);
        }

        await this.store.markSummarySent(chatId, clock.date);
      }
    } finally {
      this.summaryInProgress = false;
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Telegram API error";
      console.error(`Failed to send message to ${chatId}: ${message}`);
    }
  }

  async sendStartupMessage(): Promise<void> {
    const startedAt = formatDateTimeForSummary(new Date().toISOString());
    const text = `Trade bot is online (${startedAt} IST). Poll interval: ${this.config.pollIntervalMs / 1000}s.`;

    for (const chatId of this.config.summaryChatIds) {
      if (!this.isAllowedChat(chatId)) {
        continue;
      }
      await this.sendMessage(chatId, text);
    }
  }
}
